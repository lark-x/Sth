import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { defineOperation, Operations, operationsDDL } from '../src/core/index.ts';
import { libraryDDL } from '../src/library/storage.ts';
import {
  LinkedSourcePinsSchema, readJudgment, readSourcePins, researchDDL, sourceOperations, SourcePinsSchema, sourcesDDL, writeSourcePins,
  type Judgment, type JudgmentSummary, type Source, type SourceBacklink, type SourcePin, type SourceReadResult, type SourceSearchResult,
} from '../src/sources/index.ts';
import { sourcesDDL as legacySourcesDDL } from '../src/sources/storage.ts';

const quote = '末班船十点';
const original = `⛵\r\n🚢${quote}🌊\r\n修订旁注：${quote}。`;
const firstRange = { start: original.indexOf(quote), end: original.indexOf(quote) + quote.length };
const secondRange = { start: original.lastIndexOf(quote), end: original.lastIndexOf(quote) + quote.length };
const owner = { kind: 'scene', id: 'fixture-scene', revision: 1, title: '北港', href: '/scenes/fixture-scene?revision=1' } as const;

const fixturePinOperation = defineOperation({
  id: 'fixture.write-pins', effect: 'write', description: 'Write mixed source pins with the shared scene pin API.',
  inputSchema: SourcePinsSchema, outputSchema: LinkedSourcePinsSchema,
  run: (pins, { db }) => writeSourcePins(db, { ...owner, revision: 2 }, pins),
});

function setup(t: TestContext, ddl = sourcesDDL) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(operationsDDL + libraryDDL + ddl);
  const registry = new Operations(db, [...sourceOperations, fixturePinOperation]);
  let nextStep = 0;
  function invoke(operationId: string, input: unknown, stepId = `step-${++nextStep}`, namespace = 'research') {
    return registry.invoke(namespace, { operationId, stepId, input });
  }
  const run = <T>(operationId: string, input: unknown) => invoke(operationId, input).result as T;
  const createSource = (body = original) => run<Source>('source.create', { kind: 'excerpt', title: '北港记录', body });
  const backlinks = (input: object) => run<{ items: SourceBacklink[] }>('source.backlinks', input).items;
  return { db, registry, invoke, run, createSource, backlinks };
}

const failure = (statusCode: number, code: string) => ({ name: 'OperationError', statusCode, code });

test('searches archived UTF-16 occurrences and reads their exact context after a source revision', t => {
  const { createSource, run } = setup(t);
  const { sourceId, revision } = createSource();
  const search = (input: object) => run<{ items: SourceSearchResult[] }>('source.search', input).items;
  const request = { sourceId, query: quote, matchLimit: 1 };
  assert.equal(firstRange.start, 5);
  assert.deepEqual(search(request)[0].matches, [firstRange]);
  assert.deepEqual(search({ ...request, matchOffset: 1 })[0].matches, [secondRange]);
  assert.deepEqual(search({ ...request, matchOffset: 2 })[0].matches, []);
  assert.equal(search({ query: '北港记录' })[0].matches, undefined);
  assert.deepEqual(search({ query: '北港记录', matchLimit: 2 })[0].matches, []);

  const overlap = createSource('🚢哈哈哈');
  assert.deepEqual(search({ sourceId: overlap.sourceId, query: '哈哈', matchLimit: 2 })[0].matches, [{ start: 2, end: 4 }, { start: 3, end: 5 }]);
  run('source.revise', { sourceId, expectedRevision: revision, body: '末班船九点。' });
  assert.deepEqual(search(request), []);
  assert.deepEqual(search({ ...request, revision, matchLimit: 2 })[0].matches, [firstRange, secondRange]);
  assert.throws(() => search({ query: quote, revision }), failure(400, 'source_revision_requires_id'));
  assert.throws(() => search({ ...request, revision: 3 }), failure(404, 'source_revision_not_found'));

  const read = (input: object) => run<SourceReadResult>('source.read', { sourceId, revision, ...input });
  assert.equal(read({}).body, original);
  const context = read({ range: firstRange, contextChars: 1 });
  assert.equal(context.body, `🚢${quote}🌊`);
  assert.deepEqual(context.context, { range: firstRange, bodyRange: { start: firstRange.start - 2, end: firstRange.end + 2 } });
  assert.equal(read({ range: secondRange, contextChars: 0 }).body, quote);
  assert.equal(read({ range: { start: 1, end: 3 }, contextChars: 0 }).body, '\r\n');
  assert.throws(() => read({ range: { start: firstRange.start - 1, end: firstRange.end } }), failure(400, 'source_range_invalid'));
  assert.throws(() => read({ range: { start: firstRange.start, end: firstRange.end + 1 } }), failure(400, 'source_range_invalid'));
  assert.throws(() => read({ range: { start: 0, end: original.length + 1 } }), failure(400, 'source_range_invalid'));
  assert.throws(() => read({ contextChars: 1 }), failure(400, 'source_context_requires_range'));
});

test('upgrades an old pin store additively and keeps mixed and repeated pins in owner order', t => {
  const { db, createSource, run, backlinks } = setup(t, legacySourcesDDL);
  const { sourceId, revision, href } = createSource();
  const legacy = { sourceId, revision, excerpt: quote };
  db.prepare(`INSERT INTO source_pin_owners (owner_kind, owner_id, owner_revision, title, href)
    VALUES (?, ?, ?, ?, ?)`).run(owner.kind, owner.id, owner.revision, owner.title, owner.href);
  db.prepare(`INSERT INTO source_pins (owner_kind, owner_id, owner_revision, position, source_id, source_revision, excerpt)
    VALUES (?, ?, ?, 0, ?, ?, ?)`).run(owner.kind, owner.id, owner.revision, sourceId, revision, quote);
  const oldTables = db.prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name LIKE 'source_%' ORDER BY name`).all();

  db.exec('BEGIN IMMEDIATE');
  db.exec(researchDDL);
  db.exec(researchDDL);
  db.exec('COMMIT');
  for (const table of oldTables) assert.deepEqual(db.prepare('SELECT name, sql FROM sqlite_schema WHERE name = ?').get(table.name), table);
  assert.deepEqual(readSourcePins(db, owner), [{ ...legacy, href }]);

  const first = { ...legacy, range: firstRange };
  const second = { ...legacy, range: secondRange };
  assert.throws(() => run('fixture.write-pins', [first, first]), failure(400, 'operation_invalid_input'));
  assert.throws(() => run('fixture.write-pins', [{ ...first, excerpt: '旁注' }]), failure(400, 'source_excerpt_mismatch'));
  assert.throws(() => run('fixture.write-pins', [{ ...first, range: { start: firstRange.end, end: firstRange.start } }]), failure(400, 'source_range_invalid'));
  const mixed = [second, legacy, first].map(pin => ({ ...pin, href }));
  assert.deepEqual(run('fixture.write-pins', [second, legacy, first]), mixed);
  assert.deepEqual(readSourcePins(db, { ...owner, revision: 2 }), mixed);
  assert.deepEqual(backlinks({ sourceId }).map(item => item.pin), [...mixed, { ...legacy, href }]);
  assert.deepEqual(backlinks({ sourceId, revision, range: { start: firstRange.start + 1, end: firstRange.end } }).map(item => item.pin), [{ ...first, href }]);
  assert.throws(() => backlinks({ sourceId, range: firstRange }), failure(400, 'source_range_requires_revision'));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('range backlinks resolve unique shorthand on the cited revision before paging and leave ambiguous pins unpositioned', t => {
  const { createSource, run, backlinks } = setup(t);
  const { sourceId, revision } = createSource('🚢哈哈哈北港关门');
  const pin = (excerpt: string) => ({ sourceId, revision, excerpt });
  run('fixture.write-pins', [pin('哈哈'), pin('北港'), pin('港关'), pin('关门')]);
  run('source.revise', { sourceId, expectedRevision: revision, body: '北港北港' });

  const query = { sourceId, revision, range: { start: 6, end: 7 }, ownerKind: 'scene', limit: 1 };
  assert.deepEqual(backlinks(query).map(({ pin }) => [pin.excerpt, pin.range]), [['北港', { start: 5, end: 7 }]]);
  assert.deepEqual(backlinks({ ...query, offset: 1 }).map(({ pin }) => [pin.excerpt, pin.range]), [['港关', { start: 6, end: 8 }]]);
  assert.deepEqual(backlinks({ ...query, offset: 2 }), []);
  assert.deepEqual(backlinks({ ...query, range: { start: 2, end: 4 } }), []);
  assert.deepEqual(backlinks({ ...query, revision: 2, range: { start: 0, end: 2 } }), []);
  assert.deepEqual(backlinks({ sourceId, revision }).map(({ pin }) => pin.range), Array(4).fill(undefined));
});

test('lists and revises judgments with immutable scope, positive evidence, counterevidence, and impact', t => {
  const { db, registry, createSource, run, invoke, backlinks } = setup(t);
  assert.deepEqual(registry.catalog().operations.filter(({ id }) => id.startsWith('judgment.')).map(({ id, effect }) => [id, effect]), [
    ['judgment.create', 'write'], ['judgment.read', 'read'], ['judgment.revise', 'write'], ['judgment.list', 'read'],
  ]);
  const source = createSource();
  const { sourceId } = source;
  const pin = (range: SourcePin['range']) => ({ sourceId, revision: 1, excerpt: quote, range });
  const evidence = [{ stance: 'support', pin: pin(firstRange) }, { stance: 'counter', pin: pin(secondRange) }];
  db.prepare('INSERT INTO library_projects (project_id, title) VALUES (?, ?)').run('north', '北港纪事');
  const input = { title: ' 北港夜渡 ', statement: '首份记录支持十点，但旁注质疑其适用性。', scope: '第一章的雨季前工作日', projectId: 'north', evidence };
  assert.throws(() => run('judgment.create', { ...input, projectId: 'missing' }), failure(404, 'project_not_found'));
  assert.throws(() => run('judgment.create', { ...input, evidence: [{ stance: 'support', pin: { sourceId, revision: 1, excerpt: quote } }] }),
    failure(400, 'operation_invalid_input'));
  const first = invoke('judgment.create', input, 'create').result as Judgment;
  const { judgmentId } = first;
  assert.equal(first.title, input.title.trim());
  assert.equal(first.revision, 1);
  assert.deepEqual(first.evidence, evidence.map(item => ({ ...item, pin: { ...item.pin, href: source.href } })));
  assert.deepEqual(readJudgment(db, judgmentId, 1), first);
  assert.deepEqual(run('judgment.revise', { judgmentId, expectedRevision: 1, evidence }), first);

  const revisedSource = run<Source>('source.revise', { sourceId, expectedRevision: 1, body: '末班船九点。' });
  const edit = { judgmentId, expectedRevision: 1, statement: '第二版记录将末班船改为九点。' };
  const carried = invoke('judgment.revise', edit, 'revise').result as Judgment;
  assert.equal(carried.revision, 2);
  assert.deepEqual(carried.evidence, first.evidence);
  assert.equal(carried.scope, first.scope);
  assert.throws(() => invoke('judgment.revise', edit, 'stale', 'other-writer'), failure(409, 'judgment_revision_conflict'));
  assert.deepEqual(invoke('judgment.revise', edit, 'revise').result, carried);

  const replaced = run<Judgment>('judgment.revise', {
    judgmentId, expectedRevision: 2, scope: null, projectId: null,
    evidence: [{ stance: 'support', pin: {
      sourceId, revision: revisedSource.revision, excerpt: '末班船九点', range: { start: 0, end: '末班船九点'.length },
    } }],
  });
  assert.equal(replaced.revision, 3);
  assert.equal(replaced.scope, undefined);
  assert.equal(replaced.projectId, undefined);
  assert.deepEqual(readJudgment(db, judgmentId), replaced);
  assert.deepEqual(run('judgment.read', { judgmentId, revision: 1 }), first);
  assert.throws(() => readJudgment(db, judgmentId, 4), failure(404, 'judgment_revision_not_found'));
  assert.throws(() => readJudgment(db, 'unknown'), failure(404, 'judgment_not_found'));

  assert.deepEqual(backlinks({ sourceId, revision: 1, range: secondRange, ownerKind: 'judgment', projectId: 'north' })
    .map(({ owner, pin, stance }) => [owner.id, owner.revision, pin.range, stance]), [
    [judgmentId, 2, secondRange, 'counter'], [judgmentId, 1, secondRange, 'counter'],
  ]);
  assert.deepEqual(backlinks({ sourceId, revision: 1, limit: 1, offset: 2 }).map(({ owner, stance }) => [owner.revision, stance]), [[1, 'support']]);
  assert.deepEqual(backlinks({ sourceId, revision: 2 }).map(({ owner, pin, stance }) => [owner.href, pin, stance]),
    [[replaced.href, replaced.evidence[0].pin, 'support']]);
  const list = (input: object) => run<{ items: JudgmentSummary[] }>('judgment.list', input).items;
  assert.deepEqual(list({ projectId: 'north' }), []);
  assert.deepEqual(list({}), [{ judgmentId, revision: 3, title: replaced.title, href: replaced.href }]);
  assert.deepEqual(list({ limit: 1, offset: 1 }), []);
  assert.deepEqual(run<Judgment>('judgment.revise', { judgmentId, expectedRevision: 3, evidence: [] }).evidence, []);
  assert.equal(backlinks({ sourceId, revision: 2 })[0].owner.revision, 3);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('rolls back judgment snapshots and exact pins if their operation receipts fail', t => {
  const { db, createSource, run, invoke, backlinks } = setup(t);
  const { sourceId } = createSource();
  const pin = { sourceId, revision: 1, excerpt: quote, range: firstRange };
  const input = { title: '北港夜渡', statement: '末班船十点。', evidence: [{ stance: 'support', pin }] };
  db.exec(`CREATE TRIGGER fail_research_receipt BEFORE INSERT ON operation_receipts
    WHEN NEW.step_id = 'fail'
    BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`);
  assert.throws(() => invoke('judgment.create', input, 'fail'), /fixture receipt failure/);
  assert.throws(() => invoke('fixture.write-pins', [pin], 'fail'), /fixture receipt failure/);
  assert.deepEqual(run('judgment.list', {}), { items: [] });
  assert.deepEqual(backlinks({ sourceId }), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM research_judgments').get()?.total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM source_pin_owners').get()?.total, 0);

  const judgment = run<Judgment>('judgment.create', input);
  const edit = { judgmentId: judgment.judgmentId, expectedRevision: 1, scope: '初稿' };
  assert.throws(() => invoke('judgment.revise', edit, 'fail'), /fixture receipt failure/);
  assert.deepEqual(readJudgment(db, judgment.judgmentId), judgment);
  assert.equal(backlinks({ sourceId }).length, 1);
  db.exec('DROP TRIGGER fail_research_receipt');
  assert.equal((invoke('judgment.revise', edit, 'fail').result as Judgment).revision, 2);
  assert.equal(backlinks({ sourceId }).length, 2);
});
