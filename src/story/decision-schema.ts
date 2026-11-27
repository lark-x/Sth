import type { DatabaseSync } from 'node:sqlite';

// Additive story migration within workspace format 4. All callers use the same startup transaction.
export const decisionSchemaVersion = 1;
export const decisionsDDL = `
CREATE TABLE IF NOT EXISTS story_decisions_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS story_context_scopes (
  project_id TEXT NOT NULL REFERENCES library_projects(project_id),
  branch_key TEXT NOT NULL,
  branch_id TEXT UNIQUE REFERENCES story_scenes(scene_id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  CHECK (branch_key = COALESCE(branch_id, '')),
  PRIMARY KEY (project_id, branch_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS story_decisions (
  decision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  branch_key TEXT NOT NULL,
  FOREIGN KEY (project_id, branch_key) REFERENCES story_context_scopes(project_id, branch_key)
) STRICT;

CREATE TABLE IF NOT EXISTS story_decision_revisions (
  decision_id TEXT NOT NULL REFERENCES story_decisions(decision_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  context_revision INTEGER NOT NULL CHECK (context_revision BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'object'),
  created_at TEXT NOT NULL,
  proposal_revision INTEGER,
  confirmed_by TEXT,
  confirmed_at TEXT,
  CHECK ((status = 'proposed' AND proposal_revision IS NULL AND confirmed_by IS NULL AND confirmed_at IS NULL)
    OR (status = 'confirmed' AND proposal_revision < revision AND confirmed_by IS NOT NULL
      AND length(trim(confirmed_by)) > 0 AND confirmed_at IS NOT NULL AND proposal_revision IS NOT NULL)),
  PRIMARY KEY (decision_id, revision),
  FOREIGN KEY (decision_id, proposal_revision) REFERENCES story_decision_revisions(decision_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS story_questions (
  question_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  branch_key TEXT NOT NULL,
  FOREIGN KEY (project_id, branch_key) REFERENCES story_context_scopes(project_id, branch_key)
) STRICT;

CREATE TABLE IF NOT EXISTS story_question_revisions (
  question_id TEXT NOT NULL REFERENCES story_questions(question_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  context_revision INTEGER NOT NULL CHECK (context_revision BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'object'),
  created_at TEXT NOT NULL,
  decision_id TEXT,
  decision_revision INTEGER,
  CHECK ((status = 'open' AND decision_id IS NULL AND decision_revision IS NULL)
    OR (status = 'resolved' AND decision_id IS NOT NULL AND decision_revision IS NOT NULL)),
  PRIMARY KEY (question_id, revision),
  FOREIGN KEY (decision_id, decision_revision) REFERENCES story_decision_revisions(decision_id, revision)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS story_decisions_by_scope ON story_decisions(project_id, branch_key);
CREATE INDEX IF NOT EXISTS story_questions_by_scope ON story_questions(project_id, branch_key);

CREATE TRIGGER IF NOT EXISTS story_confirmation_requires_proposal BEFORE INSERT ON story_decision_revisions
WHEN NEW.status = 'confirmed' AND NOT EXISTS (
  SELECT 1 FROM story_decision_revisions p WHERE p.decision_id = NEW.decision_id AND p.revision = NEW.proposal_revision
    AND p.status = 'proposed' AND p.title = NEW.title AND p.body = NEW.body AND p.basis_json = NEW.basis_json
)
BEGIN SELECT RAISE(ABORT, 'Confirmation must pin an unchanged proposal version'); END;

CREATE TRIGGER IF NOT EXISTS story_resolution_requires_confirmation BEFORE INSERT ON story_question_revisions
WHEN NEW.status = 'resolved' AND NOT EXISTS (
  SELECT 1 FROM story_decision_revisions r JOIN story_decisions d USING (decision_id)
    JOIN story_questions q ON q.question_id = NEW.question_id
  WHERE r.decision_id = NEW.decision_id AND r.revision = NEW.decision_revision AND r.status = 'confirmed'
    AND d.project_id = q.project_id AND d.branch_key = q.branch_key
)
BEGIN SELECT RAISE(ABORT, 'Resolution must pin a confirmed version in the same scope'); END;
` + ['story_decisions', 'story_decision_revisions', 'story_questions', 'story_question_revisions'].flatMap(table =>
  ['UPDATE', 'DELETE'].map(action => `
CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table}
BEGIN SELECT RAISE(ABORT, 'Story decision history is append-only'); END;
`)).join('');

/** Run inside openDatabase's BEGIN IMMEDIATE, including on existing format-4 databases. */
export function migrateDecisions(db: DatabaseSync) {
  if (!db.isTransaction) throw new Error('Story migrations require the database startup transaction.');
  const installed = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'story_decisions_schema'").get();
  const row = installed ? db.prepare('SELECT version FROM story_decisions_schema WHERE singleton = 1').get() : undefined;
  if (row && row.version !== decisionSchemaVersion) throw new Error(`Unsupported story decisions schema ${row.version}.`);
  if (row) return;
  db.exec(decisionsDDL);
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Foreign key check failed during story migration.');
  db.prepare('INSERT INTO story_decisions_schema (singleton, version) VALUES (1, ?)').run(decisionSchemaVersion);
}
