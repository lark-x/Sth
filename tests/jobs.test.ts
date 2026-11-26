import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createComfyProvider, createMediaProviderFromEnv, getMediaProviderStatus, readMediaBinary, readMediaMetadata,
  startJobsWorker } from '../src/jobs/index.ts';
import { fixture, waitFor, type Job } from './jobs-fixture.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ4sAAAAASUVORK5CYII=', 'base64');
const workflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'default text' } },
  '2': { class_type: 'KSampler', inputs: { seed: 57, steps: 19 } },
  '3': { class_type: 'SaveImage', inputs: {} },
};

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
}

async function mockComfy(t: TestContext) {
  const submissions: { requestId: string; text: string }[] = [];
  const results = new Map<string, 'running' | 'success' | 'error'>();
  const graphById = new Map<string, unknown>();
  let transfers = 0;
  let available = true;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/system_stats') {
      reply(res, available ? 200 : 503, available ? { system: { comfyui_version: '0.45.2' } } : {});
      return;
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { prompt, prompt_id: requestId, extra_data: { sth_request_id } } = JSON.parse(raw);
      assert.equal(sth_request_id, requestId);
      assert.deepEqual(prompt['2'].inputs, workflow['2'].inputs);
      const text: string = prompt['1'].inputs.text;
      submissions.push({ requestId, text });
      graphById.set(requestId, prompt);
      if (text === 'scene-2' && submissions.filter(item => item.text === text).length === 1) {
        results.set(requestId, 'error');
      } else if (text === 'scene-3') {
        // Lose the acknowledgment. The test makes history available after one inconclusive lookup.
        req.socket.destroy();
        return;
      } else if (text === 'scene-4') {
        results.set(requestId, 'running');
        return; // Hold the response open until the worker process is terminated.
      } else {
        results.set(requestId, 'success');
      }
      reply(res, 200, { prompt_id: requestId });
      return;
    }
    const promptTuple = (id: string) => [1, id, graphById.get(id), { sth_request_id: id }];
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.split('/').at(-1)!;
      const status = results.get(id);
      const entry = { prompt: promptTuple(id), status: { status_str: status, completed: status === 'success' },
        outputs: { '3': { images: [{ filename: `${id}.png`, subfolder: 'output folder', type: 'output' }] } } };
      reply(res, 200, status && status !== 'running' ? { [id]: entry } : {});
      return;
    }
    if (url.pathname === '/queue') {
      reply(res, 200, { queue_pending: [], queue_running: [...results].filter(([, state]) => state === 'running')
        .map(([id]) => promptTuple(id)) });
      return;
    }
    if (url.pathname === '/view') {
      assert.equal(url.searchParams.get('subfolder'), 'output folder');
      assert.equal(url.searchParams.get('type'), 'output');
      transfers++;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }).end(png);
      return;
    }
    reply(res, 404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { settings: { url, workflow, promptNode: '1', outputNode: '3' }, submissions, results, transfers: () => transfers,
    makeUnavailable: () => { available = false; } };
}

test('five pinned scenes recover across a killed worker, cancel remaining, retry only failure and reconcile by request id', {
  timeout: 20_000,
}, async t => {
  const { db, file, invoke, operations, projectId, makeCompositions, select, readJob } = fixture(t);
  const compositions = makeCompositions(['scene-1', 'scene-2', 'scene-3', 'scene-4', 'scene-5']);
  const items = compositions.map(entry => entry.selection);
  const input = { projectId, title: 'Five scenes', items };
  assert.throws(() => invoke('jobs.create', input), { code: 'jobs_selection_required' });
  for (const item of items) select(item);
  assert.throws(() => select(items[0]), { code: 'composition_selection_conflict' });
  const { projectId: otherProjectId } = invoke<{ projectId: string }>('project.create', { title: 'Another project' });
  assert.throws(() => invoke('composition.create', { ...compositions[0].input, projectId: otherProjectId }),
    { code: 'composition_scene_project_mismatch' });
  assert.throws(() => invoke('jobs.create', { ...input, projectId: otherProjectId }), { code: 'jobs_selection_required' });
  assert.throws(() => invoke('composition.create', { ...compositions[0].input, sceneRevision: 9 }), { statusCode: 404 });
  const job = invoke<Job>('jobs.create', input, 'batch-creation');
  assert.deepEqual(invoke('jobs.create', input, 'batch-creation'), job);
  assert.equal(operations.receipt('jobs-fixture', { operationId: 'jobs.create', stepId: 'batch-creation' }).replayed, true);
  const { jobId } = job;
  // Editing a scene and reselecting after enqueue must leave the queued request unchanged.
  const first = compositions[0].result;
  invoke('scene.revise', { sceneId: first.scene.sceneId, expectedRevision: 1, title: 'A newer title' });
  select({ compositionId: first.compositionId, candidateId: first.candidates[1].candidateId }, 1);

  const mock = await mockComfy(t);
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { DatabaseSync } from 'node:sqlite';
    import { createComfyProvider, startJobsWorker } from './src/jobs/index.ts';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    startJobsWorker(db, { provider: createComfyProvider(JSON.parse(process.argv[2])),
      pollIntervalMs: 15, requestTimeoutMs: 1000, leaseMs: 1700 });
  `, file, JSON.stringify(mock.settings)], { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true });
  const exited = once(child, 'exit');
  let diagnostics = '';
  child.stderr!.on('data', chunk => { diagnostics += chunk; });
  using secondDb = new DatabaseSync(file);
  secondDb.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  let second: ReturnType<typeof startJobsWorker> | undefined;
  try {
    await waitFor(() => mock.submissions.map(({ text }) => text), texts => texts.includes('scene-4'));
    const before = readJob(jobId);
    assert.deepEqual(before.items.map(item => item.status), ['succeeded', 'failed', 'unknown', 'submitting', 'queued']);
    const fourthId = before.items[3].attempt!.requestId;
    assert.equal(mock.submissions[3].requestId, fourthId);
    assert.equal(before.items[0].scene.title, 'Scene 1');
    assert.equal(before.items[0].candidateId, items[0].candidateId);
    const historical = invoke<{ title: string }>('scene.read', { sceneId: first.scene.sceneId, revision: first.scene.revision });
    assert.equal(historical.title, 'Scene 1');

    second = startJobsWorker(secondDb, { provider: createComfyProvider(mock.settings), pollIntervalMs: 15 });
    const canceled = invoke<Job>('jobs.cancel', { jobId });
    assert.equal(canceled.progress.canceled, 1);
    assert.equal(canceled.progress.submitting, 1);
    child.kill();
    await exited;

    const restarted = await waitFor(() => readJob(jobId), current => current.progress.unknown === 2);
    const [firstItem, failed, unknown, interrupted, canceledItem] = restarted.items;
    assert.equal(interrupted.attempt?.requestId, fourthId);
    assert.match(interrupted.attempt!.message!, /stopped before recording/);
    assert.equal(canceledItem.status, 'canceled');
    assert.deepEqual(mock.submissions.map(item => item.text), ['scene-1', 'scene-2', 'scene-3', 'scene-4']);
    for (const item of [firstItem, unknown, interrupted, canceledItem]) {
      assert.throws(() => invoke('jobs.retry', { jobId, itemIds: [item.itemId] }), { code: 'jobs_ineligible_item' });
    }

    invoke('jobs.reconcile', { jobId, itemIds: [unknown.itemId, interrupted.itemId] });
    const lookedUp = await waitFor(() => readJob(jobId), current => !current.items[2].reconciliationQueued
      && current.items[3].status === 'submitted');
    assert.equal(lookedUp.items[2].status, 'unknown');
    assert.match(lookedUp.items[2].attempt!.message!, /Absence does not confirm failure/);
    assert.equal(lookedUp.items[3].attempt?.providerJobId, fourthId);
    await second.stop();
    second = undefined;
    assert.equal(readJob(jobId).items[3].status, 'submitted');

    mock.results.set(fourthId, 'success');
    mock.results.set(unknown.attempt!.requestId, 'success');
    invoke('jobs.reconcile', { jobId, itemIds: [unknown.itemId] });
    invoke('jobs.retry', { jobId, itemIds: [failed.itemId] }, 'retry-once');
    invoke('jobs.retry', { jobId, itemIds: [failed.itemId] }, 'retry-once');
    second = startJobsWorker(secondDb, { provider: createComfyProvider(mock.settings), pollIntervalMs: 15 });
    const done = await waitFor(() => readJob(jobId), current => current.progress.succeeded === 4);
    assert.equal(done.items[0].mediaId, firstItem.mediaId);
    assert.equal(done.items[1].attempt?.number, 2);
    assert.notEqual(done.items[1].attempt?.requestId, failed.attempt?.requestId);
    assert.equal(done.items[2].attempt?.requestId, unknown.attempt?.requestId);
    assert.equal(done.items[3].attempt?.requestId, fourthId);
    assert.equal(done.attemptsStarted, 5);
    assert.equal(mock.transfers(), 4);
    assert.deepEqual(mock.submissions.map(item => item.text), ['scene-1', 'scene-2', 'scene-3', 'scene-4', 'scene-2']);
    assert.equal(db.prepare('SELECT count(*) AS total FROM media_job_attempts').get()?.total, 5);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const mediaId = firstItem.mediaId!;
    const media = invoke<ReturnType<typeof readMediaMetadata>>('media.read', { mediaId });
    assert.equal(media.projectId, projectId);
    assert.deepEqual(media.scene, firstItem.scene);
    assert.match(media.scene.href, /\?revision=1$/);
    assert.equal(media.href, `/media/${mediaId}`);
    assert.equal(media.contentHref, `/api/web/media/${mediaId}/content`);
    assert.equal(media.attempt.parameters['2.seed'], 57);
    assert.deepEqual(Buffer.from(readMediaBinary(db, mediaId).bytes), png);
    assert.throws(() => readMediaBinary(db, 'missing'), { code: 'media_not_found' });
    assert.equal(invoke<{ items: Job[] }>('jobs.list', { projectId }).items[0].jobId, jobId);
    assert.equal(invoke<{ items: unknown[] }>('composition.list', { projectId }).items.length, 5);
    type Gallery = { items: Omit<ReturnType<typeof readMediaMetadata>, 'attempt'>[] };
    assert.equal(invoke<Gallery>('media.list', { projectId, jobId }).items.length, 4);
    assert.equal(invoke<Gallery>('media.list', { jobId, limit: 2, offset: 1 }).items.length, 2);
    assert.deepEqual(invoke<Gallery>('media.list', { projectId: otherProjectId }).items, []);
    assert.deepEqual(invoke<Gallery>('media.list', { sceneId: media.scene.sceneId, sceneRevision: 2 }).items, []);
    const { attempt: _attempt, ...summary } = media;
    assert.deepEqual(invoke<Gallery>('media.list', { sceneId: media.scene.sceneId, sceneRevision: 1 }).items, [summary]);
  } catch (error) {
    if (diagnostics) t.diagnostic(diagnostics);
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await second?.stop();
  }
});

test('autonomous budgets reserve submitted attempts and manual mode leaves provider defaults intact', async t => {
  const { db, projectId, invoke, readJob, makeCompositions, select } = fixture(t);
  const [first] = makeCompositions(['example']);
  select(first.selection);
  const common = { projectId, title: 'Budget', items: [first.selection] };
  assert.throws(() => invoke('jobs.create', { ...common, mode: 'autonomous' }), { code: 'jobs_invalid_budget' });
  assert.throws(() => invoke('jobs.create', { ...common, maxImages: 1 }), { code: 'jobs_invalid_budget' });
  const manual = invoke<Job>('jobs.create', common);
  const autonomous = invoke<Job>('jobs.create', { ...common, mode: 'autonomous', maxImages: 1 });
  assert.equal(manual.mode, 'manual');
  const worker = startJobsWorker(db, { provider: {
    name: 'test', key: 'test', parameters: {},
    async submit() { return { state: 'failed', message: 'Known rejection' }; },
    async lookup() { throw new Error('Known rejection should not be looked up'); },
  }, pollIntervalMs: 15 });
  try {
    await waitFor(() => readJob(autonomous.jobId), current => current.progress.failed === 1);
    await waitFor(() => readJob(manual.jobId), current => current.progress.failed === 1);
    assert.throws(() => invoke('jobs.retry', { jobId: autonomous.jobId }), { code: 'jobs_budget_exhausted' });
    assert.equal(invoke<Job>('jobs.retry', { jobId: manual.jobId }).progress.queued, 1);
    const retried = await waitFor(() => readJob(manual.jobId), current => current.progress.failed === 1);
    assert.equal(retried.attemptsStarted, 2);
  } finally {
    await worker.stop();
  }
});

test('ComfyUI is opted in, validates one output and reports endpoint availability', async t => {
  assert.equal(createMediaProviderFromEnv({}), undefined);
  assert.throws(() => createMediaProviderFromEnv({ STH_COMFY_URL: 'http://localhost' }), /Set STH_COMFY_URL/);
  assert.throws(() => createComfyProvider({ url: 'http://localhost', promptNode: '1', outputNode: '3',
    workflow: { ...workflow, '4': { class_type: 'EmptyLatentImage', inputs: { batch_size: 2 } } } }), /one image/);
  assert.equal((await getMediaProviderStatus()).status, 'unconfigured');
  assert.equal((await getMediaProviderStatus(undefined, true)).status, 'invalid_config');
  const mock = await mockComfy(t);
  const provider = createComfyProvider(mock.settings);
  const ready = await getMediaProviderStatus(provider);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.provider, 'comfyui');
  mock.makeUnavailable();
  assert.equal((await getMediaProviderStatus(provider)).status, 'unreachable');
});
