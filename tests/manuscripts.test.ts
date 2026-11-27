import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { openDatabase } from '../src/database.ts';
import { manuscriptDDL } from '../src/manuscripts.ts';
import { writeDraftRevision } from '../src/story/storage.ts';
import { workspaceDDL, workspaceOperations } from '../src/workspace.ts';

interface Recent {
  items: { kind: string; id: string; title: string; href: string; sceneId?: string; revision: number; updatedAt: number }[];
  nextOffset?: number;
}

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; ${operationsDDL} ${workspaceDDL}`);
  const operations = new Operations(db, workspaceOperations);
  const run = <T>(id: string, input = {}, namespace = 'web', stepId = randomUUID()) =>
    operations.invoke(namespace, { operationId: id, input, stepId }).result as T;
  return { db, operations, run, recent: (input = {}) => run<Recent>('manuscript.recent', input) };
}

test('recent manuscripts combine web and assistant writes with persisted edit order and read-only browsing', t => {
  const { db, run, recent } = setup(t);
  assert.deepEqual(recent(), { items: [] });
  const diary = run<{ noteId: string }>('diary.create', { title: '很早的一天', body: '正文', diaryDate: '2000-01-01' });
  const scene = run<{ sceneId: string }>('scene.create', { title: '渡口' }, 'assistant:a');
  const draft = run<{ draftId: string }>('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '候选', body: '候选正文' }, 'assistant:b');
  const first = recent();
  assert.deepEqual(first.items.map(item => item.kind), ['draft', 'scene', 'diary']);
  assert.equal(first.items[0]!.sceneId, scene.sceneId);
  assert.equal(first.items[0]!.href, `/drafts/${draft.draftId}`);
  assert.ok(first.items.every(item => item.updatedAt > 0 && item.updatedAt <= Date.now()));
  run('diary.read', { noteId: diary.noteId });
  run('draft.read', { draftId: draft.draftId, revision: 1 });
  run('scene.read', { sceneId: scene.sceneId });
  assert.deepEqual(recent(), first, 'automatic reading and preview do not change edit order');
  const input = { noteId: diary.noteId, expectedRevision: 1, title: '很早的一天', diaryDate: '2000-01-01', body: '助手刚接着写下的文字' };
  const stepId = randomUUID();
  run('diary.revise', input, 'assistant:a', stepId);
  assert.equal(recent().items[0]!.id, diary.noteId);
  const after = db.prepare('SELECT * FROM manuscript_activity ORDER BY sequence').all();
  run('diary.revise', input, 'assistant:a', stepId);
  assert.deepEqual(db.prepare('SELECT * FROM manuscript_activity ORDER BY sequence').all(), after, 'receipt replay does not create activity');
  assert.throws(() => run('diary.revise', { ...input, body: '过期冲突' }), { code: 'diary_revision_conflict' });
  assert.deepEqual(db.prepare('SELECT * FROM manuscript_activity ORDER BY sequence').all(), after);

  db.exec('BEGIN');
  writeDraftRevision(db, draft.draftId, 2, { sceneId: scene.sceneId, sceneRevision: 1, title: '后台生成修订', body: '生成正文' });
  db.exec('ROLLBACK');
  assert.deepEqual(recent().items.map(item => item.id), [diary.noteId, draft.draftId, scene.sceneId]);
  db.exec('BEGIN');
  writeDraftRevision(db, draft.draftId, 2, { sceneId: scene.sceneId, sceneRevision: 1, title: '后台生成修订', body: '生成正文' });
  db.exec('COMMIT');
  assert.equal(recent().items[0]!.title, '后台生成修订');
  assert.equal(recent().items[0]!.revision, 2);
});

test('recent manuscript pagination is stable for same-millisecond edits and does not duplicate revisions', t => {
  const { db, run, recent, operations } = setup(t);
  const ids = Array.from({ length: 25 }, (_, index) => run<{ sceneId: string }>('scene.create', { title: `第${index}幕` }).sceneId).reverse();
  db.prepare('UPDATE manuscript_activity SET updated_at = 1000').run();
  const first = recent({ limit: 20 });
  const second = recent({ limit: 20, offset: first.nextOffset });
  assert.equal(first.nextOffset, 20);
  assert.equal(second.nextOffset, undefined);
  assert.deepEqual([...first.items, ...second.items].map(item => item.id), ids);
  assert.equal(operations.catalog().operations.find(item => item.id === 'manuscript.recent')!.effect, 'read');
  assert.throws(() => recent({ limit: 51 }), { code: 'operation_invalid_input' });
});

test('existing schema-four manuscripts are backfilled once and later writes survive restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sth-recent-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let db = new DatabaseSync(join(directory, 'sth.sqlite'));
  try {
    db.exec(`${operationsDDL} ${workspaceDDL.replace(manuscriptDDL, '')}
      PRAGMA application_id=0x53746831; PRAGMA user_version=4;`);
    const old = new Operations(db, workspaceOperations);
    const diary = old.invoke('old', { operationId: 'diary.create', stepId: 'old-diary', input: {
      title: '升级前的日记', body: '旧正文', diaryDate: '1999-01-01',
    } }).result as { noteId: string };
    db.close();
    db = openDatabase(directory);
    const page = new Operations(db, workspaceOperations).invoke('new', {
      operationId: 'manuscript.recent', input: {}, stepId: 'first-read',
    }).result as Recent;
    assert.equal(page.items[0]!.id, diary.noteId);
    assert.equal(page.items[0]!.updatedAt, 0);
    new Operations(db, workspaceOperations).invoke('assistant', { operationId: 'diary.revise', stepId: 'new-body', input: {
      noteId: diary.noteId, expectedRevision: 1, title: '升级前的日记', diaryDate: '1999-01-01', body: '升级后的新修订',
    } });
    const activity = db.prepare('SELECT * FROM manuscript_activity').all();
    assert.ok(Number(activity[0]!.updated_at) > 0);
    db.close();
    db = openDatabase(directory);
    assert.deepEqual(db.prepare('SELECT * FROM manuscript_activity').all(), activity);
  } finally { db.close(); }
});
