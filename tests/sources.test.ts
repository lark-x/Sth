import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Type } from '@sinclair/typebox';
import { defineOperation, Operations, operationsDDL, type Operation } from '../src/core/index.ts';
import { libraryDDL, libraryOperations } from '../src/library/index.ts';
import {
  LinkedSourcePinsSchema, readSourcePins, sourceOperations, SourcePinsSchema, sourcesDDL, writeSourcePins,
  type LinkedSourcePin, type Source, type SourceBacklink, type SourcePin, type SourceSummary,
} from '../src/sources/index.ts';

const ten = '北港末班渡船是晚上十点';
const nine = '北港末班渡船是晚上九点';
const originalBody = `  ${ten}。\n\n雨太大就停航。\n`;
const laterBody = originalBody.replace(ten, nine);
const setting = { kind: 'setting', title: ' 北港渡船 ', body: originalBody, origin: '作者手记 · 第一页' };
const entry = { title: '下雨的北港', body: '我在北港等渡船。', diaryDate: '2026-11-23' };

type Diary = typeof entry & { noteId: string; revision: number; href: string; projectId?: string; sourcePins?: LinkedSourcePin[] };

function setup(t: TestContext, extraOperations: readonly Operation[] = []) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(operationsDDL + libraryDDL + sourcesDDL);
  db.exec(sourcesDDL);
  const core = new Operations(db, [...libraryOperations, ...sourceOperations, ...extraOperations]);
  let nextStep = 0;
  function invoke(operationId: string, input: object, stepId = `step-${++nextStep}`, namespace = 'test-first-session') {
    return core.invoke(namespace, { operationId, stepId, input });
  }
  function run<T>(operationId: string, input: object, stepId?: string): T {
    return invoke(operationId, input, stepId).result as T;
  }
  const project = (title: string) => run<{ projectId: string }>('project.create', { title }).projectId;
  const sources = (operationId: string, input: object = {}) => run<{ items: SourceSummary[] }>(operationId, input).items;
  const backlinks = (input: object) => run<{ items: SourceBacklink[] }>('source.backlinks', input).items;
  return { db, core, invoke, run, project, sources, backlinks };
}

function error(statusCode: number, code: string) {
  return { name: 'OperationError', statusCode, code };
}

test('finds Chinese originals and keeps the ten and nine o’clock diary pins across sessions and projects', t => {
  const { core, invoke, run, project, sources, backlinks } = setup(t);
  assert.deepEqual(core.catalog().operations.filter(({ id }) => id.startsWith('source.')).map(({ id, effect }) => [id, effect]), [
    ['source.create', 'write'], ['source.read', 'read'], ['source.list', 'read'], ['source.search', 'read'],
    ['source.revise', 'write'], ['source.history', 'read'], ['source.backlinks', 'read'], ['source.impact', 'read'],
  ]);
  const a = project('北港纪事');
  const b = project('沿海故事');
  const first = run<Source>('source.create', setting, 'create-source');
  const { sourceId } = first;
  assert.deepEqual(first, {
    ...setting, title: setting.title.trim(), sourceId, revision: 1, projectIds: [], href: `/sources/${sourceId}?revision=1`,
  });
  assert.deepEqual(sources('source.list', { projectId: a }), []);
  for (const query of ['北港', '渡', '雨太大就停航。', '手记', '  北港末班']) {
    assert.equal(sources('source.search', { query })[0]?.sourceId, sourceId);
  }

  const oldPin: SourcePin = { sourceId, revision: 1, excerpt: ten };
  const oldInput = { ...entry, sourcePins: [oldPin] };
  const old = run<Diary>('diary.create', oldInput, 'create-old-diary');
  assert.deepEqual(old.sourcePins, [{ ...oldPin, href: first.href }]);

  const revised = run<Source>('source.revise', { sourceId, expectedRevision: 1, body: laterBody, projectIds: [b, a] });
  assert.equal(revised.revision, 2);
  assert.equal(revised.href, `/sources/${sourceId}?revision=2`);
  assert.deepEqual(revised.projectIds, [a, b].sort());
  assert.deepEqual(sources('source.list', { projectId: a }), sources('source.list', { projectId: b }));
  assert.equal(sources('source.list', { projectId: b })[0]?.sourceId, sourceId);
  assert.deepEqual(sources('source.search', { query: '晚上十点' }), []);
  assert.equal(sources('source.search', { query: '晚上九点', projectId: a })[0]?.revision, 2);
  assert.deepEqual(sources('source.history', { sourceId }).map(({ revision }) => revision), [2, 1]);
  assert.equal(sources('source.history', { sourceId, limit: 1, offset: 1 })[0]?.href, first.href);
  assert.deepEqual(invoke('source.create', setting, 'create-source').result, first);
  assert.deepEqual(invoke('diary.create', oldInput, 'create-old-diary').result, old);

  const fromNextSession = invoke('diary.read', { noteId: old.noteId }, 'read-old', 'test-next-session').result as Diary;
  assert.deepEqual(fromNextSession, old);
  const href = new URL(fromNextSession.sourcePins![0].href, 'http://localhost');
  assert.deepEqual(run('source.read', {
    sourceId: href.pathname.split('/').at(-1), revision: Number(href.searchParams.get('revision')),
  }), first);
  assert.deepEqual(run('source.read', { sourceId }), revised);

  const newPin = { sourceId, revision: 2, excerpt: nine };
  const diaryA = invoke('diary.create', { ...entry, projectId: a, sourcePins: [newPin] }, 'draft-new', 'test-next-session').result as Diary;
  const diaryB = run<Diary>('diary.create', { ...entry, projectId: b, sourcePins: [newPin] });
  const pinned = { ...newPin, href: revised.href };
  assert.deepEqual(diaryA.sourcePins, [pinned]);
  assert.deepEqual(diaryB.sourcePins, [pinned]);
  assert.deepEqual(run('diary.list', { projectId: b }), { items: [diaryB] });
  assert.deepEqual(new Set(backlinks({ sourceId }).map(({ owner }) => owner.id)), new Set([old.noteId, diaryA.noteId, diaryB.noteId]));
  assert.deepEqual(backlinks({ sourceId, revision: 1 }).map(({ pin }) => pin), old.sourcePins);
  assert.deepEqual(backlinks({ sourceId, revision: 2, projectId: b }), [{
    owner: { kind: 'diary', id: diaryB.noteId, revision: 1, projectId: b, title: entry.title, href: `${diaryB.href}?revision=1` }, pin: pinned,
  }]);
});

test('supports literal punctuation, same-title candidates, pagination and attachment-only revisions', t => {
  const { run, project, sources } = setup(t);
  const a = project('作品甲');
  const b = project('作品乙');
  const first = run<Source>('source.create', { ...setting, projectIds: [a, b] });
  const second = run<Source>('source.create', { ...setting, kind: 'excerpt', body: '代号%_与[北港]。' });
  const candidates = sources('source.search', { query: '北港渡船' });
  assert.deepEqual(new Set(candidates.map(({ sourceId }) => sourceId)), new Set([first.sourceId, second.sourceId]));
  assert.deepEqual(sources('source.search', { query: '北港渡船', limit: 1, offset: 1 }), candidates.slice(1));
  assert.deepEqual(sources('source.search', { query: '北港', kind: 'setting' }), candidates.filter(item => item.kind === 'setting'));
  assert.deepEqual(sources('source.search', { query: '%_' }).map(item => item.sourceId), [second.sourceId]);
  assert.deepEqual(sources('source.search', { query: "' OR 1=1 --" }), []);
  const { sourceId } = first;
  assert.deepEqual(run('source.revise', { sourceId, expectedRevision: 1, projectIds: [b, a] }), first);
  const detached = run<Source>('source.revise', { sourceId, expectedRevision: 1, projectIds: [], origin: null });
  assert.equal(detached.revision, 2);
  assert.equal(detached.origin, undefined);
  assert.deepEqual(detached.projectIds, []);
  assert.deepEqual(sources('source.list', { projectId: a }), []);
  assert.deepEqual(run('source.read', { sourceId, revision: 1 }), first);
});

test('validates strict operation inputs, revisions, projects and exact excerpts', t => {
  const { run, sources, backlinks } = setup(t);
  const invalidInput = error(400, 'operation_invalid_input');
  assert.throws(() => run('source.create', { ...setting, extra: true }), invalidInput);
  assert.throws(() => run('source.create', { ...setting, projectIds: ['x', 'x'] }), invalidInput);
  assert.throws(() => run('source.create', { ...setting, projectIds: ['missing'] }), error(404, 'project_not_found'));
  assert.throws(() => run('source.create', { ...setting, body: '文本\0末尾' }), error(400, 'source_invalid_text'));
  assert.throws(() => run('source.read', { sourceId: 'missing', revision: 1 }), error(404, 'source_not_found'));
  assert.throws(() => run('source.search', { query: ' ' }), invalidInput);
  assert.throws(() => run('source.list', { limit: 51 }), invalidInput);
  assert.deepEqual(sources('source.list'), []);

  const { sourceId } = run<Source>('source.create', setting);
  const pin = { sourceId, revision: 1, excerpt: ten };
  assert.throws(() => run('source.revise', { sourceId, expectedRevision: 2, body: laterBody }), {
    ...error(409, 'source_revision_conflict'), message: /revision 1/,
  });
  assert.throws(() => run('source.revise', { sourceId, expectedRevision: 1, projectIds: ['missing'] }), error(404, 'project_not_found'));
  assert.equal(sources('source.history', { sourceId }).length, 1);
  assert.throws(() => run('diary.create', { ...entry, sourcePins: [{ ...pin, href: '/sources/forged' }] }), invalidInput);
  assert.throws(() => run('diary.create', { ...entry, sourcePins: [pin, pin] }), invalidInput);
  assert.throws(() => run('diary.create', { ...entry, sourcePins: [{ ...pin, revision: 2 }] }), error(404, 'source_revision_not_found'));
  assert.throws(() => run('diary.create', { ...entry, sourcePins: [pin, { ...pin, excerpt: nine }] }), error(400, 'source_excerpt_mismatch'));
  assert.deepEqual(backlinks({ sourceId }), []);
  assert.deepEqual(run('diary.list', {}), { items: [] });
});

test('diary revisions preserve, replace and clear pins without changing historical backlinks', t => {
  const { run, backlinks } = setup(t);
  const { sourceId } = run<Source>('source.create', setting);
  const pin = { sourceId, revision: 1, excerpt: ten };
  const diary = run<Diary>('diary.create', { ...entry, sourcePins: [pin] });
  const { noteId } = diary;
  const base = { ...entry, noteId };
  const carried = run<Diary>('diary.revise', { ...base, title: '新版标题', expectedRevision: 1 });
  assert.deepEqual(carried.sourcePins, diary.sourcePins);
  assert.equal(carried.revision, 2);
  assert.deepEqual(run('diary.revise', { ...base, title: carried.title, expectedRevision: 2, sourcePins: [pin] }), carried);
  run('source.revise', { sourceId, expectedRevision: 1, body: laterBody });
  const replacement = { sourceId, revision: 2, excerpt: nine };
  const replaced = run<Diary>('diary.revise', { ...base, title: carried.title, expectedRevision: 2, sourcePins: [replacement] });
  assert.equal(replaced.revision, 3);
  assert.deepEqual(replaced.sourcePins, [{ ...replacement, href: `/sources/${sourceId}?revision=2` }]);
  const cleared = run<Diary>('diary.revise', { ...base, title: carried.title, expectedRevision: 3, sourcePins: [] });
  assert.equal(cleared.revision, 4);
  assert.equal(cleared.sourcePins, undefined);
  assert.deepEqual(run('diary.read', { noteId }), cleared);
  assert.deepEqual(run('diary.read', { noteId, revision: 1 }), { ...diary, href: `${diary.href}?revision=1` });
  assert.throws(() => run('diary.read', { noteId, revision: 5 }), error(404, 'diary_revision_not_found'));
  assert.deepEqual(backlinks({ sourceId, revision: 1 }).map(({ owner }) => [owner.revision, owner.title]), [[2, carried.title], [1, diary.title]]);
  assert.deepEqual(backlinks({ sourceId, revision: 2 }).map(({ owner }) => owner.revision), [3]);
});

test('scene and draft writers can publish immutable backlinks through the shared pin API', t => {
  const ownerKind = Type.Union([Type.Literal('scene'), Type.Literal('draft')]);
  const fixtureOperation = defineOperation({
    id: 'fixture.pin', effect: 'write', description: 'Save a source pin for a scene or draft fixture.',
    inputSchema: Type.Object({ kind: ownerKind, pins: SourcePinsSchema }, { additionalProperties: false }),
    outputSchema: LinkedSourcePinsSchema,
    run({ kind, pins }, { db }) {
      writeSourcePins(db, { kind, id: 'same-id', revision: 2, title: '北港之夜', href: `/${kind}s/same-id?revision=2` }, pins);
      return readSourcePins(db, { kind, id: 'same-id', revision: 2 });
    },
  });
  const { run, backlinks } = setup(t, [fixtureOperation]);
  const { sourceId, href } = run<Source>('source.create', setting);
  const pin = { sourceId, revision: 1, excerpt: ten };
  for (const kind of ['scene', 'draft'] as const) {
    assert.deepEqual(run('fixture.pin', { kind, pins: [pin] }), [{ ...pin, href }]);
    assert.throws(() => run('fixture.pin', { kind, pins: [] }), error(409, 'source_pin_owner_conflict'));
    assert.deepEqual(backlinks({ sourceId, ownerKind: kind }), [{
      owner: { kind, id: 'same-id', revision: 2, title: '北港之夜', href: `/${kind}s/same-id?revision=2` }, pin: { ...pin, href },
    }]);
  }
  assert.equal(backlinks({ sourceId, limit: 1, offset: 1 }).length, 1);
});

test('receipt failures roll back source revisions, attachments, diary revisions and pins together', t => {
  const { db, run, project, sources, backlinks } = setup(t);
  const projectId = project('作品');
  const { sourceId } = run<Source>('source.create', setting);
  const diary = run<Diary>('diary.create', entry);
  const sourceEdit = { sourceId, expectedRevision: 1, projectIds: [projectId], body: laterBody };
  const diaryEdit = { ...entry, noteId: diary.noteId, expectedRevision: 1, sourcePins: [{ sourceId, revision: 1, excerpt: ten }] };
  db.exec(`CREATE TRIGGER fail_revision_receipt BEFORE INSERT ON operation_receipts
    WHEN NEW.operation_id IN ('source.revise', 'diary.revise')
    BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`);
  assert.throws(() => run('source.revise', sourceEdit, 'source-edit'), /fixture receipt failure/);
  assert.throws(() => run('diary.revise', diaryEdit, 'diary-edit'), /fixture receipt failure/);
  assert.deepEqual(sources('source.list', { projectId }), []);
  assert.equal(sources('source.history', { sourceId }).length, 1);
  assert.deepEqual(run('diary.read', { noteId: diary.noteId }), diary);
  assert.deepEqual(backlinks({ sourceId }), []);
  db.exec('DROP TRIGGER fail_revision_receipt');
  assert.equal(run<Source>('source.revise', sourceEdit, 'source-edit').revision, 2);
  assert.equal(run<Diary>('diary.revise', diaryEdit, 'diary-edit').revision, 2);
  assert.equal(backlinks({ sourceId })[0]?.owner.revision, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('source originals, diary pins, backlinks and receipts survive reopening SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-sources-'));
  const filename = join(directory, 'sources.sqlite');
  function withRegistry<T>(run: (core: Operations) => T) {
    const db = new DatabaseSync(filename);
    try {
      db.exec(operationsDDL + libraryDDL + sourcesDDL);
      return run(new Operations(db, [...libraryOperations, ...sourceOperations]));
    } finally {
      db.close();
    }
  }
  try {
    const { source, saved, write } = withRegistry(core => {
      const source = core.invoke('paired', { operationId: 'source.create', stepId: 'source', input: setting }).result as Source;
      const write = {
        operationId: 'diary.create', stepId: 'diary',
        input: { ...entry, sourcePins: [{ sourceId: source.sourceId, revision: 1, excerpt: ten }] },
      };
      const saved = core.invoke('paired', write);
      core.invoke('web', {
        operationId: 'source.revise', stepId: 'edit', input: { sourceId: source.sourceId, expectedRevision: 1, body: laterBody },
      });
      return { source, saved, write };
    });
    withRegistry(core => {
      const { sourceId } = source;
      const { noteId, sourcePins } = saved.result as Diary;
      assert.deepEqual(core.invoke('paired', write), { ...saved, replayed: true });
      assert.deepEqual(core.invoke('fresh', { operationId: 'diary.read', stepId: 'diary', input: { noteId } }).result, saved.result);
      assert.deepEqual(core.invoke('fresh', { operationId: 'source.read', stepId: 'old', input: { sourceId, revision: 1 } }).result, source);
      const current = core.invoke('fresh', { operationId: 'source.read', stepId: 'current', input: { sourceId } }).result as Source;
      assert.equal(current.body, laterBody);
      const links = core.invoke('fresh', { operationId: 'source.backlinks', stepId: 'links', input: { sourceId } }).result as { items: SourceBacklink[] };
      assert.deepEqual(links.items.map(({ owner, pin }) => [owner.id, pin]), [[noteId, sourcePins![0]]]);
    });
  } finally {
    rmSync(filename, { force: true });
    rmdirSync(directory);
  }
});
