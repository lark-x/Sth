import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';

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

CREATE TABLE IF NOT EXISTS library_diaries (
  note_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  diary_date TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  project_id TEXT REFERENCES library_projects(project_id),
  character_id TEXT,
  character_revision INTEGER,
  CHECK ((character_id IS NULL) = (character_revision IS NULL)),
  FOREIGN KEY (character_id, character_revision)
    REFERENCES library_character_revisions(character_id, revision)
) STRICT;

CREATE INDEX IF NOT EXISTS library_characters_by_project ON library_characters(project_id, character_id);
CREATE INDEX IF NOT EXISTS library_character_revisions_by_name ON library_character_revisions(name_key, character_id);
CREATE INDEX IF NOT EXISTS library_diaries_by_date ON library_diaries(diary_date DESC, note_id);
CREATE INDEX IF NOT EXISTS library_diaries_by_project ON library_diaries(project_id, diary_date DESC, note_id);
`;

export const currentCharacters = `
  SELECT c.character_id, c.project_id, r.name, r.name_key, r.persona, r.revision
  FROM library_characters c
  JOIN library_character_revisions r ON r.character_id = c.character_id
    AND r.revision = (SELECT MAX(revision) FROM library_character_revisions WHERE character_id = c.character_id)
`;

export const diaryDetails = `
  SELECT d.note_id, d.title, d.body, d.diary_date, d.revision, d.project_id,
    r.character_id, r.name AS character_name, r.revision AS character_revision
  FROM library_diaries d
  LEFT JOIN library_character_revisions r ON r.character_id = d.character_id AND r.revision = d.character_revision
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
  project_id: string | null;
} & (
  | { character_id: null; character_name: null; character_revision: null }
  | { character_id: string; character_name: string; character_revision: number }
);

export function toCharacter(row: CharacterRow) {
  return {
    characterId: row.character_id,
    name: row.name,
    persona: row.persona,
    revision: row.revision,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
  };
}

export function toDiary(row: DiaryRow) {
  return {
    noteId: row.note_id,
    title: row.title,
    body: row.body,
    diaryDate: row.diary_date,
    revision: row.revision,
    href: `/diaries/${row.note_id}`,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.character_id === null ? {} : {
      character: { characterId: row.character_id, name: row.character_name, revision: row.character_revision },
    }),
  };
}

export function requireProject(db: DatabaseSync, projectId: string) {
  if (!db.prepare('SELECT 1 FROM library_projects WHERE project_id = ?').get(projectId)) {
    throw new OperationError(404, 'project_not_found', `Project ${projectId} was not found.`);
  }
}

export function readCharacter(db: DatabaseSync, characterId: string) {
  const row = db.prepare(`${currentCharacters} WHERE c.character_id = ?`).get(characterId);
  if (!row) throw new OperationError(404, 'character_not_found', `Character ${characterId} was not found.`);
  return toCharacter(row as CharacterRow);
}

export function nameKey(name: string) {
  return name.trim().normalize().toLowerCase();
}

export function writeCharacterRevision(
  db: DatabaseSync, characterId: string, revision: number, name: string, persona: string,
) {
  db.prepare(`INSERT INTO library_character_revisions (character_id, revision, name, name_key, persona)
    VALUES (?, ?, ?, ?, ?)`).run(characterId, revision, name, nameKey(name), persona);
}

export function readDiary(db: DatabaseSync, noteId: string) {
  const row = db.prepare(`${diaryDetails} WHERE d.note_id = ?`).get(noteId);
  if (!row) throw new OperationError(404, 'diary_not_found', `Diary ${noteId} was not found.`);
  return toDiary(row as DiaryRow);
}
