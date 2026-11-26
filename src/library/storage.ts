import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import type { SourcePin } from '../sources/contracts.ts';
import { readSourcePins, writeSourcePins } from '../sources/pins.ts';
import type { CharacterBlock, CharacterEntry } from './character-contracts.ts';

export const libraryDDL = `
CREATE TABLE IF NOT EXISTS library_projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS library_characters (
  character_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES library_projects(project_id)
) STRICT;

CREATE TABLE IF NOT EXISTS library_character_revisions (
  character_id TEXT NOT NULL REFERENCES library_characters(character_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  persona TEXT NOT NULL,
  PRIMARY KEY (character_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS library_character_entries (
  character_id TEXT NOT NULL,
  character_revision INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  entry_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (character_id, character_revision, position),
  UNIQUE (character_id, character_revision, entry_id),
  FOREIGN KEY (character_id, character_revision) REFERENCES library_character_revisions(character_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS library_character_entry_blocks (
  character_id TEXT NOT NULL,
  character_revision INTEGER NOT NULL,
  entry_position INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  block_json TEXT NOT NULL CHECK (json_valid(block_json) AND json_type(block_json) = 'object'),
  resource_kind TEXT GENERATED ALWAYS AS (json_extract(block_json, '$.kind')) VIRTUAL,
  resource_id TEXT GENERATED ALWAYS AS (json_extract(block_json, '$.id')) VIRTUAL,
  resource_revision INTEGER GENERATED ALWAYS AS (json_extract(block_json, '$.revision')) VIRTUAL,
  PRIMARY KEY (character_id, character_revision, entry_position, position),
  FOREIGN KEY (character_id, character_revision, entry_position)
    REFERENCES library_character_entries(character_id, character_revision, position)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS library_character_blocks_by_resource
  ON library_character_entry_blocks(resource_kind, resource_id, resource_revision) WHERE resource_kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS library_diaries (
  note_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES library_projects(project_id),
  character_id TEXT,
  character_revision INTEGER,
  CHECK ((character_id IS NULL) = (character_revision IS NULL)),
  FOREIGN KEY (character_id, character_revision)
    REFERENCES library_character_revisions(character_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS library_diary_revisions (
  note_id TEXT NOT NULL REFERENCES library_diaries(note_id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  diary_date TEXT NOT NULL,
  has_source_pins INTEGER NOT NULL CHECK (has_source_pins IN (0, 1)),
  PRIMARY KEY (note_id, revision)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS library_characters_by_project ON library_characters(project_id, character_id);
CREATE INDEX IF NOT EXISTS library_character_revisions_by_name ON library_character_revisions(name_key, character_id);
CREATE INDEX IF NOT EXISTS library_diary_revisions_by_date ON library_diary_revisions(diary_date DESC, note_id);
CREATE INDEX IF NOT EXISTS library_diaries_by_project ON library_diaries(project_id, note_id);
`;

const characterRevisions = `
  SELECT c.character_id, c.project_id, r.name, r.name_key, r.persona, r.revision
  FROM library_characters c
  JOIN library_character_revisions r ON r.character_id = c.character_id`;

export const currentCharacters = `${characterRevisions}
  AND r.revision = (SELECT MAX(revision) FROM library_character_revisions WHERE character_id = c.character_id)`;

const diaryRevisions = `
  SELECT d.note_id, v.title, v.body, v.diary_date, v.revision, v.has_source_pins, d.project_id,
    c.character_id, c.name AS character_name, c.revision AS character_revision
  FROM library_diaries d
  JOIN library_diary_revisions v ON v.note_id = d.note_id
  LEFT JOIN library_character_revisions c ON c.character_id = d.character_id AND c.revision = d.character_revision
`;

export const diaryDetails = `${diaryRevisions}
  WHERE v.revision = (SELECT MAX(revision) FROM library_diary_revisions WHERE note_id = d.note_id)
`;

export type CharacterRow = {
  character_id: string;
  project_id: string | null;
  name: string;
  persona: string;
  revision: number;
};

export type DiaryRow = {
  note_id: string;
  title: string;
  body: string;
  diary_date: string;
  revision: number;
  has_source_pins: 0 | 1;
  project_id: string | null;
} & (
  | { character_id: null; character_name: null; character_revision: null }
  | { character_id: string; character_name: string; character_revision: number }
);

export function assertStorableText(...values: (string | undefined)[]) {
  // Node SQLite truncates text at NUL on read and replaces unpaired UTF-16 surrogates on write.
  if (values.some(value => value !== undefined && /[\0\p{Surrogate}]/u.test(value))) {
    throw new OperationError(400, 'library_invalid_text', 'Provide well-formed text without NUL characters.');
  }
}

export function displayCharacterName(name: string) {
  return name || '未命名角色';
}

function characterHref(characterId: string, revision?: number) {
  const path = `/characters/${encodeURIComponent(characterId)}`;
  return revision === undefined ? path : `${path}?revision=${revision}`;
}

export function toCharacterLink(row: Omit<CharacterRow, 'persona'>, historical = false) {
  return {
    characterId: row.character_id,
    name: displayCharacterName(row.name),
    revision: row.revision,
    href: characterHref(row.character_id, historical ? row.revision : undefined),
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
  };
}

export function toCharacter(db: DatabaseSync, row: CharacterRow, historical = false) {
  const rows = db.prepare(`SELECT e.entry_id, e.label, b.block_json FROM library_character_entries e
    LEFT JOIN library_character_entry_blocks b ON b.character_id = e.character_id
      AND b.character_revision = e.character_revision AND b.entry_position = e.position
    WHERE e.character_id = ? AND e.character_revision = ? ORDER BY e.position, b.position`)
    .all(row.character_id, row.revision) as { entry_id: string; label: string; block_json: string | null }[];
  const entries = new Map<string, CharacterEntry>();
  for (const { entry_id, label, block_json } of rows) {
    let entry = entries.get(entry_id);
    if (!entry) {
      entry = { entryId: entry_id, label, blocks: [] };
      entries.set(entry_id, entry);
    }
    if (block_json !== null) entry.blocks.push(JSON.parse(block_json) as CharacterBlock);
  }
  return {
    ...toCharacterLink(row, historical),
    ...(row.name === '' ? {} : { authorName: row.name }),
    ...(row.persona === '' ? {} : { description: row.persona }),
    persona: row.persona,
    entries: [...entries.values()],
  };
}

function diaryHref(noteId: string, revision?: number) {
  const path = `/diaries/${encodeURIComponent(noteId)}`;
  return revision === undefined ? path : `${path}?revision=${revision}`;
}

export function toDiary(db: DatabaseSync, row: DiaryRow, historical = false) {
  return {
    noteId: row.note_id,
    title: row.title,
    body: row.body,
    diaryDate: row.diary_date,
    revision: row.revision,
    href: diaryHref(row.note_id, historical ? row.revision : undefined),
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.character_id === null ? {} : {
      character: { characterId: row.character_id, name: displayCharacterName(row.character_name), revision: row.character_revision },
    }),
    ...(row.has_source_pins === 0 ? {} : {
      sourcePins: readSourcePins(db, { kind: 'diary', id: row.note_id, revision: row.revision }),
    }),
  };
}

export function requireProject(db: DatabaseSync, projectId: string) {
  if (!db.prepare('SELECT 1 FROM library_projects WHERE project_id = ?').get(projectId)) {
    throw new OperationError(404, 'project_not_found', `Project ${projectId} was not found.`);
  }
}

export function readCharacterRow(db: DatabaseSync, characterId: string, revision?: number) {
  const row = (revision === undefined
    ? db.prepare(`${currentCharacters} WHERE c.character_id = ?`).get(characterId)
    : db.prepare(`${characterRevisions} WHERE c.character_id = ? AND r.revision = ?`).get(characterId, revision)) as CharacterRow | undefined;
  if (row) return row;
  if (revision !== undefined && db.prepare('SELECT 1 FROM library_characters WHERE character_id = ?').get(characterId)) {
    throw new OperationError(404, 'character_revision_not_found', `Character ${characterId} has no revision ${revision}.`);
  }
  throw new OperationError(404, 'character_not_found', `Character ${characterId} was not found.`);
}

export function readCharacter(db: DatabaseSync, characterId: string, revision?: number) {
  return toCharacter(db, readCharacterRow(db, characterId, revision), revision !== undefined);
}

export function nameKey(name: string) {
  return name.trim().normalize().toLowerCase();
}

export function writeCharacterRevision(
  db: DatabaseSync, characterId: string, revision: number, name: string, persona: string, entries: readonly CharacterEntry[],
) {
  db.prepare(`INSERT INTO library_character_revisions (character_id, revision, name, name_key, persona)
    VALUES (?, ?, ?, ?, ?)`).run(characterId, revision, name, nameKey(displayCharacterName(name)), persona);
  if (entries.length === 0) return;
  const insertEntry = db.prepare(`INSERT INTO library_character_entries
    (character_id, character_revision, position, entry_id, label) VALUES (?, ?, ?, ?, ?)`);
  const insertBlock = db.prepare(`INSERT INTO library_character_entry_blocks
    (character_id, character_revision, entry_position, position, block_json) VALUES (?, ?, ?, ?, ?)`);
  entries.forEach(({ entryId, label, blocks }, position) => {
    insertEntry.run(characterId, revision, position, entryId, label);
    blocks.forEach((block, blockIndex) => insertBlock.run(characterId, revision, position, blockIndex, JSON.stringify(block)));
  });
}

export function readDiary(db: DatabaseSync, noteId: string, revision?: number) {
  const row = revision === undefined
    ? db.prepare(`${diaryDetails} AND d.note_id = ?`).get(noteId)
    : db.prepare(`${diaryRevisions} WHERE d.note_id = ? AND v.revision = ?`).get(noteId, revision);
  if (!row) {
    if (revision !== undefined && db.prepare('SELECT 1 FROM library_diaries WHERE note_id = ?').get(noteId)) {
      throw new OperationError(404, 'diary_revision_not_found', `Diary ${noteId} has no revision ${revision}.`);
    }
    throw new OperationError(404, 'diary_not_found', `Diary ${noteId} was not found.`);
  }
  return toDiary(db, row as DiaryRow, revision !== undefined);
}

export function writeDiaryRevision(db: DatabaseSync, fields: {
  noteId: string; revision: number; title: string; body: string; diaryDate: string; projectId?: string;
  sourcePins?: readonly SourcePin[];
}) {
  const { noteId, revision, title, body, diaryDate, projectId, sourcePins = [] } = fields;
  db.prepare(`INSERT INTO library_diary_revisions (note_id, revision, title, body, diary_date, has_source_pins)
    VALUES (?, ?, ?, ?, ?, ?)`).run(noteId, revision, title, body, diaryDate, Number(sourcePins.length > 0));
  if (sourcePins.length > 0) {
    writeSourcePins(db, { kind: 'diary', id: noteId, revision, title, href: diaryHref(noteId, revision), projectId }, sourcePins);
  }
}
