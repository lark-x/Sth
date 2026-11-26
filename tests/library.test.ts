import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Operations, operationsDDL } from '../src/core/index.ts';
import type { CharacterEntry } from '../src/library/character-contracts.ts';
import { libraryDDL, libraryOperations } from '../src/library/index.ts';

type Project = { projectId: string; title: string };
type CharacterSummary = { characterId: string; name: string; revision: number };
type Character = CharacterSummary & {
  authorName?: string; description?: string; persona: string; entries: CharacterEntry[]; href: string; projectId?: string;
};
type Diary = {
  noteId: string; title: string; body: string; diaryDate: string; revision: number; href: string;
  projectId?: string; character?: CharacterSummary;
};

const entry = { title: 'Harbor night', body: '  I watched the ship arrive.\n\nThen it rained.\n', diaryDate: '2024-02-29' };

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(operationsDDL);
  db.exec(libraryDDL);
  const core = new Operations(db, libraryOperations);
  let nextStep = 0;
  function invoke(operationId: string, input: object, stepId = `step-${++nextStep}`) {
    return core.invoke('library-test', { operationId, stepId, input });
  }
  function run<T>(operationId: string, input: object, stepId?: string): T {
    return invoke(operationId, input, stepId).result as T;
  }
  return { db, core, invoke, run };
}

function operationError(statusCode: number, code: string) {
  return { name: 'OperationError', statusCode, code };
}

test('diaries retain the character version they were written with across both kinds of revision', t => {
  const { core, run, invoke } = setup(t);
  const { operations } = core.catalog();
  assert.deepEqual(operations.map(({ id, effect }) => [id, effect]), [
    ['project.create', 'write'], ['project.list', 'read'], ['character.create', 'write'],
    ['character.list', 'read'], ['character.read', 'read'], ['character.revise', 'write'], ['character.adopt-entries', 'write'], ['character.backlinks', 'read'],
    ['diary.create', 'write'], ['diary.read', 'read'], ['diary.list', 'read'], ['diary.revise', 'write'],
  ]);
  assert.deepEqual(operations.find(operation => operation.id === 'diary.create')?.interaction, {
    localDateField: 'diaryDate', resultLink: { hrefField: 'href', labelField: 'title' },
  });
  const project = run<Project>('project.create', { title: ' Harbor ' });
  const { projectId } = project;
  assert.deepEqual(project, { projectId, title: 'Harbor' });
  assert.deepEqual(run('project.list', {}), { items: [project] });

  const created = run<Character>('character.create', { name: ' Lin ', persona: 'A sailor.', projectId });
  const { characterId } = created;
  assert.deepEqual(created, {
    characterId, name: 'Lin', authorName: 'Lin', description: 'A sailor.', persona: 'A sailor.',
    projectId, revision: 1, entries: [], href: `/characters/${characterId}`,
  });
  assert.deepEqual(run('character.read', { characterId }), created);

  const input = { ...entry, characterId, projectId, expectedCharacterRevision: 1 };
  const original = run<Diary>('diary.create', input, 'write-original');
  const { noteId } = original;
  assert.deepEqual(original, {
    ...entry, noteId, href: `/diaries/${noteId}`, revision: 1, projectId,
    character: { characterId, name: 'Lin', revision: 1 },
  });

  const newPersona = { characterId, name: 'Captain Lin', persona: 'A captain.' };
  const revised = run<Character>('character.revise', { ...newPersona, expectedRevision: 1 });
  assert.deepEqual(revised, { ...created, ...newPersona, authorName: newPersona.name, description: newPersona.persona, revision: 2 });
  assert.deepEqual(run('character.read', { characterId }), revised);
  assert.throws(() => run('character.revise', { ...newPersona, expectedRevision: 1 }),
    operationError(409, 'character_revision_conflict'));
  assert.throws(() => run('diary.create', input), operationError(409, 'character_revision_conflict'));
  assert.deepEqual(run('character.list', { name: 'Lin' }), { items: [] });
  assert.deepEqual(run('character.list', { name: 'Captain Lin' }), { items: [revised] });

  assert.deepEqual(run('diary.read', { noteId }), original);
  const edit = { title: 'Storm at the harbor', body: 'It rained all night.', diaryDate: '2024-03-01' };
  const updated = run<Diary>('diary.revise', { ...edit, noteId, expectedRevision: 1 });
  assert.deepEqual(updated, { ...original, ...edit, revision: 2 });
  assert.deepEqual(run('diary.revise', { ...edit, noteId, expectedRevision: 2 }), updated);
  assert.throws(() => run('diary.revise', { ...edit, noteId, expectedRevision: 1 }),
    operationError(409, 'diary_revision_conflict'));
  assert.deepEqual(run('diary.read', { noteId }), updated);

  const followup = run<Diary>('diary.create', { ...input, expectedCharacterRevision: 2 });
  assert.notEqual(followup.noteId, noteId);
  assert.deepEqual(followup.character, { characterId, name: 'Captain Lin', revision: 2 });
  assert.deepEqual(run('diary.list', { projectId }), { items: [updated, followup] });
  const replay = invoke('diary.create', input, 'write-original');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, original);
});

test('project filters expose same-name matches and personal characters can be reused', t => {
  const { run } = setup(t);
  const { projectId: harbor } = run<Project>('project.create', { title: 'Harbor' });
  const { projectId: inland } = run<Project>('project.create', { title: 'Inland' });
  const character = { name: 'Lin', persona: 'A navigator.' };
  const personal = run<Character>('character.create', character);
  const assigned = run<Character>('character.create', { ...character, projectId: harbor });
  const second = run<Character>('character.create', { ...character, projectId: harbor, persona: 'A diver.' });
  assert.equal(Object.hasOwn(personal, 'projectId'), false);
  const { items } = run<{ items: Character[] }>('character.list', { name: '  LIN  ' });
  assert.equal(items.length, 3);
  assert.deepEqual(new Set(items), new Set([personal, assigned, second]));
  const scoped = run<{ items: Character[] }>('character.list', { name: 'Lin', projectId: harbor });
  assert.deepEqual(new Set(scoped.items), new Set([assigned, second]));

  const assignedPin = { characterId: assigned.characterId, expectedCharacterRevision: 1 };
  assert.throws(() => run('diary.create', { ...entry, ...assignedPin, projectId: inland }),
    operationError(409, 'character_project_mismatch'));
  const inherited = run<Diary>('diary.create', { ...entry, ...assignedPin });
  assert.equal(inherited.projectId, harbor);

  const personalPin = { characterId: personal.characterId, expectedCharacterRevision: 1 };
  for (const projectId of [harbor, inland]) {
    const reused = run<Diary>('diary.create', { ...entry, ...personalPin, projectId });
    assert.equal(reused.projectId, projectId);
    assert.deepEqual(reused.character, { characterId: personal.characterId, name: personal.name, revision: 1 });
  }
  const plain = run<Diary>('diary.create', entry);
  assert.deepEqual(plain, { ...entry, noteId: plain.noteId, revision: 1, href: `/diaries/${plain.noteId}` });
  const personalDiary = run<Diary>('diary.create', { ...entry, ...personalPin });
  assert.equal(Object.hasOwn(personalDiary, 'projectId'), false);
  assert.deepEqual(personalDiary.character, { characterId: personal.characterId, name: personal.name, revision: 1 });
  const projectDiary = run<Diary>('diary.create', { ...entry, projectId: inland });
  assert.equal(projectDiary.projectId, inland);
  assert.equal(Object.hasOwn(projectDiary, 'character'), false);
  assert.equal(run<{ items: Diary[] }>('diary.list', {}).items.length, 6);
  assert.equal(run<{ items: Diary[] }>('diary.list', { projectId: harbor }).items.length, 2);
  const inlandDiaries = run<{ items: Diary[] }>('diary.list', { projectId: inland }).items;
  assert.equal(inlandDiaries.length, 2);
  assert.ok(inlandDiaries.every(diary => diary.projectId === inland));
});

test('validates dates, references, and paired version inputs without writing a diary', t => {
  const { run } = setup(t);
  const { characterId } = run<Character>('character.create', { name: 'Lin', persona: 'A sailor.' });
  for (const diaryDate of ['0000-01-01', '1900-02-29', '2024-04-31', '2024-13-01']) {
    assert.throws(() => run('diary.create', { ...entry, diaryDate }), operationError(400, 'diary_date_invalid'));
  }
  assert.throws(() => run('diary.create', { ...entry, diaryDate: '2024-2-29' }),
    operationError(400, 'operation_invalid_input'));
  assert.throws(() => run('diary.create', { ...entry, characterId }), operationError(400, 'diary_character_revision_required'));
  assert.throws(() => run('diary.create', { ...entry, expectedCharacterRevision: 1 }),
    operationError(400, 'diary_character_required'));
  assert.throws(() => run('diary.create', { ...entry, characterId: 'missing', expectedCharacterRevision: 1 }),
    operationError(404, 'character_not_found'));
  assert.throws(() => run('diary.create', { ...entry, projectId: 'missing' }), operationError(404, 'project_not_found'));
  assert.throws(() => run('character.create', { name: 'Lin', persona: 'A sailor.', projectId: 'missing' }),
    operationError(404, 'project_not_found'));
  assert.throws(() => run('diary.read', { noteId: 'missing' }), operationError(404, 'diary_not_found'));
  assert.throws(() => run('diary.create', { ...entry, body: 'before\0after' }), operationError(400, 'library_invalid_text'));
  assert.deepEqual(run('diary.list', {}), { items: [] });

  const diary = run<Diary>('diary.create', { ...entry, diaryDate: '2000-02-29' });
  assert.throws(() => run('diary.revise', { ...entry, noteId: diary.noteId, expectedRevision: 1, diaryDate: '2023-02-29' }),
    operationError(400, 'diary_date_invalid'));
  assert.deepEqual(run('diary.read', { noteId: diary.noteId }), diary);
});

test('all lists have bounded pages and can discover items beyond the first page', t => {
  const { run } = setup(t);
  for (let index = 0; index < 53; index++) {
    run('project.create', { title: `Project ${index}` });
    run('character.create', { name: 'Lin', persona: `Persona ${index}` });
    run('diary.create', { ...entry, title: `Diary ${index}` });
  }

  for (const [operation, id, filter] of [
    ['project.list', 'projectId', {}], ['character.list', 'characterId', { name: 'Lin' }], ['diary.list', 'noteId', {}],
  ] as const) {
    function page(options = {}) {
      return run<{ items: Record<string, string>[] }>(operation, { ...filter, ...options }).items.map(item => item[id]);
    }
    const first = page({ limit: 50 });
    const last = page({ limit: 50, offset: 50 });
    assert.equal(first.length, 50);
    assert.equal(last.length, 3);
    assert.equal(new Set([...first, ...last]).size, 53);
    assert.deepEqual(page(), first.slice(0, 20));
    assert.deepEqual(page({ limit: 50, offset: 53 }), []);
    assert.throws(() => page({ limit: 51 }), operationError(400, 'operation_invalid_input'));
    assert.throws(() => page({ offset: -1 }), operationError(400, 'operation_invalid_input'));
  }
});

test('a failed operation receipt rolls back a character write and allows retry', t => {
  const { db, run } = setup(t);
  const input = { name: 'Lin', persona: 'A sailor.' };
  db.exec(`CREATE TRIGGER fail_character_receipt BEFORE INSERT ON operation_receipts
    WHEN NEW.operation_id = 'character.create'
    BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`);
  assert.throws(() => run('character.create', input, 'create-lin'), /fixture receipt failure/);
  assert.deepEqual(run('character.list', {}), { items: [] });
  assert.equal(db.prepare('SELECT count(*) AS total FROM library_characters').get()?.total, 0);
  db.exec('DROP TRIGGER fail_character_receipt');
  const character = run<Character>('character.create', input, 'create-lin');
  assert.deepEqual(run('character.list', {}), { items: [character] });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
