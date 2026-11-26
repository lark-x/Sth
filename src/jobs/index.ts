import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Type, type Static } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { requireProject } from '../library/storage.ts';
import { readScene } from '../story/storage.ts';
import { maxBatchItems } from './storage.ts';

export { jobsDDL, readMediaBinary } from './storage.ts';
export { createMediaProviderFromEnv, createComfyProvider, getMediaProviderStatus, type MediaProvider, type MediaProviderStatus } from './provider.ts';
export { startJobsWorker } from './worker.ts';

const strict = { additionalProperties: false };
const id = Type.String({ maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const title = Type.String({ maxLength: 300, pattern: '\\S' });
const prompt = Type.String({ maxLength: 8_000, pattern: '\\S' });
const date = Type.String();
const href = Type.String();
const resultLink = { hrefField: 'href', labelField: 'title' };
const pagination = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  offset: Type.Optional(count),
};

const scenePin = Type.Object({ sceneId: id, revision, title, href }, strict);
const candidateInput = { title, prompt };
const candidate = Type.Object({ candidateId: id, ...candidateInput }, strict);
const candidatePin = { compositionId: id, candidateId: id };
const candidateRef = Type.Object(candidatePin, strict);
const compositionFields = {
  compositionId: id, projectId: id, scene: scenePin, selectedCandidateId: Type.Optional(id),
  selectionRevision: count, createdAt: date,
};
const compositionSummary = Type.Object(compositionFields, strict);
const composition = Type.Object({ ...compositionFields, candidates: Type.Array(candidate, { maxItems: 8 }) }, strict);

const mode = Type.Union([Type.Literal('manual'), Type.Literal('autonomous')]);
const maxImages = Type.Integer({ minimum: 1, maximum: maxBatchItems });
const progress = Type.Object({ queued: count, submitting: count, submitted: count, unknown: count,
  failed: count, succeeded: count, canceled: count }, strict);
const itemStatus = Type.KeyOf(progress);
const providerParameters = Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]));
const attempt = Type.Object({ number: revision, requestId: id, provider: Type.String(), providerJobId: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()), parameters: providerParameters, startedAt: date, updatedAt: date }, strict);
const mediaFields = {
  mediaId: id, title, href, contentHref: href, jobId: id, itemId: id, projectId: id, scene: scenePin, ...candidatePin,
  contentType: Type.Literal('image/png'), byteLength: revision, sha256: Type.String(), width: revision, height: revision,
  createdAt: date,
};
const mediaSummary = Type.Object(mediaFields, strict);
const media = Type.Object({ ...mediaFields, attempt }, strict);
const jobItem = Type.Object({
  itemId: id, position: revision, ...candidatePin, title, scene: scenePin, status: itemStatus,
  attempt: Type.Optional(attempt), mediaId: Type.Optional(id), mediaHref: Type.Optional(href),
  reconciliationQueued: Type.Boolean(),
}, strict);
const jobFields = {
  jobId: id, projectId: id, title, href, mode, maxImages: Type.Optional(maxImages),
  attemptsStarted: count, createdAt: date, progress,
};
const jobSummary = Type.Object(jobFields, strict);
const job = Type.Object({ ...jobFields, items: Type.Array(jobItem, { maxItems: maxBatchItems }) }, strict);

type SceneRow = { scene_id: string; scene_revision: number; scene_title: string; scene_href: string };
type CompositionRow = SceneRow & { composition_id: string; project_id: string; selected_candidate_id: string | null;
  selection_revision: number; created_at: string };
type JobRow = { job_id: string; project_id: string; title: string; mode: Static<typeof mode>; max_images: number | null;
  created_at: string };
type AttemptRow = { attempt_number: number; request_id: string; provider: string; provider_job_id: string | null;
  message: string | null; parameters_json: string; started_at: string; updated_at: string };
type ItemRow = SceneRow & { item_id: string; position: number; composition_id: string; candidate_id: string; title: string;
  status: Static<typeof itemStatus>; media_id: string | null; request_id: string | null; next_action_at: number | null };
type MediaRow = SceneRow & {
  media_id: string; item_id: string; job_id: string; composition_id: string; candidate_id: string; project_id: string;
  title: string; content_type: 'image/png'; byte_length: number; sha256: string; width: number; height: number; created_at: string;
};

const mediaSummaryColumns = `m.media_id, m.item_id, m.content_type, m.sha256, m.width, m.height, m.created_at,
  length(m.bytes) AS byte_length, i.job_id, i.composition_id, i.candidate_id,
  c.project_id, c.scene_id, c.scene_revision, c.scene_title, c.scene_href, p.title`;
const mediaRows = `FROM media_images m JOIN media_job_items i ON i.item_id = m.item_id
  JOIN media_compositions c ON c.composition_id = i.composition_id
  JOIN media_composition_candidates p ON p.composition_id = i.composition_id AND p.candidate_id = i.candidate_id`;

function assertText(value: string) {
  if (/[\0\p{Surrogate}]/u.test(value)) {
    throw new OperationError(400, 'jobs_invalid_text', 'Provide well-formed text without NUL characters.');
  }
}

function toScenePin(row: SceneRow): Static<typeof scenePin> {
  return { sceneId: row.scene_id, revision: row.scene_revision, title: row.scene_title, href: row.scene_href };
}

function toComposition(row: CompositionRow): Static<typeof compositionSummary> {
  return { compositionId: row.composition_id, projectId: row.project_id, scene: toScenePin(row),
    selectionRevision: row.selection_revision, createdAt: row.created_at,
    ...(row.selected_candidate_id === null ? {} : { selectedCandidateId: row.selected_candidate_id }) };
}

function requireComposition(db: DatabaseSync, compositionId: string) {
  const row = db.prepare('SELECT * FROM media_compositions WHERE composition_id = ?').get(compositionId);
  if (!row) throw new OperationError(404, 'composition_not_found', 'No composition was found with this ID.');
  return row as CompositionRow;
}

function readComposition(db: DatabaseSync, compositionId: string): Static<typeof composition> {
  const candidates = db.prepare(`SELECT candidate_id AS candidateId, title, prompt FROM media_composition_candidates
    WHERE composition_id = ? ORDER BY position`).all(compositionId) as Static<typeof candidate>[];
  return { ...toComposition(requireComposition(db, compositionId)), candidates };
}

function requireJob(db: DatabaseSync, jobId: string) {
  const row = db.prepare('SELECT * FROM media_jobs WHERE job_id = ?').get(jobId);
  if (!row) throw new OperationError(404, 'jobs_not_found', 'No media job was found with this ID.');
  return row as JobRow;
}

function toAttempt(row: AttemptRow): Static<typeof attempt> {
  return { number: row.attempt_number, requestId: row.request_id, provider: row.provider, startedAt: row.started_at,
    updatedAt: row.updated_at, parameters: JSON.parse(row.parameters_json),
    ...(row.provider_job_id === null ? {} : { providerJobId: row.provider_job_id }),
    ...(row.message === null ? {} : { message: row.message }) };
}

function toJobSummary(db: DatabaseSync, row: JobRow): Static<typeof jobSummary> {
  const statuses = db.prepare(`SELECT status, count(*) AS total, sum(attempt_number) AS attempts
    FROM media_job_items WHERE job_id = ? GROUP BY status`).all(row.job_id) as
    { status: Static<typeof itemStatus>; total: number; attempts: number }[];
  const progress = { queued: 0, submitting: 0, submitted: 0, unknown: 0, failed: 0, succeeded: 0, canceled: 0 };
  let attemptsStarted = 0;
  for (const { status, total, attempts } of statuses) {
    progress[status] = total;
    attemptsStarted += attempts;
  }
  return { jobId: row.job_id, projectId: row.project_id, title: row.title, href: `/jobs/${row.job_id}`,
    mode: row.mode, createdAt: row.created_at, progress, attemptsStarted,
    ...(row.max_images === null ? {} : { maxImages: row.max_images }) };
}

export function readJobSummary(db: DatabaseSync, jobId: string) {
  return toJobSummary(db, requireJob(db, jobId));
}

function readJob(db: DatabaseSync, jobId: string): Static<typeof job> {
  const summary = toJobSummary(db, requireJob(db, jobId));
  const rows = db.prepare(`SELECT i.*, c.scene_id, c.scene_revision, c.scene_title, c.scene_href,
    p.title, a.request_id, a.provider, a.provider_job_id, a.parameters_json, a.message, a.started_at,
    a.updated_at, m.media_id
    FROM media_job_items i JOIN media_compositions c ON c.composition_id = i.composition_id
    JOIN media_composition_candidates p ON p.composition_id = i.composition_id AND p.candidate_id = i.candidate_id
    LEFT JOIN media_job_attempts a ON a.item_id = i.item_id AND a.attempt_number = i.attempt_number
    LEFT JOIN media_images m ON m.item_id = i.item_id
    WHERE i.job_id = ? ORDER BY i.position`).all(jobId) as (ItemRow & Partial<AttemptRow>)[];
  return { ...summary, items: rows.map(row => ({
    itemId: row.item_id, position: row.position, compositionId: row.composition_id, candidateId: row.candidate_id,
    title: row.title, scene: toScenePin(row), status: row.status,
    reconciliationQueued: row.status === 'unknown' && row.next_action_at !== null,
    ...(row.request_id ? { attempt: toAttempt(row as ItemRow & AttemptRow) } : {}),
    ...(row.media_id === null ? {} : { mediaId: row.media_id, mediaHref: `/media/${row.media_id}` }),
  })) };
}

function toMediaSummary(row: MediaRow): Static<typeof mediaSummary> {
  return { mediaId: row.media_id, title: row.title, href: `/media/${row.media_id}`,
    contentHref: `/api/web/media/${row.media_id}/content`, jobId: row.job_id, itemId: row.item_id,
    projectId: row.project_id, scene: toScenePin(row), compositionId: row.composition_id, candidateId: row.candidate_id,
    contentType: row.content_type, byteLength: row.byte_length, sha256: row.sha256, width: row.width, height: row.height,
    createdAt: row.created_at };
}

export function readMediaMetadata(db: DatabaseSync, mediaId: string): Static<typeof media> {
  const row = db.prepare(`SELECT ${mediaSummaryColumns}, m.attempt_number,
    a.request_id, a.provider, a.provider_job_id, a.parameters_json, a.message, a.started_at, a.updated_at
    ${mediaRows} JOIN media_job_attempts a ON a.item_id = m.item_id AND a.attempt_number = m.attempt_number
    WHERE m.media_id = ?`).get(mediaId) as (MediaRow & AttemptRow) | undefined;
  if (!row) throw new OperationError(404, 'media_not_found', 'No stored image was found with this ID.');
  return { ...toMediaSummary(row), attempt: toAttempt(row) };
}

const jobIdInput = Type.Object({ jobId: id }, strict);
const actionInput = Type.Object({ jobId: id, itemIds: Type.Optional(Type.Array(id, {
  minItems: 1, maxItems: maxBatchItems, uniqueItems: true,
})) }, strict);

function eligibleItems(db: DatabaseSync, jobId: string, status: 'failed' | 'unknown', itemIds?: string[]) {
  const { items } = readJob(db, jobId);
  const matching = items.filter(item => item.status === status).map(item => item.itemId);
  if (itemIds?.some(id => !matching.includes(id))) {
    throw new OperationError(409, 'jobs_ineligible_item', `Each requested item must belong to this job and have status ${status}.`);
  }
  return itemIds ?? matching;
}

export const jobsOperations = [
  defineOperation({
    id: 'composition.create', effect: 'write',
    description: 'Save illustration candidates for an exact scene revision placed in the specified project. Read scene.read at that revision and use its pinned sources and draft when writing candidate prompts. Ask the author to choose a candidate before creating a media job.',
    inputSchema: Type.Object({ projectId: id, sceneId: id, sceneRevision: revision,
      candidates: Type.Array(Type.Object(candidateInput, strict), { minItems: 1, maxItems: 8 }) }, strict),
    outputSchema: composition,
    run(input, { db }) {
      const scene = readScene(db, input.sceneId, input.sceneRevision);
      if (scene.placement?.projectId !== input.projectId) {
        throw new OperationError(409, 'composition_scene_project_mismatch', 'Place the scene in a chapter of the specified project first.');
      }
      const compositionId = randomUUID();
      const sceneHref = `${scene.href}${scene.href.includes('?') ? '&' : '?'}revision=${scene.revision}`;
      db.prepare(`INSERT INTO media_compositions (composition_id, project_id, scene_id, scene_revision, scene_title,
        scene_href, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(compositionId, input.projectId, scene.sceneId, scene.revision, scene.title, sceneHref, new Date().toISOString());
      const insert = db.prepare(`INSERT INTO media_composition_candidates (composition_id, candidate_id, position, title, prompt)
        VALUES (?, ?, ?, ?, ?)`);
      for (const [index, candidate] of input.candidates.entries()) {
        assertText(candidate.title);
        assertText(candidate.prompt);
        insert.run(compositionId, randomUUID(), index + 1, candidate.title.trim(), candidate.prompt);
      }
      return readComposition(db, compositionId);
    },
  }),
  defineOperation({
    id: 'composition.read', effect: 'read', description: 'Read the saved candidates and author selection for a pinned scene revision.',
    inputSchema: Type.Object({ compositionId: id }, strict), outputSchema: composition,
    run: ({ compositionId }, { db }) => readComposition(db, compositionId),
  }),
  defineOperation({
    id: 'composition.list', effect: 'read', description: 'List illustration composition sets by project, optionally filtered by scene and revision.',
    inputSchema: Type.Object({ projectId: id, sceneId: Type.Optional(id), sceneRevision: Type.Optional(revision), ...pagination }, strict),
    outputSchema: Type.Object({ items: Type.Array(compositionSummary, { maxItems: 50 }) }, strict),
    run({ projectId, sceneId, sceneRevision, limit = 20, offset = 0 }, { db }) {
      const rows = db.prepare(`SELECT * FROM media_compositions WHERE project_id = ?
        AND (? IS NULL OR scene_id = ?) AND (? IS NULL OR scene_revision = ?)
        ORDER BY created_at DESC, composition_id LIMIT ? OFFSET ?`)
        .all(projectId, sceneId ?? null, sceneId ?? null, sceneRevision ?? null, sceneRevision ?? null, limit, offset);
      return { items: (rows as CompositionRow[]).map(toComposition) };
    },
  }),
  defineOperation({
    id: 'composition.select', effect: 'write', description: 'Record the author\'s chosen composition candidate. Use selectionRevision from composition.read as expectedSelectionRevision.',
    inputSchema: Type.Object({ ...candidatePin, expectedSelectionRevision: count }, strict), outputSchema: composition,
    run({ compositionId, candidateId, expectedSelectionRevision }, { db }) {
      const current = readComposition(db, compositionId);
      if (!current.candidates.some(entry => entry.candidateId === candidateId)) {
        throw new OperationError(404, 'composition_candidate_not_found', 'This candidate does not belong to the composition.');
      }
      if (current.selectionRevision !== expectedSelectionRevision) {
        throw new OperationError(409, 'composition_selection_conflict', `Selection is at revision ${current.selectionRevision}. Read it before selecting.`);
      }
      if (current.selectedCandidateId === candidateId) return current;
      db.prepare(`UPDATE media_compositions SET selected_candidate_id = ?, selection_revision = selection_revision + 1
        WHERE composition_id = ?`).run(candidateId, compositionId);
      return readComposition(db, compositionId);
    },
  }),
  defineOperation({
    id: 'jobs.create', effect: 'write', interaction: { resultLink },
    description: 'Queue one image per selected composition in the project. For a direct author request use manual mode and provider defaults. For autonomous runs set mode=autonomous and maxImages to the total submission budget including retries.',
    inputSchema: Type.Object({ projectId: id, title, mode: Type.Optional(mode), maxImages: Type.Optional(maxImages),
      items: Type.Array(candidateRef, { minItems: 1, maxItems: maxBatchItems }) }, strict), outputSchema: job,
    run({ projectId, title, mode = 'manual', maxImages, items }, { db }) {
      assertText(title);
      requireProject(db, projectId);
      if (mode === 'autonomous' ? maxImages === undefined || items.length > maxImages : maxImages !== undefined) {
        throw new OperationError(400, 'jobs_invalid_budget', 'Autonomous jobs require a maxImages budget covering all items. Manual jobs use provider defaults.');
      }
      const used = new Set<string>();
      for (const { compositionId, candidateId } of items) {
        const composition = requireComposition(db, compositionId);
        if (composition.project_id !== projectId || composition.selected_candidate_id !== candidateId) {
          throw new OperationError(409, 'jobs_selection_required', 'Each candidate must be the current author selection for a composition in this project.');
        }
        if (used.has(compositionId)) throw new OperationError(400, 'jobs_duplicate_item', 'Include each composition only once per job.');
        used.add(compositionId);
      }
      const jobId = randomUUID();
      db.prepare(`INSERT INTO media_jobs (job_id, project_id, title, mode, max_images, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(jobId, projectId, title.trim(), mode, maxImages ?? null, new Date().toISOString());
      const insert = db.prepare(`INSERT INTO media_job_items (item_id, job_id, position, composition_id, candidate_id, status)
        VALUES (?, ?, ?, ?, ?, 'queued')`);
      for (const [index, item] of items.entries()) insert.run(randomUUID(), jobId, index + 1, item.compositionId, item.candidateId);
      return readJob(db, jobId);
    },
  }),
  defineOperation({
    id: 'jobs.list', effect: 'read', description: 'List media jobs with per-state counts, newest first. Optionally filter by project.',
    inputSchema: Type.Object({ projectId: Type.Optional(id), ...pagination }, strict),
    outputSchema: Type.Object({ items: Type.Array(jobSummary, { maxItems: 50 }) }, strict),
    run({ projectId, limit = 20, offset = 0 }, { db }) {
      const rows = db.prepare(`SELECT * FROM media_jobs WHERE (? IS NULL OR project_id = ?)
        ORDER BY created_at DESC, job_id LIMIT ? OFFSET ?`).all(projectId ?? null, projectId ?? null, limit, offset);
      return { items: (rows as JobRow[]).map(row => toJobSummary(db, row)) };
    },
  }),
  defineOperation({
    id: 'jobs.read', effect: 'read', description: 'Read per-item progress, current request IDs and diagnostics, pinned scene versions, and links to stored images.',
    inputSchema: jobIdInput, outputSchema: job, interaction: { resultLink },
    run: ({ jobId }, { db }) => readJob(db, jobId),
  }),
  defineOperation({
    id: 'jobs.cancel', effect: 'write', description: 'Cancel all remaining queued items in a batch. In-flight items may still complete, and saved results stay readable.',
    inputSchema: jobIdInput, outputSchema: job, interaction: { resultLink },
    run({ jobId }, { db }) {
      requireJob(db, jobId);
      db.prepare(`UPDATE media_job_items SET status = 'canceled' WHERE job_id = ? AND status = 'queued'`).run(jobId);
      return readJob(db, jobId);
    },
  }),
  defineOperation({
    id: 'jobs.retry', effect: 'write', description: 'Queue a new attempt for confirmed failures. Omit itemIds to retry all confirmed failures in the job.',
    inputSchema: actionInput, outputSchema: job, interaction: { resultLink },
    run({ jobId, itemIds }, { db }) {
      const items = eligibleItems(db, jobId, 'failed', itemIds);
      const current = readJob(db, jobId);
      if (items.length && current.maxImages !== undefined
        && current.attemptsStarted + current.progress.queued + items.length > current.maxImages) {
        throw new OperationError(409, 'jobs_budget_exhausted', 'The autonomous submission budget does not cover these retries.');
      }
      const update = db.prepare(`UPDATE media_job_items SET status = 'queued' WHERE item_id = ?`);
      for (const itemId of items) update.run(itemId);
      return readJob(db, jobId);
    },
  }),
  defineOperation({
    id: 'jobs.reconcile', effect: 'write', description: 'Request a read-only provider lookup for items with unknown outcomes. Omit itemIds to look up all unknown items. Read jobs.read with a fresh step ID to see the outcome.',
    inputSchema: actionInput, outputSchema: job, interaction: { resultLink },
    run({ jobId, itemIds }, { db }) {
      const items = eligibleItems(db, jobId, 'unknown', itemIds);
      const schedule = db.prepare(`UPDATE media_job_items SET next_action_at = ? WHERE item_id = ? AND next_action_at IS NULL`);
      for (const itemId of items) schedule.run(Date.now(), itemId);
      return readJob(db, jobId);
    },
  }),
  defineOperation({
    id: 'media.list', effect: 'read', description: 'List stored illustration images newest first. Filter by project, scene, exact scene revision, or job. Use media.read to see provider details.',
    inputSchema: Type.Object({ projectId: Type.Optional(id), sceneId: Type.Optional(id), sceneRevision: Type.Optional(revision),
      jobId: Type.Optional(id), ...pagination }, strict),
    outputSchema: Type.Object({ items: Type.Array(mediaSummary, { maxItems: 50 }) }, strict),
    run({ projectId, sceneId, sceneRevision, jobId, limit = 20, offset = 0 }, { db }) {
      const rows = db.prepare(`SELECT ${mediaSummaryColumns} ${mediaRows}
        WHERE (? IS NULL OR c.project_id = ?) AND (? IS NULL OR c.scene_id = ?)
        AND (? IS NULL OR c.scene_revision = ?) AND (? IS NULL OR i.job_id = ?)
        ORDER BY m.created_at DESC, m.media_id LIMIT ? OFFSET ?`).all(
        projectId ?? null, projectId ?? null, sceneId ?? null, sceneId ?? null, sceneRevision ?? null, sceneRevision ?? null,
        jobId ?? null, jobId ?? null, limit, offset,
      );
      return { items: (rows as MediaRow[]).map(toMediaSummary) };
    },
  }),
  defineOperation({
    id: 'media.read', effect: 'read', description: 'Read the link, scene and composition provenance, and provider metadata for a stored image.',
    inputSchema: Type.Object({ mediaId: id }, strict), outputSchema: media, interaction: { resultLink },
    run: ({ mediaId }, { db }) => readMediaMetadata(db, mediaId),
  }),
];
