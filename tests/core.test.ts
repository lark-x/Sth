import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  defineOperation,
  OperationCatalogSchema,
  OperationError,
  OperationInvokeSchema,
  OperationReceiptQuerySchema,
  OperationResultSchema,
  Operations,
  operationsDDL,
} from '../src/core/index.ts';

const web = 'web';
const connection = 'connection:one';
const addCall = { operationId: 'counter.add', stepId: 'add-1', input: { amount: 2 } };
const addQuery = { operationId: addCall.operationId, stepId: addCall.stepId };
const countSchema = Type.Object({ count: Type.Integer() }, { additionalProperties: false });

function initialize(db: DatabaseSync) {
  db.exec('CREATE TABLE counter_events (amount INTEGER NOT NULL) STRICT');
  db.exec(operationsDDL);
}

function openMemory(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  initialize(db);
  return db;
}

function currentCount(db: DatabaseSync) {
  return Number(db.prepare('SELECT coalesce(sum(amount), 0) AS total FROM counter_events').get()?.total);
}

function operationError(statusCode: number, code: string) {
  return { name: 'OperationError', statusCode, code };
}

const add = defineOperation({
  id: addCall.operationId,
  description: 'Add to the counter.',
  effect: 'write',
  inputSchema: Type.Object({ amount: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  outputSchema: countSchema,
  run({ amount }, { db }) {
    db.prepare('INSERT INTO counter_events VALUES (?)').run(amount);
    return { count: currentCount(db) };
  },
});

const read = defineOperation({
  id: 'counter.read',
  description: 'Read the counter.',
  effect: 'read',
  inputSchema: Type.Null(),
  outputSchema: countSchema,
  run(_input, { db }) {
    return { count: currentCount(db) };
  },
});

const echo = defineOperation({
  id: 'data.echo',
  description: 'Return a JSON value.',
  effect: 'read',
  inputSchema: Type.Unknown(),
  outputSchema: Type.Unknown(),
  run: input => input,
});

test('catalog publishes detached schemas and interaction hints', t => {
  const inputSchema = Type.Object({ itemId: Type.String({ minLength: 1 }), date: Type.Optional(Type.String()) }, { additionalProperties: false });
  const interaction = {
    identityFields: ['itemId'],
    localDateField: 'date',
    resultLink: { hrefField: 'target', labelField: 'caption' },
  };
  const preview = defineOperation({
    id: 'schedule.preview',
    description: 'Preview a scheduled item.',
    effect: 'read',
    inputSchema,
    outputSchema: Type.Object({ target: Type.String(), caption: Type.String() }),
    interaction,
    run: ({ itemId }) => ({ target: `/schedule/${itemId}`, caption: itemId }),
  });
  const db = openMemory(t);
  const core = new Operations(db, [add, preview]);
  const catalog = core.catalog();
  const { run: _, ...descriptor } = preview;
  assert.deepEqual(catalog.operations[1], structuredClone(descriptor));
  assert.equal(Value.Check(OperationCatalogSchema, JSON.parse(JSON.stringify(catalog))), true);
  assert.equal(Object.hasOwn(catalog.operations[0], 'interaction'), false);

  catalog.operations[1].inputSchema.properties.itemId.minLength = 10;
  catalog.operations[1].interaction?.identityFields?.pop();
  catalog.operations.pop();
  inputSchema.properties.itemId.minLength = 20;
  interaction.resultLink.labelField = 'target';
  const retained = core.catalog().operations[1];
  assert.deepEqual(retained.interaction, {
    identityFields: ['itemId'], localDateField: 'date', resultLink: { hrefField: 'target', labelField: 'caption' },
  });
  assert.deepEqual(retained.inputSchema.properties, { itemId: { type: 'string', minLength: 1 }, date: { type: 'string' } });

  const call = { operationId: preview.id, stepId: 'preview-1', input: { itemId: 'task-3' } };
  assert.throws(() => core.invoke(web, { ...call, input: { itemId: '' } }), operationError(400, 'operation_invalid_input'));
  assert.deepEqual(core.invoke(web, call).result, { target: '/schedule/task-3', caption: 'task-3' });

  const invalid = operationError(500, 'operation_invalid_registration');
  const extraLinkOption = { hrefField: 'target', labelField: 'caption', openIn: 'tab' };
  for (const hints of [
    { identityFields: ['itemId'], hiddenPolicy: true },
    { identityFields: ['caption'] },
    { localDateField: 'toString' },
    { resultLink: { hrefField: 'target', labelField: 'missing' } },
    { resultLink: { hrefField: 'target', labelField: 'caption', revisionField: 'missing' } },
    { resultLink: { hrefField: 'target', labelField: 'caption', rangeField: 'caption.range' } },
    { resultLink: extraLinkOption },
  ]) {
    assert.throws(() => new Operations(db, [{ ...preview, interaction: hints }]), invalid);
  }
  assert.throws(() => new Operations(db, [{ ...read, interaction: { identityFields: ['count'] } }]), invalid);
});

test('result link hints declare exact revisions and optional nested selection coordinates', t => {
  const db = openMemory(t);
  const definition = defineOperation({
    id: 'passage.read', effect: 'read', description: 'Read an exact passage.', inputSchema: Type.Object({}),
    outputSchema: Type.Object({ href: Type.String(), title: Type.String(), revision: Type.Integer(),
      context: Type.Optional(Type.Object({ range: Type.Object({ start: Type.Integer(), end: Type.Integer() }) })) }),
    interaction: { resultLink: { hrefField: 'href', labelField: 'title', revisionField: 'revision', rangeField: 'context.range' } },
    run: () => ({ href: '/sources/passage', title: 'Passage', revision: 1 }),
  });
  const core = new Operations(db, [definition]);
  assert.deepEqual(core.catalog().operations[0].interaction, definition.interaction);
  assert.equal(Value.Check(OperationCatalogSchema, core.catalog()), true);
  const invalid = operationError(500, 'operation_invalid_registration');
  for (const rangeField of ['context.missing', 'context.range.start.missing', '__proto__.range', '']) {
    assert.throws(() => new Operations(db, [{ ...definition, interaction: {
      resultLink: { ...definition.interaction!.resultLink!, rangeField },
    } }]), invalid);
  }
});

test('registration rejects malformed descriptors and duplicate IDs', t => {
  const db = openMemory(t);
  const invalid = operationError(500, 'operation_invalid_registration');
  for (const id of ['', 'Counter.add', 'counter..add', 'counter.add\n', 'a'.repeat(101)]) {
    assert.throws(() => new Operations(db, [{ ...add, id }]), invalid);
  }
  assert.throws(() => new Operations(db, [{ ...add, description: ' ' }]), invalid);
  assert.throws(() => new Operations(db, [{ ...add, inputSchema: { type: 'object' } as typeof add.inputSchema }]), invalid);
  assert.throws(() => new Operations(db, [add, { ...read, id: add.id }]), operationError(500, 'operation_duplicate_id'));
});

test('envelopes enforce operation identity and keep the receipt namespace server-supplied', t => {
  const db = openMemory(t);
  const core = new Operations(db, [add]);
  const invalidScope = operationError(400, 'operation_invalid_scope');
  for (const namespace of ['', ' ', 'web\0other', '\ud800']) {
    assert.throws(() => core.invoke(namespace, addCall), invalidScope);
    assert.throws(() => core.receipt(namespace, addQuery), invalidScope);
  }
  assert.equal(Value.Check(OperationInvokeSchema, addCall), true);
  assert.equal(Value.Check(OperationInvokeSchema, addQuery), false);
  assert.equal(Value.Check(OperationReceiptQuerySchema, addQuery), true);
  assert.equal(Value.Check(OperationReceiptQuerySchema, addCall), false);
  assert.equal(Value.Check(OperationResultSchema, { ...addQuery, replayed: true }), false);
  for (const invocation of [null, addQuery, { ...addCall, stepId: '' }, { ...addCall, stepId: '\ud800' }, { ...addCall, namespace: connection }]) {
    assert.throws(() => core.invoke(web, invocation), operationError(400, 'operation_invalid_invocation'));
  }
  for (const query of [addCall, { ...addQuery, operationId: '' }, { ...addQuery, stepId: '\ud800' }, { ...addQuery, namespace: connection }]) {
    assert.throws(() => core.receipt(web, query), operationError(400, 'operation_invalid_receipt_query'));
  }
  assert.throws(() => core.invoke(web, { ...addCall, operationId: 'counter.missing' }), operationError(404, 'operation_not_found'));
  for (const input of [{ amount: 0 }, { amount: '2' }, { amount: 2, extra: true }, undefined]) {
    assert.throws(() => core.invoke(web, { ...addCall, input }), operationError(400, 'operation_invalid_input'));
  }
  assert.equal(currentCount(db), 0);
  assert.equal(Value.Check(OperationResultSchema, core.invoke(web, addCall)), true);
});

test('writes and receipts replay by namespace while operations share the domain database', t => {
  const db = openMemory(t);
  const core = new Operations(db, [add, read]);
  const missing = operationError(404, 'operation_receipt_not_found');
  assert.throws(() => core.receipt(web, addQuery), missing);
  const first = core.invoke(web, addCall);
  assert.deepEqual(first, { ...addQuery, replayed: false, result: { count: 2 } });
  assert.throws(() => core.receipt(connection, addQuery), missing);
  assert.throws(() => core.receipt(web, { ...addQuery, operationId: read.id }), missing);
  assert.deepEqual(core.invoke(connection, addCall), { ...first, result: { count: 4 } });
  assert.deepEqual(core.invoke(web, addCall), { ...first, replayed: true });
  assert.deepEqual(core.receipt(web, addQuery), { ...first, replayed: true });
  assert.deepEqual(core.receipt(connection, addQuery), { ...first, replayed: true, result: { count: 4 } });
  for (const call of [{ ...addCall, input: { amount: 3 } }, { ...addCall, operationId: read.id, input: null }]) {
    assert.throws(() => core.invoke(web, call), operationError(409, 'operation_step_conflict'));
  }
  assert.equal(currentCount(db), 4);
  assert.equal(db.prepare('SELECT count(*) AS total FROM operation_receipts').get()?.total, 2);
});

test('reads replay their original result and a fresh step reads current state', t => {
  const core = new Operations(openMemory(t), [read, add]);
  const call = { operationId: read.id, stepId: 'read-1', input: null };
  assert.deepEqual(core.invoke(web, call).result, { count: 0 });
  core.invoke(web, addCall);
  assert.deepEqual(core.invoke(web, call), { operationId: read.id, stepId: 'read-1', replayed: true, result: { count: 0 } });
  assert.deepEqual(core.invoke(web, { ...call, stepId: 'read-2' }).result, { count: 2 });
});

test('canonical JSON ignores nested object key order, preserves array order, and rejects non-JSON data', t => {
  const core = new Operations(openMemory(t), [echo]);
  const call = { operationId: echo.id, stepId: 'echo-1', input: { z: [1, 2], a: { b: false, a: null } } };
  let getterCalls = 0;
  const accessor = { get value() { getterCalls++; return 1; } };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const input of [accessor, cycle, Infinity, new Date(), new Array(1), { toJSON: () => 3 }]) {
    assert.throws(() => core.invoke(web, { ...call, input }), operationError(400, 'operation_invalid_input'));
  }
  assert.equal(getterCalls, 0);
  assert.deepEqual(core.invoke(web, call).result, call.input);
  assert.equal(core.invoke(web, { ...call, input: { a: { a: null, b: false }, z: [1, 2] } }).replayed, true);
  assert.throws(() => core.invoke(web, { ...call, input: { ...call.input, z: [2, 1] } }), operationError(409, 'operation_step_conflict'));
});

test('handler errors and invalid results roll back writes and leave retryable steps', t => {
  const db = openMemory(t);
  const failure = new OperationError(409, 'counter_changed', 'The counter changed.');
  const failing = defineOperation({ ...add, run(input, ctx) {
    assert.deepEqual(Object.keys(ctx), ['db']);
    assert.equal(ctx.db, db);
    add.run(input, ctx);
    throw failure;
  } });
  assert.throws(() => new Operations(db, [failing]).invoke(web, addCall), error => error === failure);
  assert.equal(currentCount(db), 0);
  for (const output of [{ count: '2' }, { count: 2, extra: true }, { count: 1n }, undefined]) {
    const invalid = { ...add, run(input: Parameters<typeof add.run>[0], ctx: Parameters<typeof add.run>[1]) {
      add.run(input, ctx);
      return output;
    } };
    assert.throws(() => new Operations(db, [invalid]).invoke(web, addCall), operationError(500, 'operation_invalid_result'));
    assert.equal(currentCount(db), 0);
  }
  const core = new Operations(db, [add]);
  assert.throws(() => core.receipt(web, addQuery), operationError(404, 'operation_receipt_not_found'));
  assert.equal(core.invoke(web, addCall).replayed, false);
  assert.equal(currentCount(db), 2);
});

test('receipt insertion must succeed before a domain write commits', t => {
  const db = openMemory(t);
  const core = new Operations(db, [add]);
  for (const [action, error] of [
    ["ABORT, 'receipt unavailable'", /receipt unavailable/],
    ['IGNORE', operationError(500, 'operation_receipt_not_saved')],
  ] as const) {
    db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON operation_receipts
      BEGIN SELECT RAISE(${action}); END`);
    assert.throws(() => core.invoke(web, addCall), error);
    assert.equal(currentCount(db), 0);
    assert.throws(() => core.receipt(web, addQuery), operationError(404, 'operation_receipt_not_found'));
    db.exec('DROP TRIGGER reject_receipt');
  }
  assert.equal(core.invoke(web, addCall).replayed, false);
});

test('async handlers are rejected and an unexpected Promise rolls back writes', t => {
  const db = openMemory(t);
  const error = operationError(500, 'operation_async_handler');
  assert.throws(() => new Operations(db, [{ ...add, run: async () => ({ count: 2 }) }]), error);
  const asyncResult = { ...add, run(input: Parameters<typeof add.run>[0], ctx: Parameters<typeof add.run>[1]) {
    add.run(input, ctx);
    return Promise.reject(new Error('async work failed'));
  } };
  assert.throws(() => new Operations(db, [asyncResult]).invoke(web, addCall), error);
  assert.equal(currentCount(db), 0);
  assert.equal(new Operations(db, [add]).invoke(web, addCall).replayed, false);
});

test('competing connections serialize writes and resolve the same step from the committed receipt', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-operations-'));
  const path = join(directory, 'operations.db');
  t.after(() => {
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    rmdirSync(directory);
  });

  {
    using db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    initialize(db);
    using concurrent = new DatabaseSync(path, { timeout: 0 });
    const contender = new Operations(concurrent, [add]);
    const writer = new Operations(db, [defineOperation({ ...add, run(input, ctx) {
      assert.throws(() => contender.receipt(web, addQuery), operationError(404, 'operation_receipt_not_found'));
      assert.throws(() => contender.invoke(web, addCall), { errcode: 5 });
      assert.equal(concurrent.isTransaction, false);
      return add.run(input, ctx);
    } })]);
    const first = writer.invoke(web, addCall);
    assert.equal(first.replayed, false);
    assert.deepEqual(contender.invoke(web, addCall), { ...first, replayed: true });
    assert.throws(() => contender.invoke(web, { ...addCall, input: { amount: 3 } }), operationError(409, 'operation_step_conflict'));
    assert.equal(currentCount(concurrent), 2);
  }

  {
    using db = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(new Operations(db, []).receipt(web, addQuery), { ...addQuery, replayed: true, result: { count: 2 } });
  }

  using reopened = new DatabaseSync(path);
  reopened.exec(operationsDDL);
  const changed = defineOperation({ ...add, inputSchema: Type.Null(), outputSchema: Type.String(), run: () => 'new result' });
  const core = new Operations(reopened, [changed]);
  assert.deepEqual(core.invoke(web, addCall), { ...addQuery, replayed: true, result: { count: 2 } });
  assert.throws(() => core.invoke(web, { ...addCall, input: null }), operationError(409, 'operation_step_conflict'));
  assert.equal(currentCount(reopened), 2);
  assert.equal(reopened.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
});
