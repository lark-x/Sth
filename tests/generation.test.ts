import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { generationDDL, generationOperations, processNextGeneration, startGenerationWorker, type GenerationProvider } from '../src/generation/index.ts';
import type { Generation, GenerationResult, GenerationSummary, Plan, Requirements, Template } from '../src/generation/contracts.ts';
import { libraryDDL, libraryOperations } from '../src/library/index.ts';
import { sourcesDDL, sourceOperations } from '../src/sources/index.ts';
import { storyDDL, storyOperations } from '../src/story/index.ts';

function initialize(db: DatabaseSync) {
  db.exec(`PRAGMA foreign_keys = ON; ${operationsDDL}${libraryDDL}${sourcesDDL}${storyDDL}${generationDDL}`);
}

function client(db: DatabaseSync) {
  const registry = new Operations(db, [...libraryOperations, ...sourceOperations, ...storyOperations, ...generationOperations]);
  const stepPrefix = randomUUID();
  let nonce = 0;
  function invoke(operationId: string, input: unknown, stepId = `${stepPrefix}-${++nonce}`) {
    return registry.invoke('connection:test', { operationId, input, stepId });
  }
  return {
    invoke,
    call<T>(operationId: string, input: unknown, stepId?: string) {
      return invoke(operationId, input, stepId).result as T;
    },
  };
}

function openMemory(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  initialize(db);
  return { db, ...client(db) };
}

const diaryOutput = { setting: 'North Port', events: 'Caught the ferry.', feelings: 'Relief', reflection: 'Leave earlier next time.' };
const namedPlan = { title: 'Alternate draft', executor: 'openai-compatible', provider: 'test', model: 'synthetic-request',
  parameters: { temperature: 0.4, maxOutputTokens: 1000 } };
const unexpectedProvider: GenerationProvider = { prepare() { assert.fail('No provider call should occur'); } };

test('current-chat prepares and saves once with exact cross-project template, requirements and reference revisions', async t => {
  const { db, call, invoke } = openMemory(t);
  const { projectId: one } = call<{ projectId: string }>('project.create', { title: 'Harbor' });
  const { projectId: two } = call<{ projectId: string }>('project.create', { title: 'Voyage' });
  const { characterId } = call<{ characterId: string }>('character.create', { name: 'Lin', persona: 'Afraid of water.' });
  const source = call<{ sourceId: string }>('source.create', { title: '北港', kind: 'setting', body: '末班渡船晚上十点。', projectIds: [one] });
  const { sceneId } = call<{ sceneId: string }>('scene.create', { title: 'The wharf', characters: [{ characterId, revision: 1 }] });
  const { draftId } = call<{ draftId: string }>('draft.create', { sceneId, title: 'Earlier approach', body: 'At the wharf.', sceneRevision: 1 });
  const requirement = call<Requirements>('writing.requirements.set', { title: 'Personal diary', viewpoint: 'First person', tone: 'Sober' });
  const builtin = call<Template>('templates.get', { templateId: 'diary' });
  const original = call<Template>('templates.create', { title: 'Four-part diary', kind: 'diary', fields: builtin.fields });
  const references = [
    { kind: 'character', id: characterId, revision: 1 },
    { kind: 'source', id: source.sourceId, revision: 1, excerpt: '晚上十点' },
    { kind: 'scene', id: sceneId, revision: 1 },
    { kind: 'draft', id: draftId, revision: 1 },
  ];
  const prepareInput = { title: 'The last ferry', brief: 'Use the pinned setting.', inputs: { weather: 'Rain', numberOfTickets: 1 },
    templateId: original.templateId, requirementId: requirement.requirementId, references };
  assert.throws(() => call('generations.prepare', { ...prepareInput, references: [{ ...references[1], excerpt: '晚上九点' }] }),
    { code: 'source_excerpt_mismatch' });
  const first = call<Generation>('generations.prepare', { ...prepareInput, projectId: one });
  const second = call<Generation>('generations.prepare', { ...prepareInput, projectId: two });
  assert.equal(second.composition.template.revision, 1);
  assert.equal(second.composition.requirements?.revision, 1);
  assert.deepEqual(first.composition.references, second.composition.references);
  assert.deepEqual(first.composition.references[0].content, { persona: 'Afraid of water.', projectId: null });
  assert.match(String(first.composition.messages[1].content), /晚上十点/);
  assert.equal((first.composition.references[3].content as { body: string }).body, 'At the wharf.');

  const choices = { templateId: original.templateId, expectedRevision: 1, title: original.title, kind: original.kind,
    fields: [...original.fields, { key: 'tomorrow', label: 'Tomorrow', type: 'text' }] };
  call('templates.update', choices);
  assert.throws(() => call('templates.update', choices), { code: 'generation_definition_conflict', message: /revision 2/ });
  call('writing.requirements.set', { requirementId: requirement.requirementId, expectedRevision: 1, title: requirement.title, tone: 'Light' });
  call('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '末班渡船晚上九点。' });
  call('character.revise', { characterId, name: 'Lin', persona: 'Loves water.', expectedRevision: 1 });
  call('draft.revise', { draftId, title: 'Earlier approach', body: 'Different ending.', expectedRevision: 1 });

  assert.throws(() => call('generations.save', { generationId: first.generationId, output: { ...diaryOutput, events: ' ' } }, 'save-first'),
    { code: 'generation_invalid_output', message: /\/events: expected well-formed, nonblank text/ });
  const save = { generationId: first.generationId, output: diaryOutput };
  const completed = call<Generation>('generations.save', save, 'save-first');
  assert.equal(invoke('generations.save', save, 'save-first').replayed, true);
  assert.throws(() => call('generations.save', save), { code: 'generation_not_prepared' });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.execution.requestedModel, null);
  assert.equal(completed.execution.reportedModel, null);
  assert.deepEqual(completed.composition, first.composition);
  assert.equal(call<Template>('templates.get', { templateId: original.templateId, revision: 1 }).fields.length, 4);
  const saved = call<GenerationResult>('generations.result.get', { resultId: completed.result?.resultId });
  assert.equal(saved.href, `/generations/${completed.generationId}/result`);
  assert.deepEqual(saved.output, diaryOutput);
  assert.deepEqual(Object.keys(saved.output), Object.keys(diaryOutput));

  const latest = call<Generation>('generations.prepare', { ...prepareInput, projectId: two, references: [
    { kind: 'source', id: source.sourceId, revision: 2, excerpt: '晚上九点' },
  ] });
  assert.equal(latest.composition.template.fields.length, 5);
  assert.equal(latest.composition.requirements?.tone, 'Light');
  assert.match(String(latest.composition.messages[1].content), /晚上九点/);
  assert.throws(() => call('generations.save', { generationId: latest.generationId, output: diaryOutput }), { message: /\/tomorrow: field is required/ });
  assert.equal(await processNextGeneration(db, unexpectedProvider), false);
});

test('shot list validates nested paths and leaves previous outputs readable', t => {
  const { call } = openMemory(t);
  const prepared = call<Generation>('generations.prepare', { title: 'Shots', brief: 'Establish the wharf.', templateId: 'shot-list' });
  const shot = { number: 1, action: 'Boat leaves', framing: 'Wide' };
  assert.throws(() => call('generations.save', { generationId: prepared.generationId, output: { shots: [{ ...shot, number: 0 }] } }),
    { message: /\/shots\/0\/number: must be at least 1/ });
  const saved = call<Generation>('generations.save', { generationId: prepared.generationId, output: { shots: [shot] }, reportedModel: 'chat-reported' });
  assert.equal(saved.execution.reportedModelSource, 'chat-client');
  assert.equal(call<GenerationResult>('generations.result.get', { resultId: saved.result?.resultId }).output.shots instanceof Array, true);
  const templates = call<{ items: Pick<Template, 'templateId'>[] }>('templates.list', {});
  assert.deepEqual(new Set(templates.items.map(item => item.templateId)), new Set(['diary', 'screenplay', 'short-story', 'shot-list']));
});

test('a queued named delegation survives restart, is claimed once and stores an independent result', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-generation-'));
  const path = join(directory, 'test.sqlite');
  t.after(() => {
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    rmdirSync(directory);
  });
  let generationId: string;
  let planId: string;
  let queuedId: string;
  let expectedMessages: Generation['composition']['messages'];
  {
    using db = new DatabaseSync(path);
    initialize(db);
    const { call, invoke } = client(db);
    const prepared = call<Generation>('generations.prepare', { title: 'Wharf', templateId: 'diary', brief: 'Draft tonight’s diary.' });
    generationId = prepared.generationId;
    expectedMessages = prepared.composition.messages;
    const original = call<Plan>('generation.plans.create', namedPlan);
    planId = original.planId;
    assert.equal(call<{ items: Plan[] }>('generation.plans.list', { name: 'alternate DRAFT' }).items[0].planId, planId);
    const request = { generationId, planId };
    queuedId = call<Generation>('generations.start', request, 'delegation-1').generationId;
    assert.equal(invoke('generations.start', request, 'delegation-1').replayed, true);
    call('generation.plans.update', { ...namedPlan, planId, expectedRevision: 1, model: 'version-two' });
    call('generations.save', { generationId, output: diaryOutput });
    assert.equal(call<Generation>('generations.get', { generationId: queuedId }).status, 'queued');
  }
  using db = new DatabaseSync(path);
  initialize(db);
  using contender = new DatabaseSync(path);
  const { call } = client(db);
  let calls = 0;
  const delegatedOutput = { ...diaryOutput, feelings: 'Regret' };
  const provider: GenerationProvider = {
    prepare(request) {
      calls++;
      assert.equal(request.requestId, queuedId);
      assert.equal(request.plan.revision, 1);
      assert.equal(request.plan.model, 'synthetic-request');
      assert.deepEqual(request.messages, expectedMessages);
      return { endpoint: 'http://localhost/v1/chat/completions', async execute() {
        assert.equal(call<Generation>('generations.get', { generationId: queuedId }).status, 'running');
        assert.equal(await processNextGeneration(contender, unexpectedProvider), false);
        return { content: `\`\`\`json\n${JSON.stringify(delegatedOutput)}\n\`\`\``, reportedModel: 'provider-version',
          responseId: 'provider-123', finishReason: 'stop' };
      } };
    },
  };
  assert.equal(await processNextGeneration(db, provider), true);
  assert.equal(await processNextGeneration(db, provider), false);
  assert.equal(calls, 1);
  const delegated = call<Generation>('generations.get', { generationId: queuedId });
  assert.equal(delegated.status, 'succeeded');
  assert.equal(delegated.sourceGenerationId, generationId);
  assert.equal(delegated.execution.requestedModel, 'synthetic-request');
  assert.equal(delegated.execution.reportedModel, 'provider-version');
  assert.equal(delegated.execution.reportedModelSource, 'provider');
  assert.equal(delegated.execution.providerResponseId, 'provider-123');
  assert.equal(delegated.execution.providerEndpoint, 'http://localhost/v1/chat/completions');
  assert.match(delegated.rawOutput ?? '', /Regret/);
  assert.deepEqual(call<GenerationResult>('generations.result.get', { resultId: delegated.result?.resultId }).output, delegatedOutput);
  const ordinary = call<Generation>('generations.get', { generationId });
  assert.notEqual(delegated.result?.resultId, ordinary.result?.resultId);
  assert.deepEqual(call<GenerationResult>('generations.result.get', { resultId: ordinary.result?.resultId }).output, diaryOutput);
  assert.deepEqual(delegated.composition, ordinary.composition);
});

test('invalid provider outputs and interrupted requests preserve status without redispatch', async t => {
  const { db, call } = openMemory(t);
  const prepared = call<Generation>('generations.prepare', { title: 'Wharf', templateId: 'diary', brief: 'Draft.' });
  const plan = call<Plan>('generation.plans.create', namedPlan);
  const queue = () => call<Generation>('generations.start', { generationId: prepared.generationId, planId: plan.planId }).generationId;
  const failedId = queue();
  assert.equal(await processNextGeneration(db, { prepare: () => ({ async execute() {
    return { content: '{"setting":"North Port"}', reportedModel: null, responseId: null, finishReason: null };
  } }) }), true);
  const failed = call<Generation>('generations.get', { generationId: failedId });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.execution.reportedModel, null);
  assert.equal(failed.execution.reportedModelSource, null);
  assert.match(failed.error?.message ?? '', /\/events: field is required/);
  assert.equal(failed.rawOutput, '{"setting":"North Port"}');
  assert.equal(failed.result, undefined);

  const interruptedId = queue();
  db.prepare("UPDATE generation_records SET status = 'running', lease_until = 0 WHERE generation_id = ?").run(interruptedId);
  assert.equal(await processNextGeneration(db, unexpectedProvider), false);
  assert.equal(call<Generation>('generations.get', { generationId: interruptedId }).status, 'uncertain');
  assert.equal(await processNextGeneration(db, unexpectedProvider), false);
  assert.equal(call<Generation>('generations.get', { generationId: prepared.generationId }).status, 'prepared');
});

test('worker can start and stop while retaining an active request deadline', async t => {
  const { db, call } = openMemory(t);
  const { generationId } = call<Generation>('generations.prepare', { title: 'Wharf', templateId: 'diary', brief: 'Draft.' });
  const { planId } = call<Plan>('generation.plans.create', namedPlan);
  const queued = call<Generation>('generations.start', { generationId, planId });
  let resolveStarted!: () => void;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const keepAlive = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(keepAlive));
  const worker = startGenerationWorker(db, { pollIntervalMs: 10, timeoutMs: 20, provider: { prepare: () => ({ execute() {
    resolveStarted();
    return new Promise(() => {});
  } }) } });
  await started;
  await worker.stop();
  const result = call<Generation>('generations.get', { generationId: queued.generationId });
  assert.equal(result.status, 'uncertain');
  assert.match(result.error?.message ?? '', /timed out/);
});

test('batch contract survives restarts, cancels queued items and retains distinct retry outcomes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-generation-batch-'));
  const path = join(directory, 'test.sqlite');
  t.after(() => {
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
    rmdirSync(directory);
  });
  type Attempt = { position: number; attempt: number; generation: GenerationSummary };
  type Batch = { batchId: string; href: string; status: string; plan: Plan; items: Attempt[]; attempts: Attempt[];
    nextAttemptOffset?: number; counts: Record<string, number> };
  const batchOperations = ['create', 'get', 'list', 'cancel', 'retry-confirmed-failures']
    .map(verb => `generation.batches.${verb}`);
  const [create, get, list, cancel, retry] = batchOperations;
  const sent: string[] = [];
  let original: Batch;

  const success = (label: string) => ({ content: JSON.stringify({ ...diaryOutput, events: label }),
    reportedModel: 'synthetic-model', responseId: label, finishReason: 'stop' });
  {
    using db = new DatabaseSync(path);
    initialize(db);
    const registry = new Operations(db, generationOperations);
    const catalog = registry.catalog().operations;
    assert.deepEqual(catalog.filter(op => op.id.startsWith('generation.batches.')).map(op => op.id), batchOperations);
    assert.ok(catalog.find(op => op.id === create)?.inputSchema.required instanceof Array);
    const { call, invoke } = client(db);
    const plan = call<Plan>('generation.plans.create', namedPlan);
    const generationIds = Array.from({ length: 5 }, (_, index) => call<Generation>('generations.prepare', {
      title: `Diary ${index + 1}`, brief: `Synthetic text item ${index + 1}`, templateId: 'diary',
    }).generationId);
    assert.throws(() => call(create, { title: 'Text batch', generationIds }), { code: 'operation_invalid_input' });
    assert.throws(() => call(create, { title: 'Text batch', planId: plan.planId, generationIds: [generationIds[0], 'missing'] }),
      { code: 'generation_not_found' });
    assert.equal(call<{ items: unknown[] }>(list, {}).items.length, 0);
    assert.equal(call<{ items: unknown[] }>('generations.list', {}).items.length, 5);
    const input = { title: 'Text batch', planId: plan.planId, generationIds };
    original = call<Batch>(create, input, 'batch-create');
    assert.equal(invoke(create, input, 'batch-create').replayed, true);
    assert.equal(original.href, `/generation-batches/${original.batchId}`);
    assert.equal(original.counts.queued, 5);
    assert.deepEqual(original.items.map(item => item.generation.sourceGenerationId), generationIds);
    call('generation.plans.update', { ...namedPlan, planId: plan.planId, expectedRevision: 1, model: 'edited-after-enqueue' });
  }

  const lookup = { batchId: original.batchId };
  const [succeeded, failed, uncertain, running, queued] = original.items.map(item => item.generation.generationId);
  {
    using db = new DatabaseSync(path);
    initialize(db);
    using cancelConnection = new DatabaseSync(path);
    const { call } = client(db);
    let informStarted!: () => void;
    const started = new Promise<void>(resolve => { informStarted = resolve; });
    let releaseRunning!: () => void;
    const pause = new Promise<void>(resolve => { releaseRunning = resolve; });
    const provider: GenerationProvider = {
      prepare(request) {
        assert.equal(request.plan.revision, 1);
        sent.push(request.requestId);
        return { async execute() {
          switch (request.requestId) {
            case succeeded: return success('original success');
            case failed: return { ...success('invalid draft'), content: '{"setting":"North Port"}' };
            case uncertain: throw new Error('connection ended after sending');
            case running:
              informStarted();
              await pause;
              return success('completed in flight');
            default: assert.fail('Unexpected provider request');
          }
        } };
      },
    };
    assert.equal(call<Batch>(get, lookup).counts.queued, 5);
    for (let index = 0; index < 3; index++) assert.equal(await processNextGeneration(db, provider), true);
    assert.deepEqual(sent, [succeeded, failed, uncertain]);
    const processing = processNextGeneration(db, provider);
    await started;
    try {
      const other = new Operations(cancelConnection, generationOperations);
      const canceled = other.invoke('connection:cancel', { operationId: cancel, stepId: 'batch-cancel', input: lookup }).result as Batch;
      assert.equal(canceled.counts.running, 1);
      assert.equal(canceled.counts.canceled, 1);
      assert.equal(canceled.items[4].generation.status, 'canceled');
      assert.equal(call<Generation>('generations.get', { generationId: queued }).status, 'canceled');
      assert.equal(await processNextGeneration(cancelConnection, unexpectedProvider), false);
    } finally {
      releaseRunning();
      await processing;
    }
    assert.deepEqual(sent, [succeeded, failed, uncertain, running]);
    const completed = call<Batch>(get, lookup);
    assert.equal(completed.status, 'uncertain');
    assert.deepEqual(completed.counts, { queued: 0, running: 0, succeeded: 2, failed: 1, uncertain: 1, canceled: 1 });
    assert.throws(() => call(retry, { ...lookup, positions: [2, 3] }),
      { code: 'generation_batch_retry_ineligible', message: /position 3 is uncertain/ });
    assert.equal(call<Batch>(get, lookup).attempts.length, 5);
    const input = { ...lookup, positions: [2] };
    const { invoke } = client(db);
    const retried = invoke(retry, input, 'batch-retry').result as Batch;
    assert.equal(invoke(retry, input, 'batch-retry').replayed, true);
    assert.equal(retried.items[1].attempt, 2);
    assert.equal(retried.counts.queued, 1);
    assert.equal(retried.attempts[1].generation.generationId, failed);
    assert.notEqual(retried.items[1].generation.generationId, failed);
  }

  using db = new DatabaseSync(path);
  initialize(db);
  const { call } = client(db);
  const pending = call<Batch>(get, lookup).items[1];
  assert.equal(pending.generation.status, 'queued');
  assert.equal(await processNextGeneration(db, { prepare(request) {
    assert.equal(request.requestId, pending.generation.generationId);
    assert.equal(request.plan.model, 'synthetic-request');
    sent.push(request.requestId);
    return { async execute() { return success('successful retry'); } };
  } }), true);
  const record = call<Batch>(get, { ...lookup, attemptLimit: 2 });
  assert.equal(record.attempts.length, 2);
  assert.equal(record.nextAttemptOffset, 2);
  const history = call<Batch>(get, { ...lookup, attemptOffset: record.nextAttemptOffset });
  assert.equal(history.attempts.length, 4);
  assert.equal(record.attempts[1].generation.status, 'failed');
  assert.equal(record.items[1].generation.status, 'succeeded');
  assert.equal(call<Generation>('generations.get', { generationId: failed }).rawOutput, '{"setting":"North Port"}');
  const readEvents = (attempt: Attempt) => call<GenerationResult>('generations.result.get', { resultId: attempt.generation.result?.resultId }).output.events;
  assert.equal(readEvents(record.items[0]), 'original success');
  assert.equal(readEvents(record.items[1]), 'successful retry');
  assert.equal(readEvents(record.items[3]), 'completed in flight');
  assert.equal(call<{ items: Batch[] }>(list, {}).items[0].counts.succeeded, 3);
  assert.equal(await processNextGeneration(db, unexpectedProvider), false);
  assert.deepEqual(sent, [succeeded, failed, uncertain, running, pending.generation.generationId]);
});
