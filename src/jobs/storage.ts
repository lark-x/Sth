import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';

export const maxBatchItems = 20;
export const maxImageBytes = 16 * 1024 * 1024;

export const jobsDDL = `
CREATE TABLE IF NOT EXISTS media_compositions (
  composition_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES library_projects(project_id),
  scene_id TEXT NOT NULL,
  scene_revision INTEGER NOT NULL CHECK (scene_revision > 0),
  scene_title TEXT NOT NULL,
  scene_href TEXT NOT NULL,
  selected_candidate_id TEXT,
  selection_revision INTEGER NOT NULL DEFAULT 0 CHECK (selection_revision >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (scene_id, scene_revision) REFERENCES story_scene_revisions(scene_id, revision),
  FOREIGN KEY (composition_id, selected_candidate_id)
    REFERENCES media_composition_candidates(composition_id, candidate_id)
) STRICT;
CREATE TABLE IF NOT EXISTS media_composition_candidates (
  composition_id TEXT NOT NULL REFERENCES media_compositions(composition_id),
  candidate_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  PRIMARY KEY (composition_id, candidate_id),
  UNIQUE (composition_id, position)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS media_compositions_by_scene
  ON media_compositions(project_id, scene_id, scene_revision, created_at DESC);

CREATE TABLE IF NOT EXISTS media_jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES library_projects(project_id),
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'autonomous')),
  max_images INTEGER CHECK (max_images BETWEEN 1 AND ${maxBatchItems}),
  created_at TEXT NOT NULL,
  CHECK ((mode = 'autonomous') = (max_images IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS media_jobs_by_project ON media_jobs(project_id, created_at DESC, job_id);
CREATE TABLE IF NOT EXISTS media_job_items (
  item_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES media_jobs(job_id),
  position INTEGER NOT NULL,
  composition_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','submitting','submitted','unknown','failed','succeeded','canceled')),
  attempt_number INTEGER NOT NULL DEFAULT 0 CHECK (attempt_number >= 0),
  next_action_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  UNIQUE (job_id, position),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  FOREIGN KEY (composition_id, candidate_id) REFERENCES media_composition_candidates(composition_id, candidate_id)
) STRICT;
CREATE INDEX IF NOT EXISTS media_job_items_action ON media_job_items(status, next_action_at, lease_until);
CREATE TABLE IF NOT EXISTS media_job_attempts (
  item_id TEXT NOT NULL REFERENCES media_job_items(item_id),
  attempt_number INTEGER NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  provider_job_id TEXT,
  parameters_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitting','submitted','unknown','failed','succeeded')),
  message TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, attempt_number)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS media_images (
  media_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE,
  attempt_number INTEGER NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type = 'image/png'),
  sha256 TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND ${maxImageBytes}),
  created_at TEXT NOT NULL,
  FOREIGN KEY (item_id, attempt_number) REFERENCES media_job_attempts(item_id, attempt_number)
) STRICT;
`;

export function writeTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function sha256(bytes: string | Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readMediaBinary(db: DatabaseSync, mediaId: string) {
  const row = db.prepare(`SELECT bytes, content_type, sha256 FROM media_images WHERE media_id = ?`).get(mediaId) as
    { bytes: Uint8Array; content_type: string; sha256: string } | undefined;
  if (!row) throw new OperationError(404, 'media_not_found', 'No stored image was found with this ID.');
  return { bytes: row.bytes, contentType: row.content_type, byteLength: row.bytes.byteLength, sha256: row.sha256 };
}
