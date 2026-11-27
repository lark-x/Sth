import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Operations, operationsDDL } from '../../src/core/index.ts';
import { openDatabase } from '../../src/database.ts';
import { generationDDL, generationOperations } from '../../src/generation/index.ts';
import { libraryDDL, libraryOperations } from '../../src/library/index.ts';
import { sourcesDDL, sourceOperations } from '../../src/sources/index.ts';
import { storyDDL, storyOperations } from '../../src/story/index.ts';
import { evidenceHref, referenceQuotes } from './evidence-model.ts';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON; ${operationsDDL}${libraryDDL}${sourcesDDL}${storyDDL}${generationDDL}`);
  const registry = new Operations(db, [...libraryOperations, ...sourceOperations, ...storyOperations, ...generationOperations]);
  const call = (operationId, input, stepId = randomUUID()) =>
    registry.invoke('evidence-test', { operationId, input, stepId }).result;
  const scene = call('scene.create', { title: '雨夜的渡口' });
  const draft = call('draft.create', { sceneId: scene.sceneId, sceneRevision: scene.revision, title: '渡口初稿', body: '雨😀停了。\n他仍留在岸上。' });
  const target = { sceneId: scene.sceneId, sceneRevision: scene.revision };
  const prepare = (extra = {}) => call('generations.prepare', {
    title: '渡口组稿', brief: '写下等船的人。', templateId: 'short-story', manuscript: target, ...extra,
  });
  const list = (extra = {}) => call('generations.evidence.list', { ...target, ...extra });
  const forDraft = (value = draft) => list({ draftId: value.draftId, draftRevision: value.revision });
  const finish = generationId => call('generations.save', {
    generationId, output: { opening: '雨停了。', development: '他等船。', ending: '钟响了。' },
  });
  return { db, call, scene, draft, target, prepare, list, forDraft, finish };
}

test('evidence never infers a draft origin from scene links or a draft used as an input', t => {
  const { call, draft, prepare, list, forDraft } = fixture(t);
  const record = prepare({ references: [{ kind: 'draft', id: draft.draftId, revision: draft.revision }] });
  assert.equal(list().items[0].generation.generationId, record.generationId);
  assert.equal(list().items[0].relation, 'prepared-for-scene');
  assert.deepEqual(forDraft().items, []);
  assert.deepEqual(call('generations.evidence.list', { sceneId: draft.sceneId, sceneRevision: 1, offset: 1 }).items, []);
  assert.throws(() => call('generations.evidence.list', { sceneId: draft.sceneId, sceneRevision: 1, draftId: draft.draftId }),
    { code: 'generation_manuscript_revision_required' });
});

test('selected source ranges and people remain exact snapshots without changing scene associations', t => {
  const { call, scene, prepare } = fixture(t);
  const source = call('source.create', { title: '公告', kind: 'excerpt', body: '钟声。旧公告。钟声。' });
  const character = call('character.create', { name: '等船人', persona: '始终不肯离开。' });
  const record = prepare({ references: [
    { kind: 'source', id: source.sourceId, revision: 1, excerpt: '钟声。', range: { start: 7, end: 10 } },
    { kind: 'character', id: character.characterId, revision: 1 },
  ] });
  call('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '新的公告。' });
  call('character.revise', { characterId: character.characterId, expectedRevision: 1, persona: '已经离开。' });
  const saved = call('generations.get', { generationId: record.generationId });
  assert.deepEqual(saved.composition.references, record.composition.references);
  assert.match(String(saved.composition.messages[1].content), /始终不肯离开/);
  assert.equal(referenceQuotes(saved.composition.references[0])[0].text, '钟声。');
  assert.match(referenceQuotes(saved.composition.references[0])[0].href, /revision=1&start=7&end=10$/);
  const unchanged = call('scene.read', { sceneId: scene.sceneId });
  assert.deepEqual(unchanged.sources, []);
  assert.deepEqual(unchanged.characters, []);
});

test('an association requires a completed result and explicit confirmation and rejects another target atomically', t => {
  const { db, call, draft, prepare, finish, forDraft } = fixture(t);
  const record = prepare();
  const input = { generationId: record.generationId, draftId: draft.draftId, draftRevision: 1, authorConfirmed: true };
  assert.throws(() => call('generations.evidence.attach', input), { code: 'generation_manuscript_result_required' });
  finish(record.generationId);
  assert.throws(() => call('generations.evidence.attach', { ...input, authorConfirmed: false }));
  const other = call('scene.create', { title: '另一个渡口' });
  const wrong = call('draft.create', { sceneId: other.sceneId, sceneRevision: 1, title: '异处', body: '此处无船。' });
  assert.throws(() => call('generations.evidence.attach', { ...input, draftId: wrong.draftId }), { code: 'generation_manuscript_scope_mismatch' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM generation_manuscript_drafts').get().n, 0);
  call('generations.evidence.attach', input, 'confirm-exact-draft');
  call('generations.evidence.attach', input, 'confirm-exact-draft');
  assert.equal(forDraft().items[0].relation, 'author-confirmed');
  assert.equal(forDraft().items[0].generation.generationId, record.generationId);
  const next = prepare(); finish(next.generationId);
  assert.throws(() => call('generations.evidence.attach', { ...input, generationId: next.generationId }), { code: 'generation_manuscript_already_attached' });
});

test('only explicit valid UTF-16 passage relationships are exposed and revisions do not inherit them', t => {
  const { call, draft, prepare, finish, forDraft } = fixture(t);
  const record = prepare({ references: [{ kind: 'draft', id: draft.draftId, revision: 1 }] });
  finish(record.generationId);
  const input = { generationId: record.generationId, draftId: draft.draftId, draftRevision: 1, authorConfirmed: true };
  for (const passage of [{ start: 1, end: 2, referenceIndex: 0 }, { start: 0, end: 999, referenceIndex: 0 },
    { start: 0, end: 1, referenceIndex: 1 }, { start: 6, end: 7, referenceIndex: 0 }]) {
    assert.throws(() => call('generations.evidence.attach', { ...input, passages: [passage] }), { code: 'generation_manuscript_passage_invalid' });
  }
  const passages = [{ start: 1, end: 3, referenceIndex: 0 }];
  call('generations.evidence.attach', { ...input, passages });
  assert.deepEqual(forDraft().items[0].passages, passages);
  call('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: '全新的文字。' });
  assert.deepEqual(forDraft({ ...draft, revision: 2 }).items, []);
  assert.equal(forDraft().items[0].generation.generationId, record.generationId);
});

test('legacy records stay readable and can be explicitly associated without changing their prompt', t => {
  const { db, call, target, draft, prepare, finish, forDraft } = fixture(t);
  const record = call('generations.prepare', { title: '早期组稿', brief: '早期写作要求', templateId: 'short-story' });
  finish(record.generationId);
  const prompt = call('generations.prompt', { generationId: record.generationId });
  call('generations.evidence.attach', { generationId: record.generationId, draftId: draft.draftId, draftRevision: 1, authorConfirmed: true });
  db.exec(generationDDL);
  assert.deepEqual(call('generations.prompt', { generationId: record.generationId }), prompt);
  assert.equal(forDraft().items[0].generation.generationId, record.generationId);
  assert.equal(db.prepare('SELECT scene_id FROM generation_manuscript_targets WHERE generation_id = ?').get(record.generationId).scene_id, target.sceneId);
});

test('a delegated generation retains its explicit scene preparation target', t => {
  const { call, prepare, list } = fixture(t);
  const record = prepare();
  const plan = call('generation.plans.create', { title: '另写一稿', executor: 'openai-compatible', provider: 'test', model: 'fixture', parameters: {} });
  const delegated = call('generations.start', { generationId: record.generationId, planId: plan.planId });
  assert.deepEqual(new Set(list().items.map(item => item.generation.generationId)), new Set([record.generationId, delegated.generationId]));
  assert.equal(list({ limit: 1 }).hasMore, true);
  assert.equal(list({ limit: 1, offset: 1 }).hasMore, false);
});

test('source text alone never invents paragraph coordinates or trusts arbitrary URLs', () => {
  const reference = { kind: 'source', id: 'a/b', revision: 2, title: '相同原句', excerpt: '钟声。',
    href: 'javascript:alert(1)', content: { body: '钟声。' } };
  assert.equal(referenceQuotes(reference)[0].href, '/sources/a%2Fb?revision=2');
  assert.equal(evidenceHref('source', 'x', 1, { start: 4, end: 4 }), '/sources/x?revision=1');
  assert.equal(evidenceHref('unknown', 'x', 1), undefined);
});

test('existing format-4 workspaces acquire evidence tables on reopen and retain old generation bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-evidence-migration-'));
  let db;
  try {
    db = openDatabase(directory);
    const registry = new Operations(db, generationOperations);
    const old = registry.invoke('migration-test', { operationId: 'generations.prepare', stepId: 'prepare-before-upgrade',
      input: { title: '已有组稿', brief: '保留旧输入。', templateId: 'short-story' } }).result;
    const before = db.prepare('SELECT composition_json FROM generation_records WHERE generation_id = ?').get(old.generationId).composition_json;
    db.exec('DROP TABLE generation_manuscript_drafts; DROP TABLE generation_manuscript_targets');
    db.close();
    db = openDatabase(directory);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('generation_manuscript_targets', 'generation_manuscript_drafts')").get().n, 2);
    assert.equal(db.prepare('SELECT composition_json FROM generation_records WHERE generation_id = ?').get(old.generationId).composition_json, before);
    assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
  } finally {
    db?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
