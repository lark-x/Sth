import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import { requireProject } from '../library/storage.ts';
import { assertSourceRange, sourceMatches } from './ranges.ts';
import { assertSourceText, readSource, writeSourceRevision } from './storage.ts';
import { maxSourceChars, readPageChars, type ExternalDocument, type ExternalJob, type ExternalJobError,
  type ExternalReadResult, type ExternalSearchResult } from './external-contracts.ts';

export const externalDDL = `
CREATE TABLE IF NOT EXISTS external_research_jobs (
  job_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('search', 'read')),
  query TEXT,
  doc_id TEXT,
  search_limit INTEGER,
  cursor TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  result_json TEXT,
  error_json TEXT,
  CHECK ((kind = 'search' AND query IS NOT NULL AND search_limit IS NOT NULL AND doc_id IS NULL)
    OR (kind = 'read' AND doc_id IS NOT NULL AND query IS NULL AND search_limit IS NULL)),
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'succeeded') = (result_json IS NOT NULL)),
  CHECK ((status = 'failed') = (error_json IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS external_research_queue ON external_research_jobs(status, created_at, job_id);
CREATE INDEX IF NOT EXISTS external_research_history ON external_research_jobs(created_at DESC, job_id DESC);

CREATE TABLE IF NOT EXISTS external_source_archives (
  provider TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  selection TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  attribution_json TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  PRIMARY KEY (provider, doc_id, selection, snapshot_hash),
  FOREIGN KEY (source_id, source_revision) REFERENCES source_revisions(source_id, revision)
) STRICT, WITHOUT ROWID;
`;

export type JobRequest = { provider: string; cursor?: string } & (
  { kind: 'search'; query: string; limit: number } | { kind: 'read'; docId: string });
export type JobStatus = ExternalJob['status'];
export type JobRow = {
  job_id: string; provider: string; kind: ExternalJob['kind']; query: string | null; doc_id: string | null;
  search_limit: number | null; cursor: string | null; status: JobStatus; attempts: number;
  created_at: string; updated_at: string; lease_token: string | null; error_json: string | null; result_json: string | null;
};

const summaryFields = 'job_id, provider, kind, query, doc_id, cursor, status, attempts, created_at, updated_at, error_json';

export function summarizeJob(row: JobRow): Omit<ExternalJob, 'result'> {
  return {
    jobId: row.job_id, provider: row.provider, kind: row.kind, status: row.status, attempts: row.attempts,
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.query === null ? {} : { query: row.query }), ...(row.doc_id === null ? {} : { docId: row.doc_id }),
    ...(row.cursor === null ? {} : { cursor: row.cursor }),
    ...(row.error_json === null ? {} : { error: JSON.parse(row.error_json) as ExternalJobError }),
  };
}

export function requireJob(db: DatabaseSync, jobId: string, includeResult = false): JobRow {
  assertSourceText(jobId);
  const row = db.prepare(`SELECT ${summaryFields}${includeResult ? ', result_json' : ''}
    FROM external_research_jobs WHERE job_id = ?`).get(jobId) as JobRow | undefined;
  if (!row) throw new OperationError(404, 'external_job_not_found', 'The research job was not found.');
  return row;
}

export function listJobs(db: DatabaseSync, limit: number, offset: number) {
  return db.prepare(`SELECT ${summaryFields} FROM external_research_jobs ORDER BY created_at DESC, job_id DESC LIMIT ? OFFSET ?`)
    .all(limit, offset).map(row => summarizeJob(row as JobRow));
}

export function enqueueJob(db: DatabaseSync, request: JobRequest) {
  const jobId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO external_research_jobs
    (job_id, provider, kind, query, doc_id, search_limit, cursor, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(jobId, request.provider, request.kind,
    request.kind === 'search' ? request.query : null, request.kind === 'read' ? request.docId : null,
    request.kind === 'search' ? request.limit : null, request.cursor ?? null, now, now);
  return summarizeJob(requireJob(db, jobId));
}

export function retryJob(db: DatabaseSync, jobId: string) {
  const job = summarizeJob(requireJob(db, jobId));
  if (job.status === 'queued' || job.status === 'running') return job;
  if (job.status !== 'failed' || !job.error?.retryable) {
    throw new OperationError(409, 'external_job_not_retryable', 'This research job cannot be retried.');
  }
  db.prepare(`UPDATE external_research_jobs SET status = 'queued', updated_at = ?, error_json = NULL WHERE job_id = ?`)
    .run(new Date().toISOString(), jobId);
  return summarizeJob(requireJob(db, jobId));
}

function pickDocument(read: ExternalReadResult, docId: string) {
  const document = read.documents.find(item => item.docId === docId);
  if (!document) throw new OperationError(404, 'external_document_not_in_job', 'This document is not in the stored read result.');
  return document;
}

function documentPage(document: ExternalDocument, offset: number) {
  const totalChars = document.body.length;
  if (offset > totalChars || /^[\uDC00-\uDFFF]/.test(document.body.charAt(offset))) {
    throw new OperationError(400, 'external_invalid_offset', 'Provide a document offset on a character boundary.');
  }
  let end = Math.min(totalChars, offset + readPageChars);
  if (/^[\uDC00-\uDFFF]/.test(document.body.charAt(end))) end--;
  return { ...document, body: document.body.slice(offset, end), offset, totalChars,
    ...(end < totalChars ? { nextOffset: end } : {}) };
}

export function getJob(db: DatabaseSync, jobId: string, documentId?: string, offset = 0): ExternalJob {
  const row = requireJob(db, jobId, true);
  const summary = summarizeJob(row);
  if (documentId !== undefined && (row.kind !== 'read' || row.status !== 'succeeded')) {
    throw new OperationError(409, 'external_read_required', 'A completed read job is required to open a document.');
  }
  if (row.result_json === null) return summary;
  if (row.kind === 'search') return { ...summary, result: JSON.parse(row.result_json) as ExternalSearchResult };
  const read = JSON.parse(row.result_json) as ExternalReadResult;
  const documents = documentId === undefined ? read.documents : [pickDocument(read, documentId)];
  return { ...summary, result: { ...read, documents: documents.map(document => documentPage(document, offset)) } };
}

export interface ArchiveSelection { excerpt?: string; start?: number; end?: number }

function selectText(body: string, { excerpt, start, end }: ArchiveSelection) {
  if (start === undefined && end === undefined && excerpt === undefined) return { body, selection: 'whole' };
  if (start === undefined && end === undefined && excerpt !== undefined) {
    const matches = sourceMatches(body, excerpt, 2, 0);
    if (matches.length === 0) throw new OperationError(400, 'external_excerpt_mismatch', 'The excerpt does not appear in the stored original.');
    if (matches.length > 1) {
      throw new OperationError(400, 'external_excerpt_ambiguous', 'The excerpt appears more than once. Provide start and end offsets.');
    }
    ({ start, end } = matches[0]);
  }
  if (start === undefined || end === undefined) {
    throw new OperationError(400, 'external_invalid_selection', 'Provide a valid start and end in the stored original.');
  }
  assertSourceRange(body, { start, end });
  const selected = body.slice(start, end);
  if (!selected.trim() || (excerpt !== undefined && selected !== excerpt)) {
    throw new OperationError(400, 'external_excerpt_mismatch', 'The selection must match nonblank original text.');
  }
  const selection = start === 0 && end === body.length ? 'whole' : `${start}:${end}`;
  return { body: selected, selection, start, end };
}

export function archiveDocument(db: DatabaseSync, document: ExternalDocument, projectIds: string[], range: ArchiveSelection = {}) {
  const { body, selection, start, end } = selectText(document.body, range);
  if (body.length > maxSourceChars) {
    throw new OperationError(400, 'external_archive_too_large', 'Select an excerpt of up to 100,000 characters to archive this original.');
  }
  for (const projectId of projectIds) requireProject(db, projectId);
  const { provider, docId, title, origin, url, upstreamRevision, license } = document;
  const attribution = { title, origin, url, upstreamRevision, license };
  const snapshotHash = createHash('sha256').update(JSON.stringify([attribution, body])).digest('hex');
  const find = db.prepare(`SELECT source_id, source_revision FROM external_source_archives
    WHERE provider = ? AND doc_id = ? AND selection = ? AND snapshot_hash = ?`);
  const saved = find.get(provider, docId, selection, snapshotHash) as { source_id: string; source_revision: number } | undefined;
  const existing = saved ?? db.prepare(`SELECT source_id FROM external_source_archives
    WHERE provider = ? AND doc_id = ? AND selection = ? LIMIT 1`).get(provider, docId, selection) as { source_id: string } | undefined;
  const current = existing && readSource(db, existing.source_id);
  const archived = saved && readSource(db, saved.source_id, saved.source_revision);
  const attached = [...new Set([...(current?.projectIds ?? []), ...(archived?.projectIds ?? []), ...projectIds])].toSorted();
  const result = (source: ReturnType<typeof readSource>) => ({ provider, docId, sourceId: source.sourceId, revision: source.revision,
    title: source.title, href: source.href, projectIds: source.projectIds, ...(start === undefined ? {} : { start, end }) });
  if (archived && projectIds.every(projectId => archived.projectIds.includes(projectId))) return result(archived);
  if (attached.length > 50) throw new OperationError(400, 'external_too_many_projects', 'A source can be attached to up to 50 projects.');
  // Attach an already archived snapshot to more projects without changing its original revision.
  const sourceId = current?.sourceId ?? randomUUID();
  const revision = (current?.revision ?? 0) + 1;
  if (!current) db.prepare('INSERT INTO sources (source_id) VALUES (?)').run(sourceId);
  writeSourceRevision(db, sourceId, revision, { kind: 'excerpt', title, body, origin, projectIds: attached });
  db.prepare(`INSERT INTO external_source_archives (provider, doc_id, selection, snapshot_hash, attribution_json, source_id, source_revision)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider, doc_id, selection, snapshot_hash) DO UPDATE SET source_revision = excluded.source_revision`)
    .run(provider, docId, selection, snapshotHash, JSON.stringify(attribution), sourceId, revision);
  return result(readSource(db, sourceId, revision));
}

export function archiveRead(db: DatabaseSync, jobId: string, docId: string, projectIds: string[], range: ArchiveSelection) {
  const row = requireJob(db, jobId, true);
  if (row.kind !== 'read' || row.status !== 'succeeded' || row.result_json === null) {
    throw new OperationError(409, 'external_read_required', 'Complete the read job before archiving original text.');
  }
  return archiveDocument(db, pickDocument(JSON.parse(row.result_json) as ExternalReadResult, docId), projectIds, range);
}
