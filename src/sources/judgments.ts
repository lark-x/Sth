import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { Type, type Static } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { requireProject } from '../library/storage.ts';
import {
  defaultLimit, evidenceStance, ExactSourcePinSchema, href, id, itemList, LinkedExactSourcePinSchema, pagination,
  resultLink, revision, sourceHref, strict, title,
} from './contracts.ts';
import { validateSourcePin } from './pins.ts';
import { assertSourceText } from './storage.ts';

export const judgmentsDDL = `
CREATE TABLE IF NOT EXISTS research_judgments (
  judgment_id TEXT PRIMARY KEY
) STRICT;

CREATE TABLE IF NOT EXISTS research_judgment_revisions (
  judgment_id TEXT NOT NULL REFERENCES research_judgments(judgment_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  scope TEXT,
  project_id TEXT REFERENCES library_projects(project_id),
  PRIMARY KEY (judgment_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS research_judgment_evidence (
  judgment_id TEXT NOT NULL,
  judgment_revision INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  stance TEXT NOT NULL CHECK (stance IN ('support', 'counter')),
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  range_start INTEGER NOT NULL CHECK (range_start >= 0),
  range_end INTEGER NOT NULL CHECK (range_end > range_start AND range_end <= 100000),
  PRIMARY KEY (judgment_id, judgment_revision, position),
  UNIQUE (judgment_id, judgment_revision, stance, source_id, source_revision, range_start, range_end),
  FOREIGN KEY (judgment_id, judgment_revision) REFERENCES research_judgment_revisions(judgment_id, revision),
  FOREIGN KEY (source_id, source_revision) REFERENCES source_revisions(source_id, revision)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS research_judgment_evidence_by_source ON research_judgment_evidence(source_id, source_revision);
`;

const interpretation = Type.String({ maxLength: 4_000, pattern: '\\S' });
const evidenceInput = Type.Array(Type.Object({ stance: evidenceStance, pin: ExactSourcePinSchema }, strict), {
  maxItems: 20, uniqueItems: true,
});
const linkedEvidence = Type.Object({ stance: evidenceStance, pin: LinkedExactSourcePinSchema }, strict);
const summaryFields = { judgmentId: id, revision, href, title, scope: Type.Optional(interpretation), projectId: Type.Optional(id) };
const summary = Type.Object(summaryFields, strict);
const judgment = Type.Object({ ...summaryFields, statement: interpretation, evidence: Type.Array(linkedEvidence, { maxItems: 20 }) }, strict);

export type Judgment = Static<typeof judgment>;
export type JudgmentSummary = Static<typeof summary>;
type Evidence = Static<typeof linkedEvidence>;
type JudgmentRow = {
  judgment_id: string; revision: number; title: string; statement: string; scope: string | null; project_id: string | null;
};
type EvidenceRow = {
  stance: Evidence['stance']; source_id: string; source_revision: number; excerpt: string; range_start: number; range_end: number;
};

const latestRevision = `(SELECT MAX(v.revision) FROM research_judgment_revisions v WHERE v.judgment_id = r.judgment_id)`;

export function judgmentHref(judgmentId: string, revision: number) {
  return `/judgments/${encodeURIComponent(judgmentId)}?revision=${revision}`;
}

function toSummary(row: JudgmentRow): JudgmentSummary {
  return {
    judgmentId: row.judgment_id, revision: row.revision, title: row.title,
    href: judgmentHref(row.judgment_id, row.revision),
    ...(row.scope === null ? {} : { scope: row.scope }),
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
  };
}

export function readJudgment(db: DatabaseSync, judgmentId: string, revision?: number): Judgment {
  assertSourceText(judgmentId);
  const row = (revision === undefined
    ? db.prepare(`SELECT r.* FROM research_judgment_revisions r WHERE r.judgment_id = ? AND r.revision = ${latestRevision}`).get(judgmentId)
    : db.prepare('SELECT * FROM research_judgment_revisions WHERE judgment_id = ? AND revision = ?').get(judgmentId, revision)
  ) as JudgmentRow | undefined;
  if (!row) {
    if (revision !== undefined && db.prepare('SELECT 1 FROM research_judgments WHERE judgment_id = ?').get(judgmentId)) {
      throw new OperationError(404, 'judgment_revision_not_found', `Judgment ${judgmentId} has no revision ${revision}.`);
    }
    throw new OperationError(404, 'judgment_not_found', `Judgment ${judgmentId} was not found.`);
  }
  const rows = db.prepare(`SELECT stance, source_id, source_revision, excerpt, range_start, range_end
    FROM research_judgment_evidence WHERE judgment_id = ? AND judgment_revision = ? ORDER BY position`)
    .all(judgmentId, row.revision) as EvidenceRow[];
  const evidence = rows.map(row => ({
    stance: row.stance,
    pin: {
      sourceId: row.source_id, revision: row.source_revision, excerpt: row.excerpt,
      range: { start: row.range_start, end: row.range_end }, href: sourceHref(row.source_id, row.source_revision),
    },
  }));
  return { ...toSummary(row), statement: row.statement, evidence };
}

function linkEvidence(db: DatabaseSync, evidence: Static<typeof evidenceInput>): Evidence[] {
  return evidence.map(({ stance, pin }) => ({ stance, pin: validateSourcePin(db, pin) }));
}

function writeRevision(db: DatabaseSync, judgmentId: string, revision: number, fields: Omit<Judgment, 'judgmentId' | 'revision' | 'href'>) {
  const { title, statement, scope, projectId, evidence } = fields;
  assertSourceText(title, statement, scope ?? '', projectId ?? '');
  if (projectId !== undefined) requireProject(db, projectId);
  db.prepare(`INSERT INTO research_judgment_revisions (judgment_id, revision, title, statement, scope, project_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(judgmentId, revision, title, statement, scope ?? null, projectId ?? null);
  const insertEvidence = db.prepare(`INSERT INTO research_judgment_evidence
    (judgment_id, judgment_revision, position, stance, source_id, source_revision, excerpt, range_start, range_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  evidence.forEach(({ stance, pin }, position) => {
    insertEvidence.run(judgmentId, revision, position, stance, pin.sourceId, pin.revision, pin.excerpt, pin.range.start, pin.range.end);
  });
  return readJudgment(db, judgmentId, revision);
}

export const judgmentOperations = [
  defineOperation({
    id: 'judgment.create', effect: 'write',
    description: 'Save a reusable interpretation with its statement, optional scope and project, and exact source pins marked support or counter.',
    interaction: { resultLink },
    inputSchema: Type.Object({
      title, statement: interpretation, scope: Type.Optional(interpretation), projectId: Type.Optional(id), evidence: Type.Optional(evidenceInput),
    }, strict),
    outputSchema: judgment,
    run({ title, statement, scope, projectId, evidence = [] }, { db }) {
      const linked = linkEvidence(db, evidence);
      const judgmentId = randomUUID();
      db.prepare('INSERT INTO research_judgments (judgment_id) VALUES (?)').run(judgmentId);
      return writeRevision(db, judgmentId, 1, { title: title.trim(), statement, scope, projectId, evidence: linked });
    },
  }),
  defineOperation({
    id: 'judgment.read', effect: 'read',
    description: 'Read a judgment and the exact sources it used. Supply revision for a historical judgment, or omit it for the latest one.',
    interaction: { resultLink },
    inputSchema: Type.Object({ judgmentId: id, revision: Type.Optional(revision) }, strict),
    outputSchema: judgment,
    run: ({ judgmentId, revision }, { db }) => readJudgment(db, judgmentId, revision),
  }),
  defineOperation({
    id: 'judgment.revise', effect: 'write',
    description: 'Revise a judgment using its current expectedRevision. Omitted fields carry forward. Null clears scope or projectId, and an evidence array replaces the previous list, including [] to clear it.',
    interaction: { resultLink },
    inputSchema: Type.Object({
      judgmentId: id, expectedRevision: revision, title: Type.Optional(title), statement: Type.Optional(interpretation),
      scope: Type.Optional(Type.Union([interpretation, Type.Null()])), projectId: Type.Optional(Type.Union([id, Type.Null()])),
      evidence: Type.Optional(evidenceInput),
    }, strict),
    outputSchema: judgment,
    run(input, { db }) {
      const current = readJudgment(db, input.judgmentId);
      if (input.expectedRevision !== current.revision) {
        throw new OperationError(409, 'judgment_revision_conflict', `Judgment is at revision ${current.revision}. Read it before revising.`);
      }
      const { title, statement, scope, projectId, evidence } = current;
      const next = {
        title: input.title?.trim() ?? title,
        statement: input.statement ?? statement,
        scope: input.scope === undefined ? scope : input.scope ?? undefined,
        projectId: input.projectId === undefined ? projectId : input.projectId ?? undefined,
        evidence: input.evidence === undefined ? evidence : linkEvidence(db, input.evidence),
      };
      if (isDeepStrictEqual(next, { title, statement, scope, projectId, evidence })) return current;
      return writeRevision(db, current.judgmentId, current.revision + 1, next);
    },
  }),
  defineOperation({
    id: 'judgment.list', effect: 'read',
    description: 'List latest judgment summaries ordered by title and ID. Filter by projectId and use limit and offset to page. Read a judgment for its statement and evidence.',
    inputSchema: Type.Object({ projectId: Type.Optional(id), ...pagination }, strict),
    outputSchema: itemList(summary),
    run({ projectId, limit = defaultLimit, offset = 0 }, { db }) {
      assertSourceText(projectId ?? '');
      const filter = projectId === undefined ? '' : 'AND r.project_id = ?';
      const params = projectId === undefined ? [] : [projectId];
      const rows = db.prepare(`SELECT r.* FROM research_judgment_revisions r WHERE r.revision = ${latestRevision} ${filter}
        ORDER BY r.title, r.judgment_id LIMIT ? OFFSET ?`).all(...params, limit, offset) as JudgmentRow[];
      return { items: rows.map(toSummary) };
    },
  }),
];
