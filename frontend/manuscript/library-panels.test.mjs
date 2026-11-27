import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';

const root = resolve(import.meta.dirname, '../..');
const recentKey = 'sth:manuscripts:recent:v1';
const rows = page => page.locator('.library-sheet');
const titles = page => page.locator('.library-sheet-title').allTextContents();
function fromShelf(sceneId, collection) {
  const source = new URL(collection, 'http://library.test');
  source.searchParams.set('selected', sceneId);
  return `/scenes/${sceneId}?${new URLSearchParams({ returnTo: source.pathname + source.search })}`;
}

async function fixture(t, { actualShell = false } = {}) {
  const backend = await startService(t);
  const directory = await mkdtemp(join(tmpdir(), 'sth-library-panels-'));
  const web = createServer();
  let vite;
  t.after(async () => {
    await vite?.close();
    web.closeAllConnections();
    await new Promise(done => web.close(done));
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.match(basename(directory), /^sth-library-panels-[a-z0-9]+$/i);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  vite = await createViteServer({
    configFile: false, root, publicDir: false, cacheDir: join(directory, 'vite-cache'), logLevel: 'error',
    resolve: { alias: { '/assets': join(root, 'web/assets') } },
    plugins: [{
      name: 'library-panels-fixture',
      resolveId(id) { if (id === 'virtual:library-fixture') return '\0library-fixture'; },
      load(id) {
        if (id !== '\0library-fixture') return;
        if (actualShell) return "import '/frontend/main.ts'; import '/web/assets/notebook.css';";
        return `
          import { createApp, h, ref } from 'vue';
          import LibraryPanels from '/frontend/manuscript/LibraryPanels.vue';
          import '/frontend/styles.css';
          window.libraryEvents = [];
          createApp({ setup() {
            const url = ref(new URL(location.href));
            window.setLibraryUrl = href => {
              history.replaceState({}, '', href);
              url.value = new URL(location.href);
            };
            return () => h('div', { class: 'sth-app library-fixture' }, [
              h(LibraryPanels, {
                url: url.value,
                onPreview: href => window.libraryEvents.push({ kind: 'preview', href }),
                onNavigate: href => {
                  window.libraryEvents.push({ kind: 'navigate', href });
                  window.setLibraryUrl(href);
                },
              }),
              h('article', { class: 'fixture-editor' }, [h('h1', '隔离验收正文'), h('p', '正文内容。'.repeat(2000))]),
            ]);
          }}).mount('#app');
        `;
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.headers.accept?.includes('text/html')) return next();
          try {
            const html = await server.transformIndexHtml(request.url, `<!doctype html><html lang="zh-CN"><head>
              <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>资料库隔离验收</title>
              <style>
                * { box-sizing: border-box; } html, body { margin: 0; } body { overflow: ${actualShell ? 'auto' : 'hidden'}; }
                .library-fixture { display: grid; grid-template-columns: 208px 272px minmax(0, 1fr); height: 100dvh; min-block-size: 0; }
                .fixture-editor { min-width: 0; min-height: 0; padding: 32px; overflow: auto; }
                .fixture-editor p { line-height: 1.8; }
                @media (width < 1050px) { .library-fixture { grid-template-columns: 240px minmax(0,1fr); } .library-fixture > .manuscript-library { display: none; } }
                @media (width < 640px) { .library-fixture { grid-template-columns: minmax(0,1fr); } .library-fixture > .fixture-editor { display: none; } }
              </style></head><body><div id="app"></div><script type="module" src="/@id/virtual:library-fixture"></script></body></html>`);
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(html);
          } catch (error) { next(error); }
        });
      },
    }, vue()],
    server: { middlewareMode: true, hmr: { server: web }, watch: null, proxy: { '/api': {
      target: backend, changeOrigin: true,
      configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', backend)); },
    } } },
  });
  web.on('request', vite.middlewares);
  await new Promise(done => web.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${web.address().port}`;
  async function invoke(operationId, input = {}) {
    const response = await fetch(`${backend}/api/web/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, stepId: `library-test:${randomUUID()}`, input }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  return { origin, invoke };
}

async function settled(page) {
  await page.waitForFunction(() => (window.setLibraryUrl || document.querySelector('.manuscript-frame'))
    && document.querySelector('.library-sheet-scroll')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('nav[aria-label="作品与章节"]')?.getAttribute('aria-busy') === 'false');
}
async function setUrl(page, href) {
  await page.evaluate(href => window.setLibraryUrl(href), href);
  await settled(page);
}

test('library panels use real operations with stable manuscript rows and preview-only collection events', { timeout: 120_000 }, async t => {
  const { origin, invoke } = await fixture(t);
  const project = await invoke('project.create', { title: '第三声以后' });
  const other = await invoke('project.create', { title: '另一部作品' });
  const firstChapter = await invoke('chapter.create', { projectId: project.projectId, title: '起航' });
  const secondChapter = await invoke('chapter.create', { projectId: project.projectId, title: '归港' });
  const first = await invoke('scene.create', { title: '风里的一封信', time: '暮色', place: '旧渡口' });
  const second = await invoke('scene.create', { title: '第二幕', time: '深夜', place: '灯塔' });
  const third = await invoke('scene.create', { title: '很长的中文场景标题'.repeat(18), time: '清晨', place: '南岸' });
  const unplaced = await invoke('scene.create', { title: '还未编排的场景', time: '黄昏', place: '石桥' });
  const unplacedDraft = await invoke('draft.create', { sceneId: unplaced.sceneId, sceneRevision: 1, title: '独立场景的候选稿', body: '尚未归入任何作品的正文。' });
  const draft = await invoke('draft.create', { sceneId: first.sceneId, sceneRevision: 1, title: '远景候选', body: '只在采用稿中出现的海盐。\n她将信留在渡口。' });
  await invoke('scene.adopt', { sceneId: first.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
  await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: '更新后的候选稿。' });
  await invoke('draft.create', { sceneId: first.sceneId, sceneRevision: 2, title: '近景候选', body: '另一个讲法。' });
  await invoke('chapter.arrange', { chapterId: firstChapter.chapterId, expectedRevision: 1, sceneIds: [second.sceneId, first.sceneId] });
  const extra = [];
  for (let index = 0; index < 21; index++) extra.push(await invoke('scene.create', { title: `分页场景 ${index + 1}` }));
  await invoke('chapter.arrange', { chapterId: secondChapter.chapterId, expectedRevision: 1, sceneIds: [third.sceneId, ...extra.map(scene => scene.sceneId)] });
  const olderDiary = await invoke('diary.create', { title: '前一天的日记', body: '旧桥下的水声。', diaryDate: '2026-11-26' });
  const diary = await invoke('diary.create', { title: '今天的日记', body: '今天在图书馆读到一封来信。', diaryDate: '2026-11-27' });
  const page = await openBrowser(t, origin, { width: 1280, height: 900 });
  await page.goto(`/projects/${project.projectId}`);
  await settled(page);

  await t.test('chapter position, all pages, summaries, sibling roots and independent scrolling', async () => {
    assert.equal(await page.locator('.library-fixture > .manuscript-library + .manuscript-sheets').count(), 1);
    assert.equal(await page.getByRole('link', { name: 'Sth 首页' }).getAttribute('href'), '/');
    const mark = await page.locator('.library-brand-mark').evaluate(element => ({
      width: element.getBoundingClientRect().width, background: getComputedStyle(element).backgroundColor,
    }));
    assert.equal(mark.width, 28);
    assert.equal(mark.background, 'rgb(40, 90, 70)');
    assert.equal(await rows(page).count(), 24);
    assert.deepEqual((await titles(page)).slice(0, 3), [second.title, first.title, third.title]);
    assert.match(await rows(page).nth(1).innerText(), /只在采用稿中出现的海盐/);
    assert.equal(await page.locator('.library-sheet[aria-current="page"]').getAttribute('href'), fromShelf(second.sceneId, `/projects/${project.projectId}`));
    assert.equal(await page.locator('.library-sheet[aria-current="page"] .library-sheet-title').evaluate(element => getComputedStyle(element).textDecorationLine), 'none');
    assert.deepEqual(await page.evaluate(() => window.libraryEvents), [{ kind: 'preview', href: fromShelf(second.sceneId, `/projects/${project.projectId}`) }]);
    assert.equal(new URL(page.url()).pathname, `/projects/${project.projectId}`);
    const scroll = await page.evaluate(() => {
      const list = document.querySelector('.library-sheet-scroll');
      list.scrollTop = 400;
      return { list: list.scrollTop, body: document.scrollingElement.scrollTop, editor: document.querySelector('.fixture-editor').scrollTop };
    });
    assert.ok(scroll.list > 0);
    assert.equal(scroll.body, 0);
    assert.equal(scroll.editor, 0);
    await assertFitsViewport(page);
  });

  await t.test('searches adopted full text, chapter names, empty search and keyboard navigation', async () => {
    const search = page.getByRole('searchbox', { name: '搜索文稿' });
    await search.fill('海盐');
    assert.deepEqual(await titles(page), [first.title]);
    await page.waitForFunction(href => window.libraryEvents.at(-1)?.href === href, fromShelf(first.sceneId, `/projects/${project.projectId}`));
    assert.ok((await page.evaluate(() => window.libraryEvents)).every(event => event.kind === 'preview'));
    await search.fill('不存在的文稿');
    await page.getByRole('heading', { name: '没有匹配的文稿' }).waitFor();
    await page.waitForFunction(() => window.libraryEvents.at(-1)?.href === '');
    await page.getByRole('button', { name: '清除搜索' }).click();
    await search.fill('归港');
    assert.equal(await rows(page).count(), 22);
    await search.press('Escape');
    await search.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('href')), fromShelf(second.sceneId, `/projects/${project.projectId}`));
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('href')), fromShelf(first.sceneId, `/projects/${project.projectId}`));
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('href')), fromShelf(extra.at(-1).sceneId, `/projects/${project.projectId}`));
    await page.keyboard.press('Home');
    await page.keyboard.press('/');
    assert.equal(await search.evaluate(input => input === document.activeElement), true);
  });

  await t.test('draft permalink restores the current chapter, keeps the exact version and does not emit preview', async () => {
    await page.evaluate(() => { window.libraryEvents = []; });
    const permalink = `/drafts/${draft.draftId}?revision=1&start=2&end=4`;
    await setUrl(page, permalink);
    assert.equal(await page.locator('.library-sheet[aria-current="page"]').getAttribute('href'), permalink);
    assert.equal(await rows(page).count(), 2);
    assert.equal(await page.locator('.library-chapter-link[aria-current="page"]').getAttribute('href'), `/projects/${project.projectId}?chapterId=${firstChapter.chapterId}`);
    assert.equal(await page.getByRole('button', { name: `收起${project.title}` }).getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await page.evaluate(() => window.libraryEvents), []);
    await rows(page).first().click();
    await settled(page);
    assert.equal(new URL(page.url()).pathname, `/scenes/${second.sceneId}`);
    assert.deepEqual(await page.evaluate(() => window.libraryEvents), [{ kind: 'navigate', href: fromShelf(second.sceneId, `/projects/${project.projectId}?chapterId=${firstChapter.chapterId}`) }]);
  });

  await t.test('unplaced is shared without an invalid project filter and related entries keep project context', async () => {
    await setUrl(page, `/projects/${other.projectId}?shelf=unplaced`);
    assert.deepEqual(await titles(page), [unplaced.title]);
    assert.match(await page.locator('.library-sheets-heading').innerText(), /全工作区/);
    const children = page.locator('.library-children').filter({ has: page.locator(`a[href="/projects/${other.projectId}?shelf=unplaced"]`) });
    assert.equal(await children.getByRole('link', { name: '作品角色' }).getAttribute('href'), `/characters?projectId=${other.projectId}`);
    assert.equal(await children.getByRole('link', { name: '作品资料' }).getAttribute('href'), `/sources?projectId=${other.projectId}`);
    await setUrl(page, `/scenes/${unplaced.sceneId}`);
    assert.equal(await page.locator('.library-sheet[aria-current="page"]').getAttribute('href'), `/scenes/${unplaced.sceneId}`);
    assert.equal(await page.locator('.library-children [aria-current="page"], .library-project-row[data-active]').count(), 0);
    await setUrl(page, `/drafts/${unplacedDraft.draftId}`);
    assert.match(await page.locator('.library-sheets-heading').innerText(), /全工作区的独立场景/);
    assert.equal(await page.locator('.library-children [aria-current="page"], .library-project-row[data-active]').count(), 0);
    assert.equal(await page.locator('.library-sheet[aria-current="page"]').getAttribute('href'), `/drafts/${unplacedDraft.draftId}`);
  });

  await t.test('returning from a manuscript re-emits the collection preview for a reset Frame', async () => {
    const collection = `/projects/${project.projectId}?chapterId=${firstChapter.chapterId}`;
    await setUrl(page, collection);
    await page.evaluate(() => { window.libraryEvents = []; });
    await setUrl(page, `/scenes/${first.sceneId}`);
    assert.deepEqual(await page.evaluate(() => window.libraryEvents), []);
    await setUrl(page, collection);
    assert.deepEqual(await page.evaluate(() => window.libraryEvents), [{ kind: 'preview', href: fromShelf(first.sceneId, collection) }]);
  });

  await t.test('diaries sort by date and every collection emits a preview without navigation', async () => {
    for (const path of ['/diaries', '/projects', '/create']) {
      await page.evaluate(() => { window.libraryEvents = []; });
      await setUrl(page, path);
      const events = await page.evaluate(() => window.libraryEvents);
      assert.ok(events.some(event => event.kind === 'preview' && event.href));
      assert.ok(events.every(event => event.kind === 'preview'));
      assert.equal(new URL(page.url()).pathname, path);
    }
    await setUrl(page, '/diaries');
    assert.deepEqual(await titles(page), [diary.title, olderDiary.title]);
    await setUrl(page, `/diaries/${olderDiary.noteId}?revision=1`);
    assert.equal(await page.locator('.library-sheet[aria-current="page"]').getAttribute('href'), `/diaries/${olderDiary.noteId}?revision=1`);
  });

  await t.test('recent collapses candidates into a scene row and preserves its last exact URL', async () => {
    const now = Date.now();
    const recent = [
      { kind: 'draft', id: draft.draftId, title: '正在改的远景', href: `/drafts/${draft.draftId}?revision=1&start=2&end=4`, updatedAt: now + 300 },
      { kind: 'scene', id: first.sceneId, title: first.title, href: `/scenes/${first.sceneId}`, updatedAt: now + 200 },
      { kind: 'diary', id: diary.noteId, title: diary.title, href: `/diaries/${diary.noteId}`, updatedAt: now + 100 },
    ];
    await page.evaluate(({ key, recent }) => { localStorage.setItem(key, JSON.stringify(recent)); window.libraryEvents = []; }, { key: recentKey, recent });
    await setUrl(page, '/workspace?tab=recent');
    assert.ok(await rows(page).count() > 2, 'server manuscripts appear alongside local exact links');
    assert.equal(await rows(page).first().getAttribute('href'), recent[0].href);
    assert.match(await rows(page).first().innerText(), /只在采用稿中出现的海盐/);
    assert.deepEqual(await page.evaluate(() => window.libraryEvents), [{ kind: 'preview', href: recent[0].href }]);
    await page.evaluate(key => { localStorage.removeItem(key); window.dispatchEvent(new Event('sth:manuscripts-changed')); }, recentKey);
    await settled(page);
    assert.ok(await rows(page).count() > 0, 'clearing local history retains server manuscripts');
    assert.ok((await titles(page)).includes(diary.title));
    assert.notEqual(await page.evaluate(() => window.libraryEvents.at(-1)?.href), '');
  });

  await t.test('rapid URL changes cancel old detail requests and errors have a working retry', async () => {
    let fail = true;
    let holdProject = false;
    let releaseProject;
    let projectReleased;
    const released = new Promise(resolve => { projectReleased = resolve; });
    await page.route('**/api/web/invoke', async route => {
      const call = route.request().postDataJSON();
      if (call.operationId === 'diary.list' && fail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
      if (holdProject && call.operationId === 'scene.list' && call.input.projectId === project.projectId) {
        await new Promise(resolve => { releaseProject = resolve; });
        await route.continue().catch(() => {});
        projectReleased();
        return;
      }
      return route.continue();
    });
    await setUrl(page, '/diaries');
    await page.getByRole('button', { name: '重新读取文稿' }).waitFor();
    assert.equal(await page.evaluate(() => window.libraryEvents.at(-1)?.href), '');
    fail = false;
    await page.getByRole('button', { name: '重新读取文稿' }).click();
    await settled(page);
    assert.equal(await rows(page).count(), 2);
    holdProject = true;
    const projectRequest = page.waitForRequest(request => {
      if (!request.url().endsWith('/api/web/invoke')) return false;
      const call = request.postDataJSON();
      return call.operationId === 'scene.list' && call.input.projectId === project.projectId;
    });
    await page.evaluate(projectId => window.setLibraryUrl(`/projects/${projectId}`), project.projectId);
    await projectRequest;
    await setUrl(page, '/diaries');
    releaseProject();
    await released;
    await settled(page);
    assert.deepEqual(await titles(page), [diary.title, olderDiary.title]);
    await page.unroute('**/api/web/invoke');
  });

  await t.test('one failed scene summary keeps every row and can recover independently', async () => {
    let fail = true;
    await page.route('**/api/web/invoke', route => {
      const call = route.request().postDataJSON();
      if (fail && call.operationId === 'scene.read' && call.input.sceneId === third.sceneId) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
      }
      return route.continue();
    });
    await setUrl(page, `/projects/${project.projectId}`);
    assert.equal(await rows(page).count(), 24);
    await page.getByRole('button', { name: '重试摘要' }).waitFor();
    fail = false;
    await page.getByRole('button', { name: '重试摘要' }).click();
    await settled(page);
    assert.equal(await page.getByRole('button', { name: '重试摘要' }).count(), 0);
    assert.match(await rows(page).nth(2).innerText(), /清晨 · 南岸/);
    await page.unroute('**/api/web/invoke');
  });

  await t.test('isolated editorial panes fit desktop, tablet and two narrow widths', async () => {
    await setUrl(page, `/projects/${project.projectId}`);
    for (const viewport of [{ width: 1280, height: 900 }, { width: 820, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 800 }]) {
      await page.setViewportSize(viewport);
      await assertFitsViewport(page);
      assert.ok(await rows(page).first().isVisible());
      assert.equal(await page.locator('.manuscript-library').isVisible(), viewport.width >= 1050);
      assert.equal(await page.locator('.fixture-editor').isVisible(), viewport.width >= 640);
      assert.equal((await page.locator('.manuscript-sheets').boundingBox()).y, 0);
      if (process.env.STH_LIBRARY_SCREENSHOTS) {
        await page.screenshot({ path: join(process.env.STH_LIBRARY_SCREENSHOTS, `library-${viewport.width}.png`), animations: 'disabled' });
      }
    }
  });
});

test('library refreshes stale creation caches once and isolates rapid project changes', { timeout: 120_000 }, async t => {
  const { origin, invoke } = await fixture(t);
  const page = await openBrowser(t, origin, { width: 1280, height: 900 });
  const calls = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/web/invoke')) calls.push(request.postDataJSON());
  });
  const treeReads = () => calls.filter(call => call.operationId === 'project.list').length;
  const sheetErrors = () => page.locator('.manuscript-sheets [role="alert"]').allTextContents();
  await page.goto('/projects/new');
  await settled(page);

  await t.test('a work created after mount refreshes the cached tree and retains first-writing actions', async () => {
    const project = await invoke('project.create', { title: '创建之后才出现的新作' });
    const reads = treeReads();
    await page.evaluate(() => { window.libraryEvents = []; });
    await setUrl(page, `/projects/${project.projectId}`);
    assert.deepEqual(await sheetErrors(), []);
    assert.equal(await page.locator('.library-sheets-heading h2').textContent(), project.title);
    assert.equal(treeReads(), reads + 1, 'one fresh tree read confirms the newly created work');
    const empty = page.locator('.library-empty');
    assert.equal(await empty.getByRole('link', { name: '新建场景', exact: true }).getAttribute('href'), '/scenes/new');
    assert.equal(await empty.getByRole('link', { name: '继续写', exact: true }).getAttribute('href'), '/workspace?tab=continue');
    assert.equal(await empty.getByRole('link', { name: '新建章节', exact: true }).getAttribute('href'), `/chapters/new?projectId=${project.projectId}`);
    assert.deepEqual(await page.evaluate(() => window.libraryEvents), [{ kind: 'preview', href: '' }]);

    const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '新建的第一章' });
    const scene = await invoke('scene.create', { title: '从第一幕开始' });
    await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [scene.sceneId] });
    await setUrl(page, `/projects/${project.projectId}?chapterId=${chapter.chapterId}`);
    assert.deepEqual(await sheetErrors(), []);
    assert.deepEqual(await titles(page), [scene.title]);
    assert.equal(treeReads(), reads + 2, 'a newly created chapter also refreshes a stale tree once');
    assert.equal(await page.locator('.library-chapter-link[aria-current="page"]').textContent(), `${chapter.title}1`);
    assert.equal(await page.evaluate(() => window.libraryEvents.at(-1)?.href), fromShelf(scene.sceneId, `/projects/${project.projectId}?chapterId=${chapter.chapterId}`));
  });

  await t.test('an absent project waits for a successful fresh tree before reporting not found', async () => {
    const gate = Promise.withResolvers();
    const started = page.waitForRequest(request => request.url().endsWith('/api/web/invoke')
      && request.postDataJSON().operationId === 'project.list');
    const reads = treeReads();
    await page.route('**/api/web/invoke', async route => {
      if (route.request().postDataJSON().operationId !== 'project.list') return route.continue();
      const response = await route.fetch();
      await gate.promise;
      await route.fulfill({ response });
    });
    try {
      await page.evaluate(() => { window.libraryEvents = []; window.setLibraryUrl('/projects/absent-work'); });
      await started;
      assert.deepEqual(await sheetErrors(), [], 'stale cache absence is not an error');
      assert.deepEqual(await page.evaluate(() => window.libraryEvents), [], 'preview waits for collection validation');
      gate.resolve();
      await settled(page);
      assert.match((await sheetErrors()).join(''), /找不到/);
      assert.equal(treeReads(), reads + 1);
      assert.deepEqual(await page.evaluate(() => window.libraryEvents), [{ kind: 'preview', href: '' }]);
      await page.waitForTimeout(250);
      assert.equal(treeReads(), reads + 1, 'confirmed absence never starts an automatic retry loop');
    } finally {
      gate.resolve();
      await page.unroute('**/api/web/invoke');
    }
  });

  await t.test('failed tree refresh remains retryable and never becomes a false not-found error', async () => {
    const project = await invoke('project.create', { title: '等待目录恢复的新作' });
    let fail = true;
    const reads = treeReads();
    await page.route('**/api/web/invoke', route => {
      if (fail && route.request().postDataJSON().operationId === 'project.list') {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
      }
      return route.continue();
    });
    try {
      await setUrl(page, `/projects/${project.projectId}`);
      assert.equal((await sheetErrors()).length, 1);
      assert.doesNotMatch((await sheetErrors()).join(''), /找不到/);
      assert.equal(treeReads(), reads + 1);
      assert.equal(await page.locator('.library-empty').count(), 0, 'an unread tree is not a confirmed empty project');
      fail = false;
      await page.getByRole('button', { name: '重新读取文稿', exact: true }).click();
      await settled(page);
      assert.deepEqual(await sheetErrors(), []);
      assert.equal(await page.locator('.library-sheets-heading h2').textContent(), project.title);
      assert.equal(treeReads(), reads + 2);
    } finally {
      await page.unroute('**/api/web/invoke');
    }
  });

  await t.test('rapid cache misses share a tree read and only the last project may publish rows or preview', async () => {
    const projects = [];
    for (const title of ['稍早选择的作品', '最后选择的作品']) {
      const project = await invoke('project.create', { title });
      const chapter = await invoke('chapter.create', { projectId: project.projectId, title: `${title}第一章` });
      const scene = await invoke('scene.create', { title: `${title}第一幕` });
      await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [scene.sceneId] });
      projects.push({ ...project, scene });
    }
    const gate = Promise.withResolvers();
    const started = page.waitForRequest(request => request.url().endsWith('/api/web/invoke')
      && request.postDataJSON().operationId === 'project.list');
    const reads = treeReads();
    await page.route('**/api/web/invoke', async route => {
      if (route.request().postDataJSON().operationId !== 'project.list') return route.continue();
      const response = await route.fetch();
      await gate.promise;
      await route.fulfill({ response });
    });
    try {
      await page.evaluate(projectId => { window.libraryEvents = []; window.setLibraryUrl(`/projects/${projectId}`); }, projects[0].projectId);
      await started;
      for (const project of [projects[1], projects[0], projects[1]]) {
        await page.evaluate(projectId => window.setLibraryUrl(`/projects/${projectId}`), project.projectId);
      }
      assert.equal(treeReads(), reads + 1, 'navigation joins the pending tree read');
      gate.resolve();
      await settled(page);
      assert.deepEqual(await sheetErrors(), []);
      assert.deepEqual(await titles(page), [projects[1].scene.title]);
      assert.equal(await page.locator('.library-sheets-heading h2').textContent(), projects[1].title);
      assert.deepEqual(await page.evaluate(() => window.libraryEvents), [{ kind: 'preview', href: fromShelf(projects[1].scene.sceneId, `/projects/${projects[1].projectId}`) }]);
      await page.waitForTimeout(250);
      assert.equal(treeReads(), reads + 1, 'completed tree refresh never loops');
      assert.deepEqual(await titles(page), [projects[1].scene.title]);
    } finally {
      gate.resolve();
      await page.unroute('**/api/web/invoke');
    }

    const oldList = page.waitForRequest(request => {
      if (!request.url().endsWith('/api/web/invoke')) return false;
      const call = request.postDataJSON();
      return call.operationId === 'scene.list' && call.input.projectId === projects[0].projectId;
    });
    const release = Promise.withResolvers();
    const finished = Promise.withResolvers();
    await page.route('**/api/web/invoke', async route => {
      const call = route.request().postDataJSON();
      if (call.operationId !== 'scene.list' || call.input.projectId !== projects[0].projectId) return route.continue();
      const response = await route.fetch();
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
      finished.resolve();
    });
    try {
      await page.evaluate(projectId => { window.libraryEvents = []; window.setLibraryUrl(`/projects/${projectId}`); }, projects[0].projectId);
      await oldList;
      await setUrl(page, `/projects/${projects[1].projectId}`);
      release.resolve();
      await finished.promise;
      await settled(page);
      assert.deepEqual(await titles(page), [projects[1].scene.title]);
      assert.deepEqual(await page.evaluate(() => window.libraryEvents), [{ kind: 'preview', href: fromShelf(projects[1].scene.sceneId, `/projects/${projects[1].projectId}`) }]);
      assert.equal(treeReads(), reads + 1, 'switching cached projects needs no extra tree requests');
    } finally {
      release.resolve();
      await page.unroute('**/api/web/invoke');
    }
  });
});

test('library preserves project navigation and exposes management through the real Frame', { timeout: 120_000 }, async t => {
  const { origin, invoke } = await fixture(t, { actualShell: true });
  const project = await invoke('project.create', { title: '往返之间' });
  const other = await invoke('project.create', { title: '另一部作品的分组' });
  const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '第一章' });
  const laterChapter = await invoke('chapter.create', { projectId: project.projectId, title: '第二章' });
  const scenes = [];
  for (const title of ['章内第一幕', '章内第二幕', '另一章的场景', '未编场景 1', '未编场景 2']) {
    scenes.push(await invoke('scene.create', { title }));
  }
  await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: scenes.slice(0, 2).map(scene => scene.sceneId) });
  await invoke('chapter.arrange', { chapterId: laterChapter.chapterId, expectedRevision: 1, sceneIds: [scenes[2].sceneId] });
  const draft = await invoke('draft.create', { sceneId: scenes[1].sceneId, sceneRevision: 1, title: '保留版本与选段', body: '归来的路上仍有灯火。' });
  await invoke('draft.create', { sceneId: scenes[1].sceneId, sceneRevision: 1, title: '另一个候选稿', body: '她在船上看见了灯火。' });
  const standalone = await invoke('draft.create', { sceneId: scenes[4].sceneId, sceneRevision: 1, title: '独立草稿', body: '没有作品归属的文字。' });
  const page = await openBrowser(t, origin, { width: 1280, height: 900 });
  const projectPath = `/projects/${project.projectId}`;
  const groups = [
    { path: projectPath, title: project.title, count: 3, target: scenes[1], label: '作品整组' },
    { path: `${projectPath}?chapterId=${chapter.chapterId}`, title: chapter.title, count: 2, target: scenes[1], label: '章节' },
    { path: `${projectPath}?shelf=unplaced`, title: '未编入章节', count: 2, target: scenes[4], label: '未编入' },
  ];
  async function showSheets() {
    if (page.viewportSize().width >= 640) return;
    if (await page.locator('.manuscript-frame').getAttribute('data-pane') === 'editor') {
      await page.locator('.wr-reader-toolbar').getByRole('button', { name: '返回文稿列表', exact: true }).click();
    }
    await page.locator('.manuscript-frame[data-pane="sheets"]').waitFor();
  }
  async function assertGroup(group) {
    await settled(page);
    assert.equal(await page.locator('.library-sheets-heading h2').textContent(), group.title);
    assert.equal(await rows(page).count(), group.count);
    assert.equal(await page.locator('.library-sheet[aria-current="page"] .library-sheet-title').textContent(), group.target.title);
  }

  for (const width of [1280, 820, 390, 320]) {
    await t.test(`${width}px management remains available with manuscripts and every group survives both return paths`, async () => {
      await page.setViewportSize({ width, height: 900 });
      for (const group of groups) {
        await page.goto(group.path);
        await settled(page);
        const management = page.getByRole('navigation', { name: '作品管理', exact: true });
        assert.ok(await management.isVisible());
        assert.deepEqual(await management.getByRole('link').allTextContents(), ['作品总览', '编排章节', '创作决定']);
        assert.ok((await titles(page)).indexOf(group.target.title) > 0, 'each return scenario selects a non-first row');
        await rows(page).filter({ has: page.getByText(group.target.title, { exact: true }) }).click();
        await page.waitForURL(url => url.pathname === `/scenes/${group.target.sceneId}`);
        assert.equal(new URL(page.url()).searchParams.get('returnTo'), new URL(fromShelf(group.target.sceneId, group.path), origin).searchParams.get('returnTo'));
        await assertGroup(group);
        await showSheets();
        await assertFitsViewport(page);

        for (const [name, path] of [['作品总览', projectPath], ['编排章节', '/chapters'], ['创作决定', '/author-context']]) {
          const target = new URL(await management.getByRole('link', { name, exact: true }).getAttribute('href'), origin);
          assert.equal(target.pathname, path);
          assert.equal(target.searchParams.get('returnTo'), new URL(page.url()).pathname + new URL(page.url()).search);
          if (name === '作品总览') assert.equal(target.searchParams.get('view'), 'overview');
          else assert.equal(target.searchParams.get('projectId'), project.projectId);
        }

        const manuscriptHref = new URL(page.url()).pathname + new URL(page.url()).search;
        await management.getByRole('link', { name: '作品总览', exact: true }).click();
        await page.getByRole('article', { name: project.title, exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('returnTo'), manuscriptHref);
        const overview = page.getByRole('navigation', { name: '作品内容', exact: true });
        assert.equal(await overview.getByRole('link', { name: '章节', exact: true }).getAttribute('href'), `/chapters?projectId=${project.projectId}`);
        assert.equal(await overview.getByRole('link', { name: '创作决定', exact: true }).getAttribute('href'), `/author-context?projectId=${project.projectId}`);
        await page.goBack();
        await page.waitForURL(url => url.pathname + url.search === manuscriptHref);
        await assertGroup(group);
        await showSheets();
        await assertGroup(group);

        if (process.env.STH_LIBRARY_SCREENSHOTS) {
          await page.screenshot({ path: join(process.env.STH_LIBRARY_SCREENSHOTS, `library-return-${width}-${group.label}.png`), animations: 'disabled' });
        }

        // The manuscript toolbar's explicit return works after reload, too.
        await page.reload();
        await settled(page);
        if (width < 640 && await page.locator('.manuscript-frame').getAttribute('data-pane') === 'sheets') {
          await page.locator('.library-sheet[aria-current="page"]').click();
        }
        await page.locator('.wr-reader-toolbar').getByRole('button', { name: '更多', exact: true }).click();
        const backLabel = group.label === '未编入' ? '返回场景列表' : '返回章节';
        const back = page.locator('.wr-more-menu').getByRole('link', { name: backLabel, exact: true });
        await back.click();
        await page.waitForURL(url => url.pathname === projectPath && url.searchParams.get('selected') === group.target.sceneId);
        await assertGroup(group);

        // Browser Back restores the original collection entry without selected=.
        await page.goto(group.path);
        await settled(page);
        await rows(page).filter({ has: page.getByText(group.target.title, { exact: true }) }).click();
        await page.waitForURL(url => url.pathname.startsWith('/scenes/'));
        await page.goBack();
        await page.waitForURL(url => url.pathname + url.search === group.path);
        await assertGroup(group);
      }
    });
  }

  await t.test('chapter arrangement and author decisions open from a manuscript and return to its group', async () => {
    const group = groups[0];
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(fromShelf(group.target.sceneId, group.path));
      await settled(page);
      for (const [name, path, title] of [['编排章节', '/chapters', '章节'], ['创作决定', '/author-context', '创作决定']]) {
        await showSheets();
        const source = new URL(page.url()).pathname + new URL(page.url()).search;
        await page.getByRole('navigation', { name: '作品管理', exact: true }).getByRole('link', { name, exact: true }).click();
        await page.waitForURL(url => url.pathname === path && url.searchParams.get('projectId') === project.projectId);
        await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('returnTo'), source);
        await page.goBack();
        await page.waitForURL(url => url.pathname + url.search === source);
        await assertGroup(group);
      }
    }
  });

  await t.test('switching from a scene to a draft inherits the original whole-project list', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(fromShelf(scenes[1].sceneId, projectPath));
    await settled(page);
    const picker = page.getByRole('combobox', { name: '切换稿件', exact: true });
    await picker.waitFor();
    const value = await picker.locator('option').filter({ hasText: draft.title }).getAttribute('value');
    await picker.selectOption(value);
    await page.waitForURL(url => url.pathname === `/drafts/${draft.draftId}`);
    await assertGroup(groups[0]);
    assert.equal(new URL(new URL(page.url()).searchParams.get('returnTo'), origin).pathname, `/scenes/${scenes[1].sceneId}`);
  });

  await t.test('legacy draft links use actual placement and management preserves the exact draft URL', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const permalink = `/drafts/${draft.draftId}?revision=1&start=1&end=3`;
    await page.goto(permalink);
    await settled(page);
    assert.equal(await rows(page).count(), 2);
    assert.equal(await page.locator('.library-chapter-link[aria-current="page"]').getAttribute('href'), `${projectPath}?chapterId=${chapter.chapterId}`);
    await showSheets();
    const overview = page.getByRole('navigation', { name: '作品管理', exact: true }).getByRole('link', { name: '作品总览', exact: true });
    assert.equal(new URL(await overview.getAttribute('href'), origin).searchParams.get('returnTo'), permalink);
    await overview.click();
    await page.getByRole('article', { name: project.title, exact: true }).waitFor();
    await page.goBack();
    await page.waitForURL(url => url.pathname + url.search === permalink);
    await settled(page);
    assert.equal(await page.locator('.library-sheet[aria-current="page"]').getAttribute('href'), permalink);

    const wrongSources = [
      `https://other.invalid${projectPath}`,
      `/projects/${other.projectId}`,
      `${projectPath}?chapterId=${laterChapter.chapterId}`,
      `${projectPath}?shelf=unplaced`,
      `${projectPath}?view=overview`,
      '/projects/%zz',
    ];
    for (const returnTo of wrongSources) {
      await page.goto(`${permalink}&${new URLSearchParams({ returnTo })}`);
      await settled(page);
      assert.equal(await page.locator('.library-sheets-heading h2').textContent(), chapter.title);
      assert.equal(await rows(page).count(), 2, 'invalid or stale origin falls back to actual placement');
    }
    await page.goto(`/drafts/${standalone.draftId}`);
    await settled(page);
    assert.equal(await page.locator('.library-project-row[data-active], .library-children [aria-current="page"]').count(), 0);
    assert.equal(await page.locator('.library-project-actions').count(), 0);
  });

  await t.test('a contextual draft and a fresh tab restore the whole-project group and selection', async () => {
    const source = `${projectPath}?${new URLSearchParams({ selected: scenes[1].sceneId })}`;
    const permalink = `/drafts/${draft.draftId}?${new URLSearchParams({ revision: '1', start: '1', end: '3', returnTo: source })}`;
    await page.goto(permalink);
    await settled(page);
    assert.equal(await rows(page).count(), 3);
    assert.equal(await page.locator('.library-sheets-heading h2').textContent(), project.title);
    const fresh = await page.context().newPage();
    try {
      await fresh.goto(permalink);
      await settled(fresh);
      assert.equal(await rows(fresh).count(), 3);
      assert.equal(await fresh.locator('.library-sheet[aria-current="page"]').getAttribute('href'), permalink);
      await fresh.waitForLoadState('networkidle');
    } finally { await fresh.close(); }
    await page.waitForLoadState('networkidle');
  });
});
