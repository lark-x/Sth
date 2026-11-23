import { randomUUID } from 'node:crypto';
import { Type, type TSchema } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import {
  currentCharacters, diaryDetails, nameKey, readCharacter, readDiary, requireProject, toCharacter, toDiary,
  writeCharacterRevision, type CharacterRow, type DiaryRow,
} from './storage.ts';

export { libraryDDL } from './storage.ts';

const strict = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 128 });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const title = Type.String({ maxLength: 300, pattern: '\\S' });
const name = Type.String({ maxLength: 300, pattern: '\\S' });
const text = Type.String({ maxLength: 100_000, pattern: '\\S' });
const diaryDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const projectId = Type.Optional(id);

const defaultLimit = 20;
const maxLimit = 50;
const pagination = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxLimit, default: defaultLimit })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 })),
};

const project = Type.Object({ projectId: id, title }, strict);
const characterSummary = { characterId: id, name, revision };
const character = Type.Object({ ...characterSummary, persona: text, projectId }, strict);
const diary = Type.Object({
  noteId: id, title, body: text, diaryDate, revision, href: Type.String(), projectId,
  character: Type.Optional(Type.Object(characterSummary, strict)),
}, strict);

function itemList<T extends TSchema>(item: T) {
  return Type.Object({ items: Type.Array(item, { maxItems: maxLimit }) }, strict);
}

function assertStorableText(...values: string[]) {
  // Node SQLite truncates text at NUL on read and replaces unpaired UTF-16 surrogates on write.
  if (values.some(value => /[\0\p{Surrogate}]/u.test(value))) {
    throw new OperationError(400, 'library_invalid_text', 'Provide well-formed text without NUL characters.');
  }
}

function assertDiaryDate(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (date.startsWith('0000') || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new OperationError(400, 'diary_date_invalid', 'Provide a valid calendar date in YYYY-MM-DD form.');
  }
}

const resultLink = { hrefField: 'href', labelField: 'title' };

export const libraryOperations = [
  defineOperation({
    id: 'project.create', effect: 'write', description: 'Create a project with a title.',
    inputSchema: Type.Object({ title }, strict), outputSchema: project,
    run(input, { db }) {
      assertStorableText(input.title);
      const result = { projectId: randomUUID(), title: input.title.trim() };
      db.prepare('INSERT INTO library_projects (project_id, title) VALUES (?, ?)').run(result.projectId, result.title);
      return result;
    },
  }),
  defineOperation({
    id: 'project.list', effect: 'read', description: 'List projects in ID order. Use limit and offset to get more projects.',
    inputSchema: Type.Object(pagination, strict), outputSchema: itemList(project),
    run({ limit = defaultLimit, offset = 0 }, { db }) {
      const rows = db.prepare('SELECT project_id, title FROM library_projects ORDER BY project_id LIMIT ? OFFSET ?')
        .all(limit, offset) as { project_id: string; title: string }[];
      return { items: rows.map(row => ({ projectId: row.project_id, title: row.title })) };
    },
  }),
  defineOperation({
    id: 'character.create', effect: 'write',
    description: 'Create a character with a persona and optional project assignment. A personal character can be reused across projects.',
    inputSchema: Type.Object({ name, persona: text, projectId }, strict), outputSchema: character,
    run(input, { db }) {
      assertStorableText(input.name, input.persona);
      if (input.projectId !== undefined) requireProject(db, input.projectId);
      const characterId = randomUUID();
      db.prepare('INSERT INTO library_characters (character_id, project_id) VALUES (?, ?)')
        .run(characterId, input.projectId ?? null);
      writeCharacterRevision(db, characterId, 1, input.name.trim(), input.persona);
      return readCharacter(db, characterId);
    },
  }),
  defineOperation({
    id: 'character.list', effect: 'read',
    description: 'List characters in ID order. Use name for a case-insensitive exact match and projectId to filter by assignment. Omit projectId to search across all assignments and personal characters. Use limit and offset to page through matches and choose a characterId.',
    inputSchema: Type.Object({ name: Type.Optional(name), projectId, ...pagination }, strict),
    outputSchema: itemList(character),
    run({ name, projectId, limit = defaultLimit, offset = 0 }, { db }) {
      const conditions: string[] = [];
      const parameters: string[] = [];
      if (name !== undefined) {
        assertStorableText(name);
        conditions.push('r.name_key = ?');
        parameters.push(nameKey(name));
      }
      if (projectId !== undefined) {
        conditions.push('c.project_id = ?');
        parameters.push(projectId);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(`${currentCharacters} ${where} ORDER BY c.character_id LIMIT ? OFFSET ?`)
        .all(...parameters, limit, offset) as CharacterRow[];
      return { items: rows.map(toCharacter) };
    },
  }),
  defineOperation({
    id: 'character.read', effect: 'read', description: 'Read a character by its stable ID, including the current persona and revision.',
    inputSchema: Type.Object({ characterId: id }, strict), outputSchema: character,
    run: ({ characterId }, { db }) => readCharacter(db, characterId),
  }),
  defineOperation({
    id: 'character.revise', effect: 'write',
    description: 'Update a character name and persona using the current revision as expectedRevision. Existing diaries keep their pinned versions.',
    inputSchema: Type.Object({ characterId: id, name, persona: text, expectedRevision: revision }, strict), outputSchema: character,
    run(input, { db }) {
      assertStorableText(input.name, input.persona);
      const current = readCharacter(db, input.characterId);
      if (current.revision !== input.expectedRevision) {
        throw new OperationError(409, 'character_revision_conflict', `Character is at revision ${current.revision}. Read it before revising.`);
      }
      const name = input.name.trim();
      if (current.name === name && current.persona === input.persona) return current;
      writeCharacterRevision(db, input.characterId, current.revision + 1, name, input.persona);
      return readCharacter(db, input.characterId);
    },
  }),
  defineOperation({
    id: 'diary.create', effect: 'write',
    description: 'Save a diary with a YYYY-MM-DD date. For a character diary, use character.read and supply both its characterId and current expectedCharacterRevision. An assigned character sets the diary project if omitted. A personal character can be used in any project.',
    interaction: { localDateField: 'diaryDate', resultLink },
    inputSchema: Type.Object({
      title, body: text, diaryDate, characterId: Type.Optional(id), expectedCharacterRevision: Type.Optional(revision), projectId,
    }, strict),
    outputSchema: diary,
    run(input, { db }) {
      assertStorableText(input.title, input.body);
      assertDiaryDate(input.diaryDate);
      let projectId = input.projectId;
      if (input.characterId === undefined) {
        if (input.expectedCharacterRevision !== undefined) {
          throw new OperationError(400, 'diary_character_required', 'Provide characterId with expectedCharacterRevision.');
        }
      } else {
        if (input.expectedCharacterRevision === undefined) {
          throw new OperationError(400, 'diary_character_revision_required', 'Provide expectedCharacterRevision with characterId.');
        }
        const current = readCharacter(db, input.characterId);
        if (current.projectId !== undefined && projectId !== undefined && current.projectId !== projectId) {
          throw new OperationError(409, 'character_project_mismatch', 'The character belongs to a different project.');
        }
        if (current.revision !== input.expectedCharacterRevision) {
          throw new OperationError(409, 'character_revision_conflict', `Character is at revision ${current.revision}. Read it before creating a diary.`);
        }
        projectId ??= current.projectId;
      }
      if (projectId !== undefined) requireProject(db, projectId);
      const noteId = randomUUID();
      db.prepare(`INSERT INTO library_diaries (note_id, title, body, diary_date, project_id, character_id, character_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        noteId, input.title.trim(), input.body, input.diaryDate, projectId ?? null,
        input.characterId ?? null, input.expectedCharacterRevision ?? null,
      );
      return readDiary(db, noteId);
    },
  }),
  defineOperation({
    id: 'diary.read', effect: 'read', description: 'Read a diary by its noteId, including its pinned character version when present.',
    interaction: { resultLink },
    inputSchema: Type.Object({ noteId: id }, strict), outputSchema: diary,
    run: ({ noteId }, { db }) => readDiary(db, noteId),
  }),
  defineOperation({
    id: 'diary.list', effect: 'read',
    description: 'List diaries by newest diary date first. Filter by projectId or omit it to include all projects and personal diaries. Use limit and offset to get more diaries.',
    inputSchema: Type.Object({ projectId, ...pagination }, strict), outputSchema: itemList(diary),
    run({ projectId, limit = defaultLimit, offset = 0 }, { db }) {
      const where = projectId === undefined ? '' : 'WHERE d.project_id = ?';
      const parameters = projectId === undefined ? [] : [projectId];
      const rows = db.prepare(`${diaryDetails} ${where} ORDER BY d.diary_date DESC, d.note_id LIMIT ? OFFSET ?`)
        .all(...parameters, limit, offset) as DiaryRow[];
      return { items: rows.map(toDiary) };
    },
  }),
  defineOperation({
    id: 'diary.revise', effect: 'write',
    description: 'Revise a diary title, body, and date using its current revision as expectedRevision. The diary keeps its project and character pin.',
    interaction: { localDateField: 'diaryDate', resultLink },
    inputSchema: Type.Object({ noteId: id, title, body: text, diaryDate, expectedRevision: revision }, strict), outputSchema: diary,
    run(input, { db }) {
      assertStorableText(input.title, input.body);
      assertDiaryDate(input.diaryDate);
      const current = readDiary(db, input.noteId);
      if (current.revision !== input.expectedRevision) {
        throw new OperationError(409, 'diary_revision_conflict', `Diary is at revision ${current.revision}. Read it before revising.`);
      }
      const title = input.title.trim();
      if (title === current.title && input.body === current.body && input.diaryDate === current.diaryDate) return current;
      db.prepare('UPDATE library_diaries SET title = ?, body = ?, diary_date = ?, revision = revision + 1 WHERE note_id = ?')
        .run(title, input.body, input.diaryDate, input.noteId);
      return readDiary(db, input.noteId);
    },
  }),
];
