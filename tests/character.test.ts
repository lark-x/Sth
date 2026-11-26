import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { Static } from '@sinclair/typebox';
import { assetsDDL, assetOperations } from '../src/assets/index.ts';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { libraryDDL, libraryOperations, readCharacterBacklinks } from '../src/library/index.ts';
import type { character, characterBacklink, CharacterBlock, CharacterReference } from '../src/library/character-contracts.ts';
import { sourcesDDL, sourceOperations, type Source } from '../src/sources/index.ts';
import { storyDDL, storyOperations } from '../src/story/index.ts';
import type { draft, Scene } from '../src/story/contracts.ts';

type Character = Static<typeof character>;
type Backlink = Static<typeof characterBacklink>;
type Draft = Static<typeof draft>;
type Diary = { noteId: string; character?: { characterId: string; name: string; revision: number } };

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(operationsDDL + assetsDDL + libraryDDL + sourcesDDL + storyDDL);
  const core = new Operations(db, [...libraryOperations, ...assetOperations, ...sourceOperations, ...storyOperations]);
  let nextStep = 0;
  function invoke(operationId: string, input: object, stepId = `step-${++nextStep}`) {
    return core.invoke('character-test', { operationId, stepId, input });
  }
  function run<T>(operationId: string, input: object, stepId?: string): T {
    return invoke(operationId, input, stepId).result as T;
  }
  function backlinks(input: object) {
    return run<{ items: Backlink[] }>('character.backlinks', input).items;
  }
  return { db, invoke, run, backlinks };
}

function problem(statusCode: number, code: string) {
  return { name: 'OperationError', statusCode, code };
}

const diaryInput = { title: 'Day one', body: 'I heard the bells.', diaryDate: '2024-02-29' };

test('blank author fields use a display name and can be pinned by a scene and diary', t => {
  const { db, run } = setup(t);
  db.prepare('INSERT INTO library_characters (character_id) VALUES (?)').run('legacy');
  db.prepare('INSERT INTO library_character_revisions VALUES (?, ?, ?, ?, ?)').run('legacy', 1, 'Old Name', 'old name', 'Old persona');
  const legacy = run<Character>('character.read', { characterId: 'legacy', revision: 1 });
  assert.deepEqual(legacy, {
    characterId: 'legacy', revision: 1, name: 'Old Name', authorName: 'Old Name', description: 'Old persona', persona: 'Old persona',
    entries: [], href: '/characters/legacy?revision=1',
  });

  const blank = run<Character>('character.create', {});
  const { characterId } = blank;
  assert.deepEqual(blank, { characterId, revision: 1, name: '未命名角色', persona: '', entries: [], href: `/characters/${characterId}` });
  assert.deepEqual(run('character.list', { name: blank.name }), { items: [blank] });

  const scene = run<Scene>('scene.create', { title: 'At the harbor', characters: [{ characterId, revision: 1 }] });
  const diary = run<Diary>('diary.create', { ...diaryInput, characterId, expectedCharacterRevision: 1 });
  assert.deepEqual(scene.characters, [{ characterId, revision: 1, name: blank.name, persona: '' }]);
  assert.deepEqual(diary.character, { characterId, revision: 1, name: blank.name });

  const named = run<Character>('character.revise', { characterId, expectedRevision: 1, name: ' Lin ', description: 'A sailor.' });
  assert.deepEqual(named, { ...blank, revision: 2, name: 'Lin', authorName: 'Lin', description: 'A sailor.', persona: 'A sailor.' });
  assert.deepEqual(run('character.revise', { characterId, expectedRevision: 2, name: '  ', description: '' }), { ...blank, revision: 3 });
  assert.deepEqual(run('scene.read', { sceneId: scene.sceneId }), scene);
  assert.deepEqual(run('diary.read', { noteId: diary.noteId }), diary);
  assert.deepEqual(run('character.read', { characterId, revision: 1 }), { ...blank, href: `${blank.href}?revision=1` });
  assert.throws(() => run('character.read', { characterId, revision: 4 }), problem(404, 'character_revision_not_found'));
});

test('mixed blocks round trip in order, and entry IDs survive edits, reorder, carry-forward and replay', t => {
  const { run, invoke } = setup(t);
  const image = run<{ assetId: string }>('asset.import', {
    contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ZkAAAAASUVORK5CYII=',
  });
  const audio = run<{ assetId: string }>('asset.import', {
    contentType: 'audio/wav', data: 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==',
  });
  const blocks: CharacterBlock[] = [
    { type: 'text', text: '  Heard at the harbor.\n\n' },
    { type: 'audio', assetId: audio.assetId },
    { type: 'image', assetId: image.assetId },
    { type: 'text', text: 'End.' },
  ];
  const supplied = { entryId: 'empty-section', label: 'Notes', blocks: [] };
  const input = { entries: [{ label: 'Field recording', blocks }, supplied] };
  const first = run<Character>('character.create', input, 'create-mixed');
  const { characterId } = first;
  const [generated] = first.entries;
  assert.ok(generated.entryId);
  assert.deepEqual(first.entries, [{ entryId: generated.entryId, ...input.entries[0] }, supplied]);
  const replay = invoke('character.create', input, 'create-mixed');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first);

  const entries = [supplied, { ...generated, label: 'At the harbor', blocks: [blocks[2], blocks[0], blocks[1]] }];
  const edit = run<Character>('character.revise', { characterId, expectedRevision: 1, entries });
  assert.deepEqual(edit.entries, entries);
  assert.equal(edit.revision, 2);
  assert.deepEqual(run('character.revise', { characterId, expectedRevision: 2, entries }), edit);
  const carry = run<Character>('character.revise', { characterId, expectedRevision: 2, description: 'A sailor.' });
  assert.deepEqual(carry.entries, entries);
  assert.deepEqual(run('character.revise', { characterId, expectedRevision: 3, entries: [] }), { ...carry, revision: 4, entries: [] });
  assert.deepEqual(run('character.read', { characterId, revision: 1 }), { ...first, href: `${first.href}?revision=1` });
  assert.deepEqual(run('character.read', { characterId, revision: 2 }), { ...edit, href: `${edit.href}?revision=2` });

  assert.throws(() => run('character.revise', { characterId, expectedRevision: 4, entries: [supplied, supplied] }),
    problem(400, 'character_duplicate_entry_id'));
  assert.throws(() => run('character.revise', { characterId, expectedRevision: 3, entries }), problem(409, 'character_revision_conflict'));
  for (const [assetId, code, status] of [
    [image.assetId, 'character_asset_kind_mismatch', 400], ['missing', 'asset_not_found', 404],
  ] as const) {
    assert.throws(() => run('character.revise', {
      characterId, expectedRevision: 4, entries: [{ ...supplied, blocks: [{ type: 'audio', assetId }] }],
    }), problem(status, code));
  }
  assert.equal(run<Character>('character.read', { characterId }).revision, 4);
});

test('references pin all supported kinds and backlinks find exact blocks in current and historical owners', t => {
  const { db, run, backlinks } = setup(t);
  const source = run<Source>('source.create', { kind: 'setting', title: 'Sailing timetable', body: 'Last departure\n  at ten.' });
  run('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: 'Last departure at nine.' });
  const scene = run<Scene>('scene.create', { title: 'At the harbor' });
  const draft = run<Draft>('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: 'First pass', body: 'I ran for the ferry.' });
  const adopted = run<Scene>('scene.adopt', { sceneId: scene.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
  const diary = run<Diary>('diary.create', diaryInput);
  const other = run<Character>('character.create', { name: 'Lin', description: 'A sailor.' });
  const reference = (kind: CharacterReference['kind'], id: string, revision: number, excerpt?: string): CharacterReference => ({
    type: 'reference', kind, id, revision, ...(excerpt === undefined ? {} : { excerpt }),
  });
  const sourcePin = reference('source', source.sourceId, 1, 'departure\n  at ten');
  const sourceLink = reference('source', source.sourceId, 1);
  const newerSource = reference('source', source.sourceId, 2, 'at nine');
  const blocks = [
    sourcePin,
    sourceLink,
    reference('scene', scene.sceneId, adopted.revision, 'ran for the ferry'),
    reference('draft', draft.draftId, 1, 'ran for the ferry'),
    reference('diary', diary.noteId, 1),
    reference('character', other.characterId, 1, 'A sailor'),
  ];
  const { projectId } = run<{ projectId: string }>('project.create', { title: 'Harbor' });
  const original = run<Character>('character.create', {
    projectId, name: 'Jo', entries: [{ entryId: 'notes', label: 'Research', blocks }],
  });
  const { characterId } = original;
  assert.deepEqual(original.entries[0].blocks, blocks);
  const lookup = { kind: 'source' as const, id: source.sourceId, revision: 1 };
  const expected = {
    projectId, characterId, revision: 1, name: 'Jo', href: `${original.href}?revision=1`, entryId: 'notes', label: 'Research',
  };
  const oldHits = [{ ...expected, blockIndex: 0, reference: sourcePin }, { ...expected, blockIndex: 1, reference: sourceLink }];
  assert.deepEqual(backlinks(lookup), oldHits);
  assert.deepEqual(readCharacterBacklinks(db, { ...lookup, limit: 1, offset: 1 }), oldHits.slice(1));
  for (const [offset, { kind, id, revision }] of blocks.slice(2).entries()) {
    assert.deepEqual(backlinks({ kind, id, revision }), [{ ...expected, blockIndex: offset + 2, reference: blocks[offset + 2] }]);
  }

  const updated = run<Character>('character.revise', {
    characterId, expectedRevision: 1, entries: [{ entryId: 'notes', label: 'Updated', blocks: [newerSource] }],
  });
  const newHit = {
    ...expected, revision: 2, href: `${original.href}?revision=2`, label: 'Updated', blockIndex: 0, reference: newerSource,
  };
  assert.deepEqual(updated.entries[0].blocks, [newerSource]);
  assert.deepEqual(backlinks({ ...lookup, currentOnly: true }), []);
  assert.deepEqual(backlinks(lookup), oldHits);
  assert.deepEqual(backlinks({ kind: 'source', id: source.sourceId }), [newHit, ...oldHits]);
  assert.deepEqual(backlinks({ ...lookup, revision: 2, currentOnly: true }), [newHit]);
  assert.deepEqual(run('character.read', { characterId, revision: 1 }), { ...original, href: `${original.href}?revision=1` });

  const editWith = (block: CharacterReference) => run('character.revise', {
    characterId, expectedRevision: 2, entries: [{ entryId: 'notes', label: 'Research', blocks: [block] }],
  });
  assert.throws(() => editWith({ ...sourcePin, revision: 2 }), problem(400, 'source_excerpt_mismatch'));
  assert.throws(() => editWith(reference('source', source.sourceId, 1, 'departure at ten')), problem(400, 'source_excerpt_mismatch'));
  assert.throws(() => editWith(reference('draft', draft.draftId, 1, 'I missed the ferry.')),
    problem(400, 'character_reference_excerpt_mismatch'));
  assert.throws(() => editWith(reference('scene', scene.sceneId, 10)), problem(404, 'scene_revision_not_found'));
  assert.deepEqual(run('character.read', { characterId }), updated);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a failed receipt rolls back the ordered entries and backlink index and permits retry', t => {
  const { db, run, backlinks } = setup(t);
  const source = run<Source>('source.create', { kind: 'setting', title: 'Bell', body: 'One ring.' });
  const reference = { type: 'reference', kind: 'source', id: source.sourceId, revision: 1 };
  const input = { entries: [{ label: 'Research', blocks: [reference] }] };
  const lookup = { kind: 'source', id: source.sourceId };
  db.exec(`CREATE TRIGGER fail_character_entry_receipt BEFORE INSERT ON operation_receipts
    WHEN NEW.operation_id = 'character.create'
    BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`);
  assert.throws(() => run('character.create', input, 'retry'), /fixture receipt failure/);
  assert.deepEqual(run('character.list', {}), { items: [] });
  assert.deepEqual(backlinks(lookup), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM library_character_entry_blocks').get()?.count, 0);
  db.exec('DROP TRIGGER fail_character_entry_receipt');
  const character = run<Character>('character.create', input, 'retry');
  assert.equal(backlinks(lookup)[0].entryId, character.entries[0].entryId);
});
