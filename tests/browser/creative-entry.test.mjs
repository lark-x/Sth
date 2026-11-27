import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import vue from '@vitejs/plugin-vue';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { connectionsDDL } from '../../src/connections.ts';
import { operationsDDL } from '../../src/core/index.ts';
import { createApp } from '../../src/server.ts';
import { workspaceDDL } from '../../src/workspace.ts';
import { assertFitsViewport } from './harness.mjs';

const root = resolve(import.meta.dirname, '../..');
const desktop = { width: 1360, height: 960 };
const phone = { width: 390, height: 844 };
const timeout = 60_000;
const entryId = '/__creative-entry__.mjs';

// This host exercises the domain seam without changing the shared shell registry.
// Unmigrated links use the real existing domain pages and the same business API.
const entry = `
import { createApp, h, shallowRef } from 'vue';
import WorkspaceRoute from '/frontend/workspace/WorkspaceRoute.vue';
import ProjectRoute from '/frontend/workspace/ProjectRoute.vue';
import { mountLegacyRoute } from '/web/assets/app.js';
import '/web/assets/notebook.css';
const main = document.querySelector('main');
const url = shallowRef(new URL(location.href));
let app;
let legacy;
function navigate(href) {
  history.pushState(null, '', href);
  render();
}
function render() {
  url.value = new URL(location.href);
  const active = /^\\/(?:workspace|projects)(?:\\/|$)/.test(url.value.pathname) || url.value.pathname === '/create';
  legacy?.abort();
  if (active) {
    if (!app) {
      main.replaceChildren();
      app = createApp({ setup: () => () => h(url.value.pathname.startsWith('/projects') ? ProjectRoute : WorkspaceRoute, {
        url: url.value, onNavigate: navigate, onRefresh: render,
      }) });
      app.mount(main);
    }
  } else {
    app?.unmount();
    app = undefined;
    legacy = new AbortController();
    void mountLegacyRoute({ main, url: url.value, signal: legacy.signal, navigate, refresh: render, announce() {} });
  }
}
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const anchor = event.target.closest?.('a[href]');
  if (!anchor || anchor.target || anchor.download) return;
  const next = new URL(anchor.href);
  if (next.origin !== location.origin) return;
  event.preventDefault();
  navigate(next.pathname + next.search + next.hash);
});
addEventListener('popstate', render);
render();
`;

async function launch(t, viewport = desktop, { actualShell = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; ${operationsDDL} ${workspaceDDL} ${connectionsDDL}`);
  const backend = createApp(db);
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
  const cache = await mkdtemp(join(tmpdir(), 'sth-creative-vite-'));
  let vite;
  const server = createServer();
  let browser;
  t.after(async () => {
    await browser?.close();
    await vite?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => backend.close(resolve));
    db.close();
    await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  vite = await createViteServer({
    configFile: false, root, cacheDir: cache, appType: 'custom', logLevel: 'error',
    resolve: { alias: { '/assets': join(root, 'web/assets') } },
    plugins: [vue(), {
      name: 'creative-entry-test-host',
      resolveId(id) { if (id === entryId) return '\0creative-entry-host'; },
      load(id) {
        if (id === '\0creative-entry-host') return actualShell
          ? "import '/frontend/main.ts'; import '/web/assets/notebook.css';"
          : entry;
      },
    }],
    server: { middlewareMode: true, hmr: { server }, watch: null, proxy: {
      '/api': {
        target: backendOrigin, changeOrigin: true,
        configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', backendOrigin)); },
      },
    } },
  });
  server.on('request', (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const isPage = /^\/(?:workspace|projects|create|scenes|drafts|chapters|branches|narratives|characters|sources|diaries)(?:\/|$)/.test(path) || path === '/';
    if (isPage) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${actualShell ? '<div id="app"></div>' : '<main tabindex="-1"></main>'}<script type="module" src="${entryId}"></script></body></html>`);
    } else {
      if (request.url.startsWith('/assets/')) request.url = `/web${request.url}`;
      vite.middlewares(request, response, () => response.writeHead(404).end());
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: origin, viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
  const calls = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/web/invoke')) calls.push(request.postDataJSON());
  });
  async function invoke(operationId, input = {}) {
    const response = await fetch(`${backendOrigin}/api/web/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, input, stepId: `creative-test:${randomUUID()}` }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  return { page, invoke, calls, origin, db };
}

const heading = (page, name) => page.getByRole('heading', { level: 1, name, exact: true });
const clickLink = (page, name) => page.getByRole('link', { name, exact: true }).click();
const writes = calls => calls.filter(call => /\.(?:create|revise|save|arrange|adopt|branch)$/.test(call.operationId));
async function goto(page, path, name) {
  await page.goto(path);
  await heading(page, name).waitFor();
}
async function screenshot(page, name) {
  if (process.env.STH_BROWSER_ARTIFACTS !== '1') return;
  const directory = join(root, 'frontend/workspace/.artifacts');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true, animations: 'disabled' });
}

async function manuscript(invoke) {
  const project = await invoke('project.create', { title: '北港来信' });
  const character = await invoke('character.create', { name: '阿澄', persona: '在北港等一封信。', projectId: project.projectId });
  const source = await invoke('source.create', { kind: 'setting', title: '渡船时刻表', body: '末班十点。末班十点。', projectIds: [project.projectId] });
  const scene = await invoke('scene.create', { title: '雨中的码头', time: '夜里', place: '北港',
    characters: [{ characterId: character.characterId, revision: 1 }],
    sources: [{ sourceId: source.sourceId, revision: 1, excerpt: '末班十点。', range: { start: 5, end: 10 } }],
  });
  const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '她的讲法', body: '雨落在信封上，她仍没有离开。' });
  await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '船长的讲法', body: '船长看见岸上还有一个人。' });
  const adopted = await invoke('scene.adopt', { sceneId: scene.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
  await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: '新版候选，不是采用的文字。' });
  const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '第一章 候船' });
  await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [scene.sceneId] });
  const narrative = await invoke('narrative.save', { title: '阿澄的所见', sceneId: scene.sceneId, sceneRevision: adopted.revision,
    viewpoint: { kind: 'character', characterId: character.characterId, revision: 1 }, eventOrder: [], knownEvents: [] });
  const branch = await invoke('scene.branch', { sceneId: scene.sceneId, revision: adopted.revision, divergence: '她没有等到来信。', branchName: '错过来信' });
  const legacyBranch = await invoke('scene.branch', { sceneId: scene.sceneId, revision: adopted.revision, divergence: '她早了一天。', title: '提前到港' });
  const diary = await invoke('diary.create', { title: '等信的夜晚', body: '今晚又走到码头。', diaryDate: '2026-11-27', characterId: character.characterId, expectedCharacterRevision: 1,
    sourcePins: [{ sourceId: source.sourceId, revision: 1, excerpt: '末班十点。', range: { start: 5, end: 10 } }] });
  return { project, character, source, scene: adopted, draft, chapter, narrative, branch, legacyBranch, diary };
}

test('creative entry creates a work with only a name and preserves creation tools', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t);
  await goto(page, '/workspace?tab=projects', '作品');
  await page.getByRole('heading', { name: '开始你的第一部作品' }).waitFor();
  assert.equal((await invoke('project.list')).items.length, 0);
  await page.getByRole('link', { name: '新建作品', exact: true }).first().click();
  await heading(page, '新建作品').waitFor();
  assert.equal(await page.locator('form input:required').count(), 1);
  await page.getByLabel('作品名称（必填）').fill('   ');
  await page.getByRole('button', { name: '创建作品', exact: true }).click();
  assert.equal(writes(calls).length, 0);
  await page.getByLabel('作品名称（必填）').fill('  一封未寄出的信  ');
  await page.getByRole('button', { name: '创建作品', exact: true }).click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  await page.getByRole('heading', { name: '一封未寄出的信', exact: true }).waitFor();
  await page.getByRole('heading', { name: '从第一个场景开始' }).waitFor();
  assert.deepEqual(writes(calls).map(call => [call.operationId, call.input]), [['project.create', { title: '一封未寄出的信' }]]);
  assert.equal((await invoke('scene.list')).items.length, 0);
  assert.equal((await invoke('chapter.list')).items.length, 0);
  await page.getByText('更多创作工具', { exact: true }).click();
  for (const path of ['/scenes', '/chapters', '/branches', '/events', '/templates', '/writing-requirements', '/generation-plans', '/generations/new']) {
    assert.equal(await page.locator(`.ce-tools a[href="${path}"]`).count(), 1);
  }
  await page.reload();
  await page.getByRole('heading', { name: '一封未寄出的信', exact: true }).waitFor();
  await assertFitsViewport(page);
});

test('creative entry opens adopted text, exact references, candidates, tellings and IF on desktop', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t);
  const data = await manuscript(invoke);
  await goto(page, `/projects/${data.project.projectId}`, '作品');
  await page.getByText('雨落在信封上，她仍没有离开。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '创作决定', exact: true }).getAttribute('href'), `/author-context?projectId=${data.project.projectId}`);
  assert.equal(await page.getByText('新版候选，不是采用的文字。', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '采用稿 · 她的讲法 · 第 1 版' }).getAttribute('href'), `/drafts/${data.draft.draftId}?revision=1`);
  assert.equal(await page.getByRole('link', { name: '阿澄 · 第 1 版', exact: true }).getAttribute('href'), `/characters/${data.character.characterId}?revision=1`);
  assert.equal(await page.getByRole('link', { name: '渡船时刻表 · 第 1 版', exact: true }).getAttribute('href'), `/sources/${data.source.sourceId}?revision=1&start=5&end=10`);
  await page.getByText('讲法、候选稿与 IF', { exact: true }).click();
  await page.getByRole('link', { name: '阿澄的所见 · 第 1 版', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '她的讲法 · 第 2 版', exact: true }).getAttribute('href'), `/drafts/${data.draft.draftId}?revision=2`);
  assert.equal(await page.getByRole('link', { name: '从此讲述建立 IF', exact: true }).getAttribute('href'), `/narratives/${data.narrative.narrativeId}?revision=1&action=branch`);
  assert.equal(await page.getByRole('link', { name: '错过来信 · 继续 IF', exact: true }).getAttribute('href'), `/branches/${data.branch.sceneId}`);
  assert.equal(await page.getByRole('link', { name: '提前到港 · 继续 IF', exact: true }).getAttribute('href'), `/branches/${data.legacyBranch.sceneId}`);
  await assertFitsViewport(page);
  await screenshot(page, 'desktop-manuscript');
  await clickLink(page, '对照两种讲法');
  await heading(page, '对照候选稿').waitFor();
  await page.locator('.workspace-comparison').waitFor();
  await goto(page, `/scenes/${data.legacyBranch.sceneId}?revision=1`, '提前到港');
  assert.equal(writes(calls).length, 0);
});

test('creative entry reads a saved role revision and only creates a scene on explicit submission', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t, phone);
  const character = await invoke('character.create', { name: '简舟', persona: '他还在等船。' });
  await goto(page, '/workspace?tab=characters', '从已有内容继续');
  await page.getByRole('heading', { name: '简舟', exact: true }).waitFor();
  await clickLink(page, '从这个角色构思');
  await page.getByRole('heading', { name: '从这里写一个场景', exact: true }).waitFor();
  await invoke('character.revise', { characterId: character.characterId, expectedRevision: 1, persona: '他已经离港。' });
  await page.reload();
  await page.getByText('他还在等船。', { exact: true }).waitFor();
  assert.equal(writes(calls).length, 0);
  await page.getByLabel('场景标题（必填）').fill('登船之前');
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForURL(/\/scenes\/[^?]+$/);
  await heading(page, '登船之前').waitFor();
  const scene = await invoke('scene.read', { sceneId: new URL(page.url()).pathname.split('/').at(-1) });
  assert.equal(scene.characters[0].revision, 1);
  assert.equal(scene.characters[0].persona, '他还在等船。');
  assert.deepEqual(writes(calls).map(call => call.operationId), ['scene.create']);
});

test('creative entry pins the selected repeated source passage and survives narrow-screen reading', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t, phone);
  const source = await invoke('source.create', { kind: 'excerpt', title: '北港时刻原件', body: '末班十点。末班十点。' });
  await goto(page, '/workspace?tab=sources', '从已有内容继续');
  await clickLink(page, '从这份资料构思');
  const original = page.getByLabel('选择一段原文作为场景依据');
  await original.waitFor();
  await original.evaluate(element => { element.focus(); element.setSelectionRange(5, 10); });
  await page.getByRole('button', { name: '引用选中文字' }).click();
  await page.getByText('已选第 6 至 10 个字符，引用保留所选版本。', { exact: true }).waitFor();
  await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '新版时刻为九点。' });
  assert.equal(writes(calls).length, 0);
  await assertFitsViewport(page);
  await screenshot(page, 'phone-source');
  await page.getByLabel('场景标题（必填）').fill('赶最后一班船');
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForURL(/\/scenes\/[^?]+$/);
  const scene = await invoke('scene.read', { sceneId: new URL(page.url()).pathname.split('/').at(-1) });
  assert.equal(scene.sources[0].revision, 1);
  assert.deepEqual(scene.sources[0].range, { start: 5, end: 10 });
  assert.equal(scene.sources[0].excerpt, '末班十点。');
});

test('creative entry resumes a diary with exact source backlinks and current edit route', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t, phone);
  const data = await manuscript(invoke);
  await goto(page, '/workspace?tab=diaries', '从已有内容继续');
  await clickLink(page, '接着这篇日记');
  await page.getByText('今晚又走到码头。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '引用资料 · 第 1 版' }).getAttribute('href'), `/sources/${data.source.sourceId}?revision=1&start=5&end=10`);
  assert.equal(await page.getByRole('link', { name: '继续编辑这篇日记' }).getAttribute('href'), `/diaries/${data.diary.noteId}?edit=1`);
  await assertFitsViewport(page);
  await clickLink(page, '继续编辑这篇日记');
  await heading(page, '编辑日记').waitFor();
  assert.equal(writes(calls).length, 0);
});

test('creative entry recovers a lost work-create response after reload using its original receipt', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t);
  let call;
  await page.route('**/api/web/invoke', async route => {
    const next = route.request().postDataJSON();
    if (next.operationId !== 'project.create' || call) return route.continue();
    call = next;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort();
  });
  await goto(page, '/projects/new', '新建作品');
  await page.getByLabel('作品名称（必填）').fill('只保存一部');
  await page.getByRole('button', { name: '创建作品', exact: true }).click();
  await page.getByRole('alert').getByText(/保存结果尚未确认/).waitFor();
  assert.equal(await page.getByLabel('作品名称（必填）').isDisabled(), true);
  await page.reload();
  await page.getByRole('button', { name: '重试同一次提交', exact: true }).waitFor();
  const receipt = page.waitForRequest('**/api/web/receipt');
  await page.getByRole('button', { name: '重试同一次提交', exact: true }).click();
  assert.deepEqual((await receipt).postDataJSON(), { operationId: call.operationId, stepId: call.stepId });
  await page.waitForURL(/\/projects\/[^/]+$/);
  assert.equal(writes(calls).length, 1);
  assert.equal((await invoke('project.list')).items.filter(item => item.title === '只保存一部').length, 1);
});

test('creative entry pages saved resources, retries a failed read and follows URL changes and history', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t, phone);
  for (let index = 0; index < 21; index++) await invoke('character.create', { name: `已有角色 ${index}` });
  const source = await invoke('source.create', { kind: 'inspiration', title: '<script>仅作为资料标题</script>', body: '原文可读。' });
  let failRead = true;
  await page.route('**/api/web/invoke', route => {
    if (route.request().postDataJSON().operationId === 'character.list' && failRead) {
      failRead = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable' }) });
    }
    return route.continue();
  });
  await goto(page, '/workspace?tab=characters', '从已有内容继续');
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.getByText('已载入 20 条角色', { exact: true }).waitFor();
  await page.getByRole('button', { name: '加载更多角色' }).click();
  await page.getByText('已载入 21 条角色', { exact: true }).waitFor();
  await page.getByRole('link', { name: '资料', exact: true }).click();
  await page.getByRole('heading', { name: source.title, exact: true }).waitFor();
  await clickLink(page, '从这份资料构思');
  await page.getByLabel('选择一段原文作为场景依据').waitFor();
  await page.goBack();
  await page.getByRole('heading', { name: source.title, exact: true }).waitFor();
  await page.goBack();
  await page.getByText('已载入 20 条角色', { exact: true }).waitFor();
  await assertFitsViewport(page);
  assert.equal(writes(calls).length, 0);
});

test('creative entry reads project content on a phone and rejects missing works and malformed version links', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t, phone);
  const data = await manuscript(invoke);
  await goto(page, `/workspace?tab=projects&projectId=${data.project.projectId}`, '作品');
  await page.getByText('雨落在信封上，她仍没有离开。', { exact: true }).waitFor();
  await assertFitsViewport(page);
  await screenshot(page, 'phone-manuscript');
  await goto(page, '/projects/missing-work', '作品');
  await page.getByRole('alert').getByText(/找不到这部作品/).waitFor();
  assert.equal(await page.getByText('雨落在信封上，她仍没有离开。', { exact: true }).count(), 0);
  await goto(page, `/workspace?tab=continue&from=source&sourceId=${data.source.sourceId}&revision=0`, '从已有内容继续');
  await page.getByRole('alert').getByText(/所选版本无效/).waitFor();
  assert.equal(writes(calls).length, 0);
});

test('creative entry discards a late source read after navigating to saved roles', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t);
  const source = await invoke('source.create', { kind: 'setting', title: '等待返回的资料', body: '这段原文稍后才返回。' });
  await invoke('character.create', { name: '当前选择的角色' });
  let release;
  let observed;
  let completed;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { observed = resolve; });
  const finished = new Promise(resolve => { completed = resolve; });
  await page.route('**/api/web/invoke', async route => {
    if (route.request().postDataJSON().operationId !== 'source.read') return route.continue();
    const response = await route.fetch();
    observed();
    await gate;
    try { await route.fulfill({ response }); } catch { /* The domain aborts its obsolete read. */ }
    completed();
  });
  t.after(() => release());
  await goto(page, `/workspace?tab=continue&from=source&sourceId=${source.sourceId}&revision=1`, '从已有内容继续');
  await started;
  await page.getByRole('link', { name: '角色', exact: true }).click();
  await page.getByRole('heading', { name: '当前选择的角色', exact: true }).waitFor();
  release();
  await finished;
  assert.equal(await page.getByRole('heading', { name: source.title, exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '当前选择的角色', exact: true }).count(), 1);
  assert.equal(writes(calls).length, 0);
});

test('creative entry preserves the original filtered create deep link', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t, phone);
  const data = await manuscript(invoke);
  await invoke('scene.create', { title: '别处的码头' });
  await goto(page, `/create?projectId=${data.project.projectId}&q=${encodeURIComponent('雨中的码头')}`, '创作');
  await page.getByRole('heading', { name: '雨中的码头', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '别处的码头', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('作品', { exact: true }).inputValue(), data.project.projectId);
  assert.equal(await page.getByLabel('完整场景名称').inputValue(), '雨中的码头');
  await page.getByLabel('完整场景名称').fill('找不到的场景');
  await page.getByRole('button', { name: '搜索场景', exact: true }).click();
  await page.getByText('没有匹配的场景，可以修改名称或作品筛选。', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('projectId'), data.project.projectId);
  await assertFitsViewport(page);
  assert.equal(writes(calls).length, 0);
});

test('creative entry renders through the current shared shell on desktop and phone', { timeout }, async t => {
  const { page, invoke, calls } = await launch(t, desktop, { actualShell: true });
  const data = await manuscript(invoke);
  await goto(page, `/workspace?tab=projects&projectId=${data.project.projectId}`, '作品');
  await page.getByText('雨落在信封上，她仍没有离开。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '创作决定', exact: true }).getAttribute('href'), `/author-context?projectId=${data.project.projectId}`);
  await assertFitsViewport(page);
  await screenshot(page, 'shared-shell-desktop');
  await page.setViewportSize(phone);
  await assertFitsViewport(page);
  await screenshot(page, 'shared-shell-phone');
  await page.getByRole('link', { name: '新建作品', exact: true }).click();
  await heading(page, '新建作品').waitFor();
  await page.getByLabel('作品名称（必填）').fill('从主入口开始的新作');
  await page.getByRole('button', { name: '创建作品', exact: true }).click();
  await page.waitForURL(/\/projects\/(?!new)[^/]+$/);
  await page.locator('.library-sheet-scroll[aria-busy="false"]').waitFor();
  assert.deepEqual(await page.locator('.manuscript-sheets').getByRole('alert').allTextContents(), [], 'a newly created work opens without a library error');
  await page.locator('.manuscript-sheets').getByRole('heading', { name: '从主入口开始的新作', exact: true }).waitFor();
  assert.deepEqual(writes(calls).map(call => call.operationId), ['project.create']);
});
