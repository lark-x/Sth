export const sceneDDL = `
CREATE TABLE IF NOT EXISTS story_chapters (
  chapter_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES library_projects(project_id),
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  UNIQUE (project_id, position)
) STRICT;

CREATE TABLE IF NOT EXISTS story_scenes (
  scene_id TEXT PRIMARY KEY,
  origin_scene_id TEXT,
  origin_scene_revision INTEGER,
  origin_draft_id TEXT,
  origin_draft_revision INTEGER,
  divergence TEXT,
  CHECK ((origin_scene_id IS NULL) = (origin_scene_revision IS NULL)),
  CHECK ((origin_scene_id IS NULL) = (divergence IS NULL)),
  CHECK ((origin_draft_id IS NULL) = (origin_draft_revision IS NULL)),
  CHECK (origin_draft_id IS NULL OR origin_scene_id IS NOT NULL),
  FOREIGN KEY (origin_scene_id, origin_scene_revision)
    REFERENCES story_scene_revisions(scene_id, revision),
  FOREIGN KEY (origin_scene_id, origin_draft_id, origin_draft_revision)
    REFERENCES story_draft_revisions(scene_id, draft_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS story_scene_revisions (
  scene_id TEXT NOT NULL REFERENCES story_scenes(scene_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  time TEXT,
  place TEXT,
  adopted_draft_id TEXT,
  adopted_draft_revision INTEGER,
  CHECK ((adopted_draft_id IS NULL) = (adopted_draft_revision IS NULL)),
  PRIMARY KEY (scene_id, revision),
  FOREIGN KEY (scene_id, adopted_draft_id, adopted_draft_revision)
    REFERENCES story_draft_revisions(scene_id, draft_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS story_scene_characters (
  scene_id TEXT NOT NULL,
  scene_revision INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position > 0),
  character_id TEXT NOT NULL,
  character_revision INTEGER NOT NULL,
  PRIMARY KEY (scene_id, scene_revision, position),
  UNIQUE (scene_id, scene_revision, character_id),
  FOREIGN KEY (scene_id, scene_revision) REFERENCES story_scene_revisions(scene_id, revision),
  FOREIGN KEY (character_id, character_revision) REFERENCES library_character_revisions(character_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS story_chapter_scenes (
  scene_id TEXT PRIMARY KEY REFERENCES story_scenes(scene_id),
  chapter_id TEXT NOT NULL REFERENCES story_chapters(chapter_id),
  position INTEGER NOT NULL CHECK (position > 0),
  UNIQUE (chapter_id, position)
) STRICT;

CREATE TABLE IF NOT EXISTS story_drafts (
  draft_id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES story_scenes(scene_id),
  UNIQUE (scene_id, draft_id)
) STRICT;

CREATE TABLE IF NOT EXISTS story_draft_revisions (
  draft_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  scene_id TEXT NOT NULL,
  scene_revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (draft_id, revision),
  UNIQUE (scene_id, draft_id, revision),
  FOREIGN KEY (scene_id, draft_id) REFERENCES story_drafts(scene_id, draft_id),
  FOREIGN KEY (scene_id, scene_revision) REFERENCES story_scene_revisions(scene_id, revision)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS story_chapters_by_title ON story_chapters(title_key, project_id);
CREATE INDEX IF NOT EXISTS story_scenes_by_origin ON story_scenes(origin_scene_id, scene_id);
CREATE INDEX IF NOT EXISTS story_scene_revisions_by_title ON story_scene_revisions(title_key, scene_id, revision);
`;

const narrativeDDL = `
CREATE TABLE IF NOT EXISTS story_events (
  event_id TEXT PRIMARY KEY,
  branch_id TEXT REFERENCES story_scenes(scene_id)
) STRICT;

CREATE TABLE IF NOT EXISTS story_event_revisions (
  event_id TEXT NOT NULL REFERENCES story_events(event_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (event_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS story_event_order (
  scope_id TEXT NOT NULL,
  before_event_id TEXT NOT NULL REFERENCES story_events(event_id),
  after_event_id TEXT NOT NULL REFERENCES story_events(event_id),
  PRIMARY KEY (scope_id, before_event_id, after_event_id),
  CHECK (before_event_id <> after_event_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS story_events_by_branch ON story_events(branch_id);
CREATE INDEX IF NOT EXISTS story_event_order_by_after ON story_event_order(scope_id, after_event_id, before_event_id);

CREATE TABLE IF NOT EXISTS story_narratives (
  narrative_id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES story_scenes(scene_id)
) STRICT;

CREATE TABLE IF NOT EXISTS story_narrative_revisions (
  narrative_id TEXT NOT NULL REFERENCES story_narratives(narrative_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  scene_id TEXT NOT NULL,
  scene_revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (narrative_id, revision),
  FOREIGN KEY (scene_id, scene_revision) REFERENCES story_scene_revisions(scene_id, revision)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS story_narratives_by_scene ON story_narratives(scene_id);

CREATE TABLE IF NOT EXISTS story_branch_details (
  branch_id TEXT PRIMARY KEY REFERENCES story_scenes(scene_id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  narrative_id TEXT,
  narrative_revision INTEGER,
  CHECK ((narrative_id IS NULL) = (narrative_revision IS NULL)),
  FOREIGN KEY (narrative_id, narrative_revision) REFERENCES story_narrative_revisions(narrative_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS story_branch_shared_events (
  branch_id TEXT NOT NULL REFERENCES story_branch_details(branch_id),
  event_id TEXT NOT NULL,
  event_revision INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position > 0),
  PRIMARY KEY (branch_id, event_id),
  UNIQUE (branch_id, position),
  FOREIGN KEY (event_id, event_revision) REFERENCES story_event_revisions(event_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS story_branch_scenes (
  scene_id TEXT PRIMARY KEY REFERENCES story_scenes(scene_id),
  branch_id TEXT NOT NULL REFERENCES story_scenes(scene_id),
  CHECK (scene_id <> branch_id)
) STRICT;

CREATE INDEX IF NOT EXISTS story_branch_scenes_by_branch ON story_branch_scenes(branch_id);

CREATE TABLE IF NOT EXISTS story_branch_checkpoints (
  branch_id TEXT NOT NULL REFERENCES story_scenes(scene_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 2 AND 9007199254740991),
  scene_id TEXT NOT NULL,
  scene_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (branch_id, revision),
  FOREIGN KEY (scene_id, scene_revision) REFERENCES story_scene_revisions(scene_id, revision)
) STRICT, WITHOUT ROWID;
`;

export const storyDDL = sceneDDL + narrativeDDL;
