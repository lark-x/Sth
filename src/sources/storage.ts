import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import { sourceHref } from './contracts.ts';

export const sourcesDDL = `
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY
) STRICT;

CREATE TABLE IF NOT EXISTS source_revisions (
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('setting', 'inspiration', 'excerpt')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  origin TEXT,
  PRIMARY KEY (source_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_revision_projects (
  source_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES library_projects(project_id),
  PRIMARY KEY (source_id, revision, project_id),
  FOREIGN KEY (source_id, revision) REFERENCES source_revisions(source_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_pin_owners (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('diary', 'scene', 'draft')),
  owner_id TEXT NOT NULL,
  owner_revision INTEGER NOT NULL CHECK (owner_revision BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL,
  href TEXT NOT NULL,
  project_id TEXT REFERENCES library_projects(project_id),
  PRIMARY KEY (owner_kind, owner_id, owner_revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_pins (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_revision INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, owner_revision, position),
  UNIQUE (owner_kind, owner_id, owner_revision, source_id, source_revision, excerpt),
  FOREIGN KEY (owner_kind, owner_id, owner_revision) REFERENCES source_pin_owners(owner_kind, owner_id, owner_revision),
  FOREIGN KEY (source_id, source_revision) REFERENCES source_revisions(source_id, revision)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS source_pins_by_source ON source_pins(source_id, source_revision);
`;

export const rangedSourcePinsDDL = `
CREATE TABLE IF NOT EXISTS source_ranged_pins (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_revision INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  range_start INTEGER NOT NULL CHECK (range_start >= 0),
  range_end INTEGER NOT NULL CHECK (range_end > range_start AND range_end <= 100000),
  PRIMARY KEY (owner_kind, owner_id, owner_revision, position),
  UNIQUE (owner_kind, owner_id, owner_revision, source_id, source_revision, range_start, range_end),
  FOREIGN KEY (owner_kind, owner_id, owner_revision) REFERENCES source_pin_owners(owner_kind, owner_id, owner_revision),
  FOREIGN KEY (source_id, source_revision) REFERENCES source_revisions(source_id, revision)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS source_ranged_pins_by_source ON source_ranged_pins(source_id, source_revision);
`;

export const sourcePinRows = `
  SELECT owner_kind, owner_id, owner_revision, position, source_id, source_revision, excerpt,
    NULL AS range_start, NULL AS range_end FROM source_pins
  UNION ALL
  SELECT owner_kind, owner_id, owner_revision, position, source_id, source_revision, excerpt,
    range_start, range_end FROM source_ranged_pins
`;

type SourceKind = 'setting' | 'inspiration' | 'excerpt';

type SourceFields = { kind: SourceKind; title: string; body: string; origin?: string; projectIds: string[] };
export type SourceRow = {
  source_id: string;
  revision: number;
  kind: SourceKind;
  title: string;
  body: string;
  origin: string | null;
  project_ids: string;
};

export type SourcePinRow = {
  source_id: string;
  source_revision: number;
  excerpt: string;
  range_start: number | null;
  range_end: number | null;
};

export const sourceRevisions = `
  SELECT r.*,
    (SELECT json_group_array(p.project_id ORDER BY p.project_id) FROM source_revision_projects p
      WHERE p.source_id = r.source_id AND p.revision = r.revision) AS project_ids
  FROM source_revisions r
`;

export const currentSources = `${sourceRevisions}
  WHERE r.revision = (SELECT MAX(revision) FROM source_revisions WHERE source_id = r.source_id)
`;

export function toSourceSummary(row: SourceRow) {
  return {
    sourceId: row.source_id,
    revision: row.revision,
    kind: row.kind,
    title: row.title,
    href: sourceHref(row.source_id, row.revision),
    projectIds: JSON.parse(row.project_ids) as string[],
    ...(row.origin === null ? {} : { origin: row.origin }),
  };
}

export function readSource(db: DatabaseSync, sourceId: string, revision?: number) {
  const row = (revision === undefined
    ? db.prepare(`${currentSources} AND r.source_id = ?`).get(sourceId)
    : db.prepare(`${sourceRevisions} WHERE r.source_id = ? AND r.revision = ?`).get(sourceId, revision)) as SourceRow | undefined;
  if (!row) {
    if (revision !== undefined && db.prepare('SELECT 1 FROM sources WHERE source_id = ?').get(sourceId)) {
      throw new OperationError(404, 'source_revision_not_found', `Source ${sourceId} has no revision ${revision}.`);
    }
    throw new OperationError(404, 'source_not_found', `Source ${sourceId} was not found.`);
  }
  return { ...toSourceSummary(row), body: row.body };
}

export function writeSourceRevision(db: DatabaseSync, sourceId: string, revision: number, fields: SourceFields) {
  db.prepare(`INSERT INTO source_revisions (source_id, revision, kind, title, body, origin)
    VALUES (?, ?, ?, ?, ?, ?)`).run(sourceId, revision, fields.kind, fields.title, fields.body, fields.origin ?? null);
  const attach = db.prepare('INSERT INTO source_revision_projects (source_id, revision, project_id) VALUES (?, ?, ?)');
  for (const projectId of fields.projectIds) attach.run(sourceId, revision, projectId);
}

export function assertSourceText(...values: string[]) {
  // Node SQLite cannot round-trip NUL or unpaired UTF-16 surrogates in text.
  if (values.some(value => /[\0\p{Surrogate}]/u.test(value))) {
    throw new OperationError(400, 'source_invalid_text', 'Provide well-formed source text without NUL characters.');
  }
}
