import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { openDatabase } from '../../src/database.ts';
import { startJobsWorker } from '../../src/jobs/index.ts';
import { createApp } from '../../src/server.ts';
import { assertFitsViewport } from '../../tests/browser/harness.mjs';
import { matchTasksRoute, resolveTasksRoute } from '../tasks/routes.ts';

const root = resolve(import.meta.dirname, '../..');
const desktop = { width: 1280, height: 900 };
const mobile = { width: 320, height: 800 };
const timeout = 60_000;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ4sAAAAASUVORK5CYII=', 'base64');

// Exercise the actual shell registry with fixture-owned HTTP and HMR servers.
async function fixture(t, { viewport = desktop, provider } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sth-tasks-vue-'));
  const db = openDatabase(join(directory, 'data'));
  const api = createApp(db, { mediaProvider: provider });
  let vite;
  const web = createServer();
  let browser;
  const workers = [];
  t.after(async () => {
    await browser?.close();
    await Promise.all(workers.map(worker => worker.stop()));
    await vite?.close();
    web.closeAllConnections();
    if (web.listening) await new Promise(done => web.close(done));
    api.closeAllConnections();
    await new Promise(done => api.close(done));
    db.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.match(basename(directory), /^sth-tasks-vue-[a-z0-9]+$/i);
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  await new Promise(done => api.listen(0, '127.0.0.1', done));
  const backend = `http://127.0.0.1:${api.address().port}`;
  vite = await createViteServer({
    root: join(root, 'web'), configFile: false, publicDir: false,
    cacheDir: join(directory, 'vite-cache'), logLevel: 'error',
    resolve: { alias: { '/frontend': join(root, 'frontend') } },
    plugins: [vue()],
    server: { middlewareMode: true, hmr: { server: web }, watch: null, proxy: { '/api': {
      target: backend, changeOrigin: true,
      configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', backend)); },
    } } },
    optimizeDeps: { noDiscovery: true, include: ['vue', 'reka-ui', '@lucide/vue'] },
  });
  web.on('request', vite.middlewares);
  await new Promise(done => web.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${web.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: origin, viewport, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  const offsite = [];
  const socketHosts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socketHosts.push(new URL(socket.url()).host));
  page.on('request', request => { if (new URL(request.url()).origin !== origin) offsite.push(request.url()); });
  t.after(() => {
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.deepEqual(offsite, [], 'all browser requests use the isolated service');
    assert.ok(socketHosts.length > 0, 'Vite HMR opens a socket during the browser test');
    assert.ok(socketHosts.every(host => host === new URL(origin).host), 'HMR sockets use this fixture HTTP server');
  });
  async function invoke(operationId, input) {
    const response = await fetch(`${backend}/api/web/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, input, stepId: `tasks-vue:${randomUUID()}` }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  return { page, origin, invoke, work: () => workers.push(startJobsWorker(db, { provider, pollIntervalMs: 15 })) };
}

const heading = (page, title) => page.getByRole('heading', { level: 1, name: title, exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const link = (page, name) => page.getByRole('link', { name, exact: true });
async function goto(page, path, title) {
  assert.equal((await page.goto(path)).status(), 200);
  await heading(page, title).waitFor();
  await page.locator('.tasks-domain:not(:has(> [role="status"]))').waitFor();
}
async function until(check) {
  const deadline = Date.now() + 8000;
  do {
    const result = await check();
    if (result) return result;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail('isolated worker did not reach the expected state');
}
async function capture(page, name) {
  if (!process.env.STH_TASKS_ARTIFACTS) return;
  await mkdir(process.env.STH_TASKS_ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(process.env.STH_TASKS_ARTIFACTS, `${name}.png`), fullPage: true, animations: 'disabled' });
}
async function composition(invoke, projectId, sceneId, prompt) {
  const saved = await invoke('composition.create', { projectId, sceneId, sceneRevision: 1, candidates: [{ title: prompt, prompt }] });
  await invoke('composition.select', { compositionId: saved.compositionId,
    candidateId: saved.candidates[0].candidateId, expectedSelectionRevision: saved.selectionRevision });
  return { compositionId: saved.compositionId, candidateId: saved.candidates[0].candidateId };
}
async function setupJob(invoke, title = '北港出图', prompts = ['渡船画面']) {
  const { projectId } = await invoke('project.create', { title: `${title}项目` });
  const chapter = await invoke('chapter.create', { projectId, title: '夜航' });
  const scene = await invoke('scene.create', { title: '渡船甲板' });
  await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: chapter.revision, sceneIds: [scene.sceneId] });
  const items = [];
  for (const prompt of prompts) items.push(await composition(invoke, projectId, scene.sceneId, prompt));
  const job = await invoke('jobs.create', { projectId, title, items });
  return { job, projectId, scene, items };
}

test('tasks matcher owns only migrated lists, media details and readable job details', () => {
  const url = path => new URL(path, 'http://127.0.0.1:12345');
  for (const path of ['/jobs', '/tasks/', '/jobs?offset=20&projectId=abc', '/tasks/job_1?from=diary#progress', '/jobs/%61bc/', '/media/media-1']) {
    assert.equal(matchTasksRoute(url(path)), true, path);
  }
  for (const path of ['/', '/jobs/new', '/tasks/%6Eew', '/media/new', '/media', '/media/', '/jobs/a/edit', '/jobs/a?action=cancel', '/media/a?edit=1', '/jobs//a', '/jobs/%2Fa', '/jobs/%ZZ', '/tasks/a.b', '/tasks/a%5Cb', '/generations/a', '/generation-batches/a', '/compositions/a', `/jobs/${'a'.repeat(129)}`]) {
    assert.equal(matchTasksRoute(url(path)), false, path);
  }
  assert.deepEqual(resolveTasksRoute(url('/tasks/job_1')), { kind: 'job', id: 'job_1' });
});

test('Vue activity preserves cross-kind ordering, both list aliases, pagination, reload and legacy links', { timeout }, async t => {
  const { page, invoke } = await fixture(t);
  const prepared = await invoke('generations.prepare', { title: '任务测试', brief: '写作', templateId: 'short-story' });
  const plan = await invoke('generation.plans.create', { title: '后台方案', executor: 'openai-compatible', provider: 'fixture', model: 'fixture', parameters: {} });
  for (let index = 0; index < 21; index++) await invoke('generations.start', { generationId: prepared.generationId, planId: plan.planId });
  await invoke('generation.batches.create', { title: '批量任务', planId: plan.planId, generationIds: [prepared.generationId] });
  const { projectId } = await setupJob(invoke);
  const expected = await invoke('tasks.list', { limit: 20, offset: 0 });
  await goto(page, `/jobs?projectId=${projectId}&from=diary`, '任务');
  const rows = page.locator('.task-row h2 a');
  assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.getAttribute('href'))), expected.items.map(item => item.href));
  assert.equal(await page.locator('search').count(), 0, 'tasks.list has no unsupported filters');
  await page.getByText('图片供应商 · 未配置', { exact: true }).waitFor();
  assert.equal(await link(page, '新建任务').getAttribute('href'), `/jobs/new?projectId=${projectId}`);
  await assertFitsViewport(page);
  await capture(page, 'desktop-activity');
  await link(page, '下一页').click();
  assert.equal(new URL(page.url()).searchParams.get('projectId'), projectId);
  assert.equal(new URL(page.url()).searchParams.get('from'), 'diary');
  assert.equal(new URL(page.url()).searchParams.get('offset'), String(expected.nextOffset));
  await page.reload();
  await rows.first().waitFor();
  assert.equal(await rows.count(), 3);
  await rows.first().click();
  await page.locator('.legacy-route').waitFor();
  await link(page, '提示词组成').click();
  await heading(page, '提示词组成').waitFor();
  await page.setViewportSize(mobile);
  await goto(page, '/tasks?offset=invalid', '任务');
  assert.equal(await rows.count(), 20);
  await link(page, '下一页').click();
  await page.waitForURL(`**/tasks?offset=${expected.nextOffset}`);
  await assertFitsViewport(page);
  await capture(page, 'mobile-activity');
  await page.goBack();
  await rows.nth(19).waitFor();
  assert.match(page.url(), /\/tasks\?offset=invalid$/);
});

test('catalog fallback keeps the original project filter and every page scoped through refresh and reset', { timeout }, async t => {
  const { page, invoke } = await fixture(t, { viewport: mobile });
  const first = await setupJob(invoke, '项目甲任务');
  for (let index = 0; index < 20; index++) await invoke('jobs.create', { projectId: first.projectId, title: `甲任务 ${index}`, items: first.items });
  const second = await setupJob(invoke, '项目乙任务');
  await page.route('**/api/web/catalog', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.operations = data.operations.filter(operation => operation.id !== 'tasks.list');
    await route.fulfill({ response, json: data });
  });
  await goto(page, `/tasks?projectId=${first.projectId}&from=author`, '任务');
  assert.equal(await page.locator('.task-row').count(), 20);
  await page.getByLabel('项目', { exact: true }).selectOption(second.projectId);
  assert.equal(await page.locator('.task-row').count(), 20, 'selection waits for the explicit filter submission');
  await button(page, '筛选').click();
  await page.locator('.task-row h2 a', { hasText: '项目乙任务' }).waitFor();
  assert.equal(await page.locator('.task-row').count(), 1);
  assert.equal(new URL(page.url()).searchParams.get('from'), 'author');
  await page.getByLabel('项目', { exact: true }).selectOption(first.projectId);
  await button(page, '筛选').click();
  await link(page, '下一页').waitFor();
  await link(page, '下一页').click();
  await page.locator('.task-row').waitFor();
  assert.equal(await page.locator('.task-row').count(), 1);
  await button(page, '刷新状态').click();
  await page.getByLabel('项目', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('项目', { exact: true }).inputValue(), first.projectId);
  assert.equal(new URL(page.url()).searchParams.get('offset'), '20');
  await link(page, '上一页').click();
  await page.locator('.task-row').nth(19).waitFor();
  await page.getByLabel('项目', { exact: true }).selectOption('');
  await button(page, '筛选').click();
  await page.getByLabel('项目', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('projectId'), false);
  assert.equal(new URL(page.url()).searchParams.has('offset'), false);
  await assertFitsViewport(page);
  await capture(page, 'mobile-project-filter');
});

test('Vue job actions retry once via receipts, reconcile, preview exact image bytes, download and follow pinned provenance', { timeout }, async t => {
  const submissions = new Map();
  const provider = { name: 'fixture', key: 'tasks-vue-provider', parameters: { width: 1, height: 1, seed: 17 },
    async submit({ prompt, requestId }) {
      const count = (submissions.get(prompt) ?? 0) + 1;
      submissions.set(prompt, count);
      if (prompt === '失败后重试' && count === 1) return { state: 'failed', message: 'fixture rejection' };
      if (prompt === '需要核对') return { state: 'unknown', message: 'fixture lost receipt' };
      return { state: 'submitted', providerJobId: requestId };
    },
    async lookup({ requestId }) { return { state: 'succeeded', providerJobId: requestId, bytes: png }; },
  };
  const { page, invoke, work } = await fixture(t, { viewport: { width: 390, height: 844 }, provider });
  const { job, scene, items } = await setupJob(invoke, '北港出图', ['失败后重试', '需要核对']);
  work();
  await until(async () => { const current = await invoke('jobs.read', { jobId: job.jobId }); return current.progress.failed === 1 && current.progress.unknown === 1; });
  await goto(page, `/tasks/${job.jobId}`, job.title);
  assert.equal(await page.getByRole('progressbar', { name: '已结束任务项' }).getAttribute('value'), '1');
  await capture(page, 'mobile-job-before');
  let first;
  let writes = 0;
  await page.route('**/api/web/invoke', async route => {
    const call = route.request().postDataJSON();
    if (call.operationId !== 'jobs.retry') return route.continue();
    writes++;
    if (first) return route.continue();
    first = call;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort();
  });
  await button(page, '重试 失败后重试').click();
  await page.getByRole('alert').getByText(/请重试同一次提交/).waitFor();
  const receipt = page.waitForRequest('**/api/web/receipt');
  await button(page, '重试同一次提交').click();
  assert.deepEqual((await receipt).postDataJSON(), { operationId: first.operationId, stepId: first.stepId });
  assert.deepEqual(first.input, { jobId: job.jobId, itemIds: [job.items[0].itemId] });
  await button(page, '核对 需要核对').waitFor();
  await button(page, '核对 需要核对').click();
  const stored = await until(async () => { const current = await invoke('jobs.read', { jobId: job.jobId }); return current.progress.succeeded === 2 && current; });
  assert.equal(writes, 1);
  assert.equal(submissions.get('失败后重试'), 2);
  assert.equal(submissions.get('需要核对'), 1);
  await button(page, '刷新状态').click();
  await link(page, '查看生成图片').first().waitFor();
  await link(page, '查看生成图片').first().click();
  await heading(page, stored.items[0].title).waitFor();
  const image = page.getByRole('img', { name: stored.items[0].title, exact: true });
  await image.waitFor();
  await until(() => image.evaluate(element => element.complete && element.naturalWidth === 1));
  const src = await image.getAttribute('src');
  assert.equal(src, `/api/web/media/${stored.items[0].mediaId}/content`);
  assert.deepEqual(await (await page.request.get(src)).body(), png);
  const downloadEvent = page.waitForEvent('download');
  await link(page, '下载媒体文件').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), '失败后重试.png');
  assert.deepEqual(await readFile(await download.path()), png);
  const popupEvent = page.waitForEvent('popup');
  await link(page, '打开媒体文件').click();
  const popup = await popupEvent;
  assert.equal(new URL(popup.url()).pathname, src);
  await popup.close();
  assert.equal(await link(page, '查看构图').getAttribute('href'), `/compositions/${items[0].compositionId}`);
  await assertFitsViewport(page);
  await capture(page, 'mobile-media');
  await page.setViewportSize(desktop);
  await assertFitsViewport(page);
  await capture(page, 'desktop-media');
  await link(page, '查看场景 · 第 1 版').click();
  await heading(page, scene.title).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('revision'), '1');
  await goto(page, `/jobs/${job.jobId}`, job.title);
  await page.getByRole('navigation', { name: '任务视图' }).getByRole('link', { name: '全部任务' }).click();
  await heading(page, '任务').waitFor();
  await page.getByText('图片供应商 · 可用 · fixture', { exact: true }).waitFor();
  await link(page, '新建任务').click();
  await heading(page, '新建任务').waitFor();
  await page.locator('.legacy-route').waitFor();
});

test('cancel stays behind confirmation and changes only the queued job items', { timeout }, async t => {
  const { page, invoke } = await fixture(t, { viewport: mobile });
  const { job } = await setupJob(invoke);
  await goto(page, `/jobs/${job.jobId}`, job.title);
  assert.equal(await button(page, '确认取消待执行项').isVisible(), false);
  await page.getByText('取消待执行项', { exact: true }).click();
  await button(page, '确认取消待执行项').click();
  await page.locator('.task-items').getByText('· 已取消', { exact: true }).waitFor();
  await page.locator('#announcement').getByText('操作已保存', { exact: true }).waitFor();
  const result = await invoke('jobs.read', { jobId: job.jobId });
  assert.equal(result.progress.canceled, 1);
  assert.equal(result.attemptsStarted, 0);
  assert.equal(await button(page, '确认取消待执行项').count(), 0);
  await assertFitsViewport(page);
});

test('bulk retry and reconciliation use the shared job actions without resubmitting unknown items', { timeout }, async t => {
  const submissions = new Map();
  const provider = { name: 'fixture', key: 'bulk-provider', parameters: {},
    async submit({ prompt, requestId }) {
      const count = (submissions.get(prompt) ?? 0) + 1;
      submissions.set(prompt, count);
      if (prompt.startsWith('核对')) return { state: 'unknown', message: 'fixture unknown' };
      if (count === 1) return { state: 'failed', message: 'fixture failed' };
      return { state: 'submitted', providerJobId: requestId };
    },
    async lookup({ requestId }) { return { state: 'succeeded', providerJobId: requestId, bytes: png }; },
  };
  const { page, invoke, work } = await fixture(t, { viewport: mobile, provider });
  const { job } = await setupJob(invoke, '批量操作', ['失败一', '失败二', '核对一', '核对二']);
  work();
  await until(async () => { const current = await invoke('jobs.read', { jobId: job.jobId }); return current.progress.failed === 2 && current.progress.unknown === 2; });
  await goto(page, `/jobs/${job.jobId}`, job.title);
  const retry = page.waitForRequest(request => request.url().endsWith('/api/web/invoke') && request.postDataJSON()?.operationId === 'jobs.retry');
  await button(page, '重试失败项').click();
  assert.deepEqual((await retry).postDataJSON().input, { jobId: job.jobId });
  await button(page, '核对待确认项').waitFor();
  const reconcile = page.waitForRequest(request => request.url().endsWith('/api/web/invoke') && request.postDataJSON()?.operationId === 'jobs.reconcile');
  await button(page, '核对待确认项').click();
  assert.deepEqual((await reconcile).postDataJSON().input, { jobId: job.jobId });
  await until(async () => (await invoke('jobs.read', { jobId: job.jobId })).progress.succeeded === 4);
  assert.deepEqual(Object.fromEntries(submissions), { 失败一: 2, 失败二: 2, 核对一: 1, 核对二: 1 });
  await button(page, '刷新状态').click();
  await page.getByText('4 / 4 项已结束', { exact: true }).waitFor();
  assert.equal(await button(page, '重试失败项').count(), 0);
  assert.equal(await button(page, '核对待确认项').count(), 0);
  await assertFitsViewport(page);
});

test('read errors and empty lists recover, reject unsafe media URLs and preserve preview recovery', { timeout }, async t => {
  let previewBytes = png;
  const provider = { name: 'fixture', key: 'preview-provider', parameters: {},
    async submit({ requestId }) { return { state: 'submitted', providerJobId: requestId }; },
    async lookup({ requestId }) { return { state: 'succeeded', providerJobId: requestId, bytes: previewBytes }; },
  };
  const { page, invoke, work } = await fixture(t, { viewport: mobile, provider });
  let failure = 401;
  await page.route('**/api/web/invoke', async route => {
    const call = route.request().postDataJSON();
    if (call.operationId === 'tasks.list' && failure) return route.fulfill({ status: failure, json: { error: { message: 'fixture' } } });
    await route.continue();
  });
  await goto(page, '/jobs', '任务');
  await page.getByRole('alert').getByText('当前无法访问，请检查 Sth 的访问地址和登录状态。', { exact: true }).waitFor();
  failure = 503;
  await button(page, '重试').click();
  await page.getByRole('alert').getByText('本地服务处理失败，请重试。', { exact: true }).waitFor();
  failure = 0;
  await button(page, '重试').click();
  await page.getByText('暂无任务', { exact: true }).waitFor();
  previewBytes = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 900;
    const context = canvas.getContext('2d');
    context.fillStyle = '#eaf0e9';
    context.fillRect(0, 0, 1600, 900);
    context.fillStyle = '#285a46';
    context.fillRect(180, 180, 1240, 540);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const { job } = await setupJob(invoke);
  work();
  const stored = await until(async () => { const current = await invoke('jobs.read', { jobId: job.jobId }); return current.progress.succeeded === 1 && current; });
  const id = stored.items[0].mediaId;
  let unsafe = true;
  await page.route('**/api/web/invoke', async route => {
    if (route.request().postDataJSON().operationId !== 'media.read') return route.fallback();
    const response = await route.fetch();
    const data = await response.json();
    if (unsafe) data.result.contentHref = 'https://unsafe.invalid/image.png';
    await route.fulfill({ response, json: data });
  });
  await goto(page, `/media/${id}`, '媒体');
  await page.getByRole('alert').getByText(/数据无法读取/).waitFor();
  assert.equal(await page.locator('.task-media img').count(), 0);
  unsafe = false;
  let failImage = true;
  await page.route('**/api/web/media/*/content', route => failImage ? route.fulfill({ status: 503, body: '' }) : route.continue());
  await button(page, '重试').click();
  await page.getByText('图片预览暂时无法加载。', { exact: true }).waitFor();
  await link(page, '下载媒体文件').waitFor();
  await link(page, '查看任务').waitFor();
  failImage = false;
  await button(page, '重试预览').click();
  await until(() => page.locator('.task-media img').evaluate(element => element.complete && element.naturalWidth === 1600));
  await assertFitsViewport(page);
  await capture(page, 'mobile-large-preview');
  await page.setViewportSize(desktop);
  await assertFitsViewport(page);
  await capture(page, 'desktop-large-preview');
  await goto(page, '/jobs/missing', '任务详情');
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('.task-items').count(), 0);
  await goto(page, '/media/missing', '媒体');
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('.task-media img').count(), 0);
});

test('obsolete list reads abort when the shell navigates and cannot replace a later job detail', { timeout }, async t => {
  const { page, invoke } = await fixture(t);
  const { job } = await setupJob(invoke);
  await goto(page, '/jobs', '任务');
  let release;
  const waiting = new Promise(done => { release = done; });
  t.after(() => release());
  const started = page.waitForRequest(request => request.url().endsWith('/api/web/invoke') && request.postDataJSON()?.operationId === 'tasks.list');
  let delayedRequest;
  await page.route('**/api/web/invoke', async route => {
    if (route.request().postDataJSON().operationId !== 'tasks.list') return route.continue();
    delayedRequest = route.request();
    const response = await route.fetch();
    await waiting;
    await route.fulfill({ response }).catch(() => {});
  });
  await button(page, '刷新状态').click();
  await started;
  await page.getByRole('navigation', { name: '任务视图' }).getByRole('link', { name: '媒体', exact: true }).click();
  await page.locator('.legacy-route').waitFor();
  release();
  await page.goto(`/jobs/${job.jobId}`);
  await heading(page, job.title).waitFor();
  await page.getByRole('heading', { name: '任务明细', exact: true }).waitFor();
  assert.equal(delayedRequest.failure()?.errorText, 'net::ERR_ABORTED');
  assert.equal(await page.locator('.task-row').count(), 0);
});
