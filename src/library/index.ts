import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Type, type TSchema } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { LinkedSourcePinsSchema, SourcePinsSchema } from '../sources/contracts.ts';
import {
  adoptionEntries, authorEntries, authorFields, character, characterBacklink, characterName, characterSummary, resourceKind,
} from './character-contracts.ts';
import { adoptCharacterEntries, prepareCharacterEntries, readCharacterBacklinks } from './character-entries.ts';
import {
  assertStorableText, currentCharacters, diaryDetails, nameKey, readCharacter, readCharacterRow, readDiary,
  requireProject, toCharacter, toDiary,
  writeCharacterRevision, writeDiaryRevision, type CharacterRow, type DiaryRow,
} from './storage.ts';

export { readCharacterBacklinks } from './character-entries.ts';
export { libraryDDL } from './storage.ts';

const strict = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 128 });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const title = Type.String({ maxLength: 300, pattern: '\\S' });
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
const diary = Type.Object({
  noteId: id, title, body: text, diaryDate, revision, href: Type.String(), projectId,
  character: Type.Optional(Type.Object(characterSummary, strict)),
  sourcePins: Type.Optional(LinkedSourcePinsSchema),
}, strict);

function itemList<T extends TSchema>(item: T) {
  return Type.Object({ items: Type.Array(item, { maxItems: maxLimit }) }, strict);
}

function authorPersona({ description, persona }: { description?: string; persona?: string }) {
  assertStorableText(description, persona);
  if (description !== undefined && persona !== undefined && description !== persona) {
    throw new OperationError(400, 'character_description_conflict', 'Provide the same value for description and persona, or provide one field.');
  }
  const value = description ?? persona;
  return value === undefined || value.trim() ? value : '';
}

function assertDiaryDate(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (date.startsWith('0000') || !Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new OperationError(400, 'diary_date_invalid', 'Provide a valid calendar date in YYYY-MM-DD form.');
  }
}

const resultLink = { hrefField: 'href', labelField: 'title' };
const characterResultLink = { hrefField: 'href', labelField: 'name' };

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
    description: 'Create a character with an optional name, description (also accepted as persona), project, and ordered entries. Entry IDs can be omitted and will be assigned. A personal character can be reused across projects.',
    interaction: { resultLink: characterResultLink },
    inputSchema: Type.Object({ ...authorFields, projectId, entries: authorEntries }, strict), outputSchema: character,
    run(input, { db }) {
      assertStorableText(input.name);
      const persona = authorPersona(input) ?? '';
      if (input.projectId !== undefined) requireProject(db, input.projectId);
      const entries = prepareCharacterEntries(db, input.entries ?? []);
      const characterId = randomUUID();
      db.prepare('INSERT INTO library_characters (character_id, project_id) VALUES (?, ?)')
        .run(characterId, input.projectId ?? null);
      writeCharacterRevision(db, characterId, 1, input.name?.trim() ?? '', persona, entries);
      return readCharacter(db, characterId);
    },
  }),
  defineOperation({
    id: 'character.list', effect: 'read',
    description: 'List characters in ID order. Use name for a case-insensitive exact match and projectId to filter by assignment. Omit projectId to search across all assignments and personal characters. Use limit and offset to page through matches and choose a characterId.',
    inputSchema: Type.Object({ name: Type.Optional(characterName), projectId, ...pagination }, strict),
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
      return { items: rows.map(row => toCharacter(db, row)) };
    },
  }),
  defineOperation({
    id: 'character.read', effect: 'read',
    description: 'Read the current character and its ordered entries by stable ID. Supply revision for a historical snapshot.',
    interaction: { resultLink: characterResultLink },
    inputSchema: Type.Object({ characterId: id, revision: Type.Optional(revision) }, strict), outputSchema: character,
    run: ({ characterId, revision }, { db }) => readCharacter(db, characterId, revision),
  }),
  defineOperation({
    id: 'character.revise', effect: 'write',
    description: 'Revise a character using the current revision as expectedRevision. Omit fields to keep them, use an empty name or description to clear it, and send entries with their entry IDs to preserve identity. Use [] to clear entries.',
    interaction: { resultLink: characterResultLink },
    inputSchema: Type.Object({ characterId: id, expectedRevision: revision, ...authorFields, entries: authorEntries }, strict),
    outputSchema: character,
    run(input, { db }) {
      assertStorableText(input.name);
      const current = readCharacter(db, input.characterId);
      if (current.revision !== input.expectedRevision) {
        throw new OperationError(409, 'character_revision_conflict', `Character is at revision ${current.revision}. Read it before revising.`);
      }
      const previousName = current.authorName ?? '';
      const name = input.name?.trim() ?? previousName;
      const persona = authorPersona(input) ?? current.persona;
      const entries = input.entries === undefined ? current.entries : prepareCharacterEntries(db, input.entries);
      if (previousName === name && current.persona === persona && isDeepStrictEqual(current.entries, entries)) return current;
      writeCharacterRevision(db, input.characterId, current.revision + 1, name, persona, entries);
      return readCharacter(db, input.characterId);
    },
  }),
  defineOperation({
    id: 'character.adopt-entries', effect: 'write',
    description: 'Append only the author-selected entries from exact source or draft passages and pinned judgments. Supply a UTF-16 range (or location) for repeated passages. Identical entries are reused and other character fields are preserved. Supply expectedRevision if the adoption must apply to a particular character revision.',
    interaction: { resultLink: characterResultLink },
    inputSchema: Type.Object({ characterId: id, expectedRevision: Type.Optional(revision), entries: adoptionEntries }, strict),
    outputSchema: character,
    run: (input, { db }) => adoptCharacterEntries(db, input),
  }),
  defineOperation({
    id: 'character.backlinks', effect: 'read',
    description: 'List character entry blocks that link to a source, scene, draft, diary, character or judgment. Filter by target revision, or set currentOnly to return only links in current character versions. Use limit and offset to page.',
    inputSchema: Type.Object({
      kind: resourceKind, id, revision: Type.Optional(revision), currentOnly: Type.Optional(Type.Boolean()), ...pagination,
    }, strict),
    outputSchema: itemList(characterBacklink),
    run(input, { db }) {
      return { items: readCharacterBacklinks(db, input) };
    },
  }),
  defineOperation({
    id: 'diary.create', effect: 'write',
    description: 'Save a diary with a YYYY-MM-DD date. For a character diary, use character.read and supply both its characterId and current expectedCharacterRevision. An assigned character sets the diary project if omitted. A personal character can be used in any project. To cite sources, provide sourcePins with a sourceId, revision, and exact excerpt from source.read.',
    interaction: { localDateField: 'diaryDate', resultLink },
    inputSchema: Type.Object({
      title, body: text, diaryDate, characterId: Type.Optional(id), expectedCharacterRevision: Type.Optional(revision), projectId,
      sourcePins: Type.Optional(SourcePinsSchema),
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
        const current = readCharacterRow(db, input.characterId);
        if (current.project_id !== null && projectId !== undefined && current.project_id !== projectId) {
          throw new OperationError(409, 'character_project_mismatch', 'The character belongs to a different project.');
        }
        if (current.revision !== input.expectedCharacterRevision) {
          throw new OperationError(409, 'character_revision_conflict', `Character is at revision ${current.revision}. Read it before creating a diary.`);
        }
        projectId ??= current.project_id ?? undefined;
      }
      if (projectId !== undefined) requireProject(db, projectId);
      const noteId = randomUUID();
      db.prepare(`INSERT INTO library_diaries (note_id, project_id, character_id, character_revision)
        VALUES (?, ?, ?, ?)`).run(noteId, projectId ?? null, input.characterId ?? null, input.expectedCharacterRevision ?? null);
      writeDiaryRevision(db, { ...input, noteId, revision: 1, title: input.title.trim(), projectId });
      return readDiary(db, noteId);
    },
  }),
  defineOperation({
    id: 'diary.read', effect: 'read', description: 'Read the latest diary by its noteId or supply revision to read a historical version. Includes pinned character and linked source versions when present.',
    interaction: { resultLink },
    inputSchema: Type.Object({ noteId: id, revision: Type.Optional(revision) }, strict), outputSchema: diary,
    run: ({ noteId, revision }, { db }) => readDiary(db, noteId, revision),
  }),
  defineOperation({
    id: 'diary.list', effect: 'read',
    description: 'List diaries by newest diary date first. Filter by projectId or omit it to include all projects and personal diaries. Use limit and offset to get more diaries.',
    inputSchema: Type.Object({ projectId, ...pagination }, strict), outputSchema: itemList(diary),
    run({ projectId, limit = defaultLimit, offset = 0 }, { db }) {
      const where = projectId === undefined ? '' : 'AND d.project_id = ?';
      const parameters = projectId === undefined ? [] : [projectId];
      const rows = db.prepare(`${diaryDetails} ${where} ORDER BY v.diary_date DESC, d.note_id LIMIT ? OFFSET ?`)
        .all(...parameters, limit, offset) as DiaryRow[];
      return { items: rows.map(row => toDiary(db, row)) };
    },
  }),
  defineOperation({
    id: 'diary.revise', effect: 'write',
    description: 'Revise a diary title, body, and date using its current revision as expectedRevision. The diary keeps its project and character pin. Omit sourcePins to carry the old pins forward, or provide a replacement list. Use [] to clear pins from the new revision.',
    interaction: { localDateField: 'diaryDate', resultLink },
    inputSchema: Type.Object({
      noteId: id, title, body: text, diaryDate, expectedRevision: revision, sourcePins: Type.Optional(SourcePinsSchema),
    }, strict),
    outputSchema: diary,
    run(input, { db }) {
      assertStorableText(input.title, input.body);
      assertDiaryDate(input.diaryDate);
      const current = readDiary(db, input.noteId);
      if (current.revision !== input.expectedRevision) {
        throw new OperationError(409, 'diary_revision_conflict', `Diary is at revision ${current.revision}. Read it before revising.`);
      }
      const title = input.title.trim();
      const previousPins = (current.sourcePins ?? []).map(({ href: _, ...pin }) => pin);
      const sourcePins = input.sourcePins ?? previousPins;
      const samePins = isDeepStrictEqual(sourcePins, previousPins);
      if (title === current.title && input.body === current.body && input.diaryDate === current.diaryDate && samePins) return current;
      writeDiaryRevision(db, { ...input, revision: current.revision + 1, title, projectId: current.projectId, sourcePins });
      return readDiary(db, input.noteId);
    },
  }),
];
