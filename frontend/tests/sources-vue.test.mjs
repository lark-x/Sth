import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';
import { matchSourcesRoute, sourceRoute } from '../sources/routes.ts';
import { diagnoseRoute } from './route-diagnostics.mjs';

const root = resolve(import.meta.dirname, '../..');
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };
const h1 = (page, name) => page.getByRole('heading', { level: 1, name, exact: true });
const field = (page, name) => page.getByLabel(new RegExp(`^${RegExp.escape(name)}(?: \\*)?$`));
const link = (page, name) => page.getByRole('link', { name, exact: true });
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
async function expand(page, label) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${label}$`) });
  await summary.waitFor();
  if (!await summary.evaluate(element => element.parentElement.open)) await summary.click();
}
const path = id => `/sources/${encodeURIComponent(id)}`;
async function expectHeading(page, name) {
  await h1(page, name).waitFor().catch(async error => {
    throw new Error(`${name} did not appear at ${page.url()}. ${await page.locator('main').innerHTML()}`, { cause: error });
  });
}

test('sources matcher owns only delivered pages and actions', () => {
  const matches = href => matchSourcesRoute(new URL(href, 'http://sth.test'));
  for (const href of ['/sources', '/sources/', '/sources?projectId=p&q=x', '/sources/new', '/sources/new/',
    '/sources/source-1', '/sources/source-1/', '/sources/%E8%B5%84%E6%96%99?revision=1&start=0&end=2',
    '/sources/id?action=revise', '/sources/id?action=adopt-entry&revision=2&start=1&end=3', '/sources/id?action=impact&currentOnly=1']) {
    assert.equal(matches(href), true, href);
  }
  for (const href of ['/research', '/research/item', '/judgments', '/judgments/new', '/judgments/id',
    '/sources2', '/sources//', '/sources/id/history', '/sources/new/unknown', '/sources/id?action=compare',
    '/sources?action=impact', '/sources/new?action=revise', '/sources/id?action=revise&action=impact',
    '/sources/%ZZ', '/sources/%2F', '/sources/%5c', '/sources/%00', `/sources/${'a'.repeat(129)}`]) {
    assert.equal(matches(href), false, href);
  }
  assert.deepEqual(sourceRoute(new URL('http://sth.test/sources/%E8%B5%84%E6%96%99')), { page: 'detail', sourceId: '资料' });
});

// Mount the delivered component without changing the shared route registry.
// Links to other domains exercise the existing fallback with a real backend.
async function fixture(t) {
  const backend = await startService(t);
  const cache = await mkdtemp(join(tmpdir(), 'sth-sources-vue-'));
  const entry = '/__sources_test_entry.js';
  const vite = await createServer({
    configFile: false, root, publicDir: false, cacheDir: cache, logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: ['vue', 'reka-ui', '@lucide/vue'] },
    resolve: { alias: { '/assets': resolve(root, 'web/assets') } },
    plugins: [vue(), {
      name: 'sources-route-test',
      resolveId(id) { if (id === entry) return '\0sources-route-test'; },
      load(id) {
        if (id !== '\0sources-route-test') return;
        return `import { createApp, defineComponent, h, shallowRef, ref } from 'vue';
          import SourcesRoute from '/frontend/sources/SourcesRoute.vue';
          import { matchSourcesRoute } from '/frontend/sources/routes.ts';
          import LegacyRoute from '/frontend/LegacyRoute.vue';
          import '/frontend/styles.css';
          const url = shallowRef(new URL(location.href));
          const refresh = ref(0);
          const navigate = (href, replace = false) => {
            history[replace ? 'replaceState' : 'pushState'](null, '', href);
            url.value = new URL(location.href);
            window.scrollTo(0, 0);
          };
          window.__sourcesNavigate = navigate;
          window.__sourcesRefresh = () => refresh.value++;
          window.addEventListener('popstate', () => { url.value = new URL(location.href); });
          const onClick = event => {
            if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const a = event.target.closest('a[href]');
            if (!a || a.target || a.hasAttribute('download') || new URL(a.href).origin !== location.origin) return;
            event.preventDefault(); navigate(a.href);
          };
          createApp(defineComponent({ setup: () => () => h('div', { class: 'sth-app', onClick,
            'onSth:replace': event => navigate(event.detail, true) }, [
            h('div', { class: 'shell sth-shell' }, [
              h('aside', { class: 'sidebar sth-sidebar' }, [h('a', { class: 'brand', href: '/sources' }, 'Sth'),
                h('nav', { id: 'navigation', 'aria-label': '主导航' }, [h('a', { href: '/sources' }, '资料')])]),
              h('main', { id: 'main' }, [url.value.pathname === '/__sources_outside'
                ? h('h1', '其他页面')
                : h(matchSourcesRoute(url.value) ? SourcesRoute : LegacyRoute, { url: url.value,
                  key: refresh.value, onNavigate: navigate, onRefresh: () => refresh.value++ })])
            ])
          ]) })).mount('#app');`;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.method !== 'GET' || !/^\/(?:sources|research|judgments|diaries|characters|events|scenes|projects|__sources_outside)(?:\/|\?|$)/.test(req.url)) return next();
          try {
            const html = await server.transformIndexHtml(req.url, `<!doctype html><html lang="zh-CN"><head>
              <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
              <link rel="stylesheet" href="/web/assets/notebook.css"><title>资料测试</title></head>
              <body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
          } catch (error) { next(error); }
        });
      },
    }],
    server: { host: '127.0.0.1', strictPort: false, proxy: {
      '/api': { target: backend, changeOrigin: true,
        configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', backend)); } },
    } },
  });
  t.after(async () => {
    await vite.close();
    assert.equal(dirname(resolve(cache)), resolve(tmpdir()));
    assert.match(basename(cache), /^sth-sources-vue-[a-z0-9]+$/i);
    await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  async function invoke(operationId, input) {
    const response = await fetch(`${backend}/api/web/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, input, stepId: `sources-vue:${randomUUID()}` }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  return { origin, invoke };
}
async function ready(page) {
  await page.locator('.sources-route[aria-busy="false"]').waitFor();
  assert.equal(await h1(page, '页面暂时无法打开').count(), 0, await page.locator('main').innerText());
}
async function open(t, origin, href = '/sources/new', viewport = phone) {
  const page = await openBrowser(t, origin, viewport);
  assert.equal((await diagnoseRoute(page, () => page.goto(href))).status(), 200);
  await ready(page);
  return page;
}
async function navigate(page, href) {
  await page.evaluate(href => window.__sourcesNavigate(href), href);
  if (href === '/__sources_outside') await h1(page, '其他页面').waitFor();
  else await ready(page);
}
async function fill(page, { title, body, origin = '' }) {
  await field(page, '标题').fill(title);
  await field(page, '正文').fill(body);
  await field(page, '出处').fill(origin);
}
async function saved(page, title) {
  await h1(page, title).waitFor();
  await ready(page);
  return new URL(page.url()).pathname.split('/').at(-1);
}
async function capture(page, name) {
  const folder = process.env.STH_SOURCES_VUE_ARTIFACTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: true, animations: 'disabled' });
}

test('Vue sources independent routes, retained drafts and exact public API references', { timeout: 240_000 }, async t => {
  const { origin, invoke } = await fixture(t);
  const create = values => invoke('source.create', { kind: 'excerpt', ...values });

  for (const [name, viewport] of [['phone', phone], ['desktop', desktop]]) {
    await t.test(`${name} create, revise, clear origin, history, reload and search`, async t => {
      const page = await open(t, origin, '/sources/new', viewport);
      const first = { title: `${name} 北港渡船`, body: '末班十点。\n🚢 船靠北岸。', origin: '码头公告牌' };
      await fill(page, first);
      await field(page, '类型').selectOption({ label: '设定' });
      await assertFitsViewport(page);
      await capture(page, `${name}-editor`);
      await click(page, '新建资料');
      const sourceId = await saved(page, first.title);
      const initial = await invoke('source.read', { sourceId });
      assert.equal(initial.body, first.body);
      assert.equal(initial.origin, first.origin);
      assert.deepEqual(initial.projectIds, []);
      await expand(page, '版本历史');
      await link(page, '第 1 版').click();
      await ready(page);
      await expand(page, '更多');
      assert.equal(await link(page, '修订资料').count(), 1, 'latest pinned version can still be revised');
      await link(page, '修订资料').click();
      await h1(page, '修订资料').waitFor();
      await field(page, '正文').fill('末班九点。');
      await field(page, '出处').fill('');
      await click(page, '保存修订');
      await saved(page, first.title);
      assert.equal((await invoke('source.read', { sourceId })).revision, 2);
      assert.equal((await invoke('source.read', { sourceId })).origin, undefined);
      await expand(page, '版本历史');
      await link(page, '第 1 版').click();
      await ready(page);
      assert.equal(await page.locator('#passage-body').textContent(), first.body);
      await expand(page, '更多');
      assert.equal(await link(page, '修订资料').count(), 0);
      await page.reload();
      await ready(page);
      assert.equal(await page.locator('#passage-body').textContent(), first.body);
      await expand(page, '更多');
      await link(page, '查看当前版本').click();
      await ready(page);
      assert.equal(await page.locator('#passage-body').textContent(), '末班九点。');
      await capture(page, `${name}-detail`);
      await assertFitsViewport(page);
      await navigate(page, '/sources');
      await expand(page, '筛选');
      await field(page, '关键词').fill('末班九点');
      await field(page, '关键词').press('Enter');
      await ready(page);
      assert.equal(new URL(page.url()).searchParams.get('q'), '末班九点');
      await link(page, first.title).click();
      await ready(page);
      assert.equal(new URL(page.url()).searchParams.get('revision'), '2');
      await link(page, '定位第 1 处').waitFor();
    });
  }

  await t.test('project attachments, explicit draft clearing and whitespace validation', async t => {
    const project = await invoke('project.create', { title: '资料项目' });
    const page = await open(t, origin, `/sources/new?projectId=${project.projectId}`);
    assert.equal(await page.getByRole('checkbox', { name: '资料项目' }).isChecked(), true);
    await fill(page, { title: '   ', body: '   ' });
    await click(page, '新建资料');
    assert.equal(await field(page, '标题').evaluate(input => input.validationMessage), '请填写非空白内容。');
    await fill(page, { title: '未保存资料', body: '草稿' });
    await navigate(page, '/__sources_outside');
    await navigate(page, `/sources/new?projectId=${project.projectId}`);
    assert.equal(await field(page, '标题').inputValue(), '未保存资料');
    await click(page, '清除草稿');
    assert.equal(await field(page, '标题').inputValue(), '');
    await fill(page, { title: '关联项目的资料', body: '项目中的正文' });
    await click(page, '新建资料');
    const sourceId = await saved(page, '关联项目的资料');
    assert.deepEqual((await invoke('source.read', { sourceId })).projectIds, [project.projectId]);
    await expand(page, '更多');
    await link(page, '修订资料').click();
    await h1(page, '修订资料').waitFor();
    await page.getByRole('checkbox', { name: '资料项目' }).uncheck();
    await click(page, '保存修订');
    await saved(page, '关联项目的资料');
    assert.deepEqual((await invoke('source.read', { sourceId })).projectIds, []);
  });

  await t.test('drafts survive remount and reload while revision conflicts remain explicit', async t => {
    const source = await create({ title: '并行修订', body: '最初正文。' });
    const page = await open(t, origin, `${path(source.sourceId)}?action=revise`);
    await field(page, '正文').fill('我的本地修改。');
    await navigate(page, '/__sources_outside');
    await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '另一位作者的修改。', origin: '后来补充的出处' });
    await navigate(page, `${path(source.sourceId)}?action=revise`);
    assert.equal(await field(page, '正文').inputValue(), '我的本地修改。');
    await page.reload();
    await ready(page);
    assert.equal(await field(page, '正文').inputValue(), '我的本地修改。');
    await click(page, '保存修订');
    await page.getByRole('region', { name: '版本冲突' }).waitFor();
    await page.getByText('另一位作者的修改。', { exact: true }).waitFor();
    assert.equal(await field(page, '正文').inputValue(), '我的本地修改。');
    assert.equal((await invoke('source.read', { sourceId: source.sourceId })).revision, 2);
    await click(page, '保留我的修改并采用新版');
    await click(page, '保存修订');
    await saved(page, source.title);
    const current = await invoke('source.read', { sourceId: source.sourceId });
    assert.equal(current.revision, 3);
    assert.equal(current.body, '我的本地修改。');
  });

  await t.test('conflict can use the full latest record including metadata', async t => {
    const source = await create({ title: '采用新版本', body: '旧正文', origin: '旧出处' });
    const page = await open(t, origin, `${path(source.sourceId)}?action=revise`);
    await field(page, '正文').fill('废弃的草稿');
    await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, title: '最新标题', body: '最新正文', origin: null, kind: 'inspiration' });
    await click(page, '保存修订');
    await page.getByRole('region', { name: '版本冲突' }).waitFor();
    await click(page, '改用最新版');
    assert.equal(await field(page, '标题').inputValue(), '最新标题');
    assert.equal(await field(page, '正文').inputValue(), '最新正文');
    assert.equal(await field(page, '出处').inputValue(), '');
    assert.equal(await field(page, '类型').inputValue(), 'inspiration');
    await click(page, '保存修订');
    await saved(page, '最新标题');
    assert.equal((await invoke('source.read', { sourceId: source.sourceId })).revision, 2, 'no-op edit does not create a revision');
  });

  await t.test('repeated UTF-16 excerpts, judgment and diary fallback, immutable pins and backlinks', async t => {
    const body = '🚢 第一张：末班十点。\n第二张：末班十点。';
    const source = await create({ title: '北港重复通告', body, origin: '码头公告牌' });
    const excerpt = '末班十点';
    const start = body.lastIndexOf(excerpt);
    const range = { start, end: start + excerpt.length };
    const page = await open(t, origin, `/sources?q=${encodeURIComponent(excerpt)}`);
    await link(page, source.title).click();
    await ready(page);
    await link(page, '定位第 2 处').click();
    await ready(page);
    assert.equal(await page.locator('#passage-body mark').textContent(), excerpt);
    assert.equal(new URL(page.url()).searchParams.get('start'), String(start));
    await click(page, '用作判断依据');
    await expectHeading(page, '新建判断');
    assert.equal(await page.locator('.legacy-route').count(), 1);
    await field(page, '标题').fill('夜航时刻');
    await field(page, '判断').fill('此通告适用于旧航线。');
    await field(page, '适用范围').fill('北港旧航线');
    await click(page, '新建判断');
    await h1(page, '夜航时刻').waitFor();
    const judgmentId = new URL(page.url()).pathname.split('/').at(-1);
    assert.deepEqual((await invoke('judgment.read', { judgmentId })).evidence[0].pin.range, range);
    await link(page, '原文 · 第 1 版').click();
    await ready(page);
    await click(page, '引用到日记');
    await field(page, '标题').fill('北港日记');
    await field(page, '正文').fill('我赶上了船。');
    await click(page, '保存日记');
    await h1(page, '北港日记').waitFor();
    const noteId = new URL(page.url()).pathname.split('/').at(-1);
    await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '末班九点。' });
    await page.reload();
    await link(page, '查看资料原文 · 第 1 版').click();
    await ready(page);
    assert.equal(await page.locator('#passage-body mark').textContent(), excerpt);
    assert.deepEqual((await invoke('diary.read', { noteId })).sourcePins[0].range, range);
    await expand(page, '引用这条资料的内容');
    await link(page, '判断 · 夜航时刻 · 第 1 版').waitFor();
    await link(page, '日记 · 北港日记 · 第 1 版').waitFor();
    await assertFitsViewport(page);
    await capture(page, 'phone-pinned-backlinks');
  });

  await t.test('actual DOM selection, character adoption draft and reverse character evidence', async t => {
    const body = '🚢 第一处相同。\n第二处相同。';
    const source = await create({ title: '角色的原始证据', body });
    const character = await invoke('character.create', { name: '守船人' });
    const page = await open(t, origin, path(source.sourceId));
    await click(page, '采纳为角色条目');
    assert.equal(await page.locator('#passage-status').textContent(), '请先选中一段原文。');
    const start = body.lastIndexOf('相同');
    await page.evaluate(({ start, end }) => {
      const walker = document.createTreeWalker(document.querySelector('#passage-body'), NodeFilter.SHOW_TEXT);
      let text;
      while (walker.nextNode()) if (walker.currentNode.textContent.length) { text = walker.currentNode; break; }
      const range = document.createRange();
      range.setStart(text, start); range.setEnd(text, end);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    }, { start, end: start + 2 });
    await click(page, '采纳为角色条目');
    await h1(page, '采纳为角色条目').waitFor();
    const adoptionHref = new URL(page.url()).pathname + new URL(page.url()).search;
    assert.equal(new URL(page.url()).searchParams.get('start'), String(start));
    await field(page, '采纳到角色').selectOption(character.characterId);
    await field(page, '条目名称').fill('第二处证据');
    await field(page, '条目补充文字').fill('保留第二次出现的原文。');
    await navigate(page, '/__sources_outside');
    await navigate(page, adoptionHref);
    assert.equal(await field(page, '条目名称').inputValue(), '第二处证据');
    await invoke('character.revise', { characterId: character.characterId, expectedRevision: 1, persona: '同时修订的角色设定' });
    await click(page, '采纳条目');
    await h1(page, '守船人').waitFor();
    const card = await invoke('character.read', { characterId: character.characterId });
    assert.equal(card.persona, '同时修订的角色设定');
    assert.equal(card.entries.length, 1);
    const reference = card.entries[0].blocks.find(block => block.type === 'reference');
    assert.deepEqual(reference.range, { start, end: start + 2 });
    assert.equal(reference.excerpt, '相同');
    await navigate(page, path(source.sourceId));
    await expand(page, '引用这条资料的内容');
    await link(page, '守船人 · 第 3 版 · 第二处证据').waitFor();
    assert.equal(await link(page, '守船人 · 第 3 版 · 第二处证据').getAttribute('href'), `/characters/${character.characterId}?revision=3`);
  });

  for (const operationId of ['source.create', 'source.revise', 'character.adopt-entries']) {
    await t.test(`${operationId} lost response retries the exact receipt after reload`, async t => {
      const source = operationId === 'source.create' ? undefined : await create({ title: `回执 ${operationId}`, body: '仍然存在的原文。' });
      const character = operationId === 'character.adopt-entries' ? await invoke('character.create', { name: '回执角色' }) : undefined;
      const href = !source ? '/sources/new' : `${path(source.sourceId)}?action=${character ? 'adopt-entry&revision=1&start=0&end=2' : 'revise'}`;
      const page = await open(t, origin, href, desktop);
      let first;
      let invokes = 0;
      await page.route('**/api/web/invoke', async route => {
        const call = route.request().postDataJSON();
        if (call.operationId !== operationId) return route.continue();
        invokes++;
        first ??= call;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort();
      });
      if (character) {
        await field(page, '采纳到角色').selectOption(character.characterId);
        await field(page, '条目名称').fill('仅有一份条目');
        await click(page, '采纳条目');
      } else {
        await fill(page, { title: `仅存一份 ${operationId}`, body: '保存的唯一内容。' });
        await click(page, operationId === 'source.create' ? '新建资料' : '保存修订');
      }
      await page.getByRole('alert').filter({ hasText: '重试同一次提交' }).waitFor();
      await page.reload();
      await ready(page);
      const receipt = page.waitForRequest('**/api/web/receipt');
      await click(page, '重试同一次提交');
      assert.deepEqual((await receipt).postDataJSON(), { operationId: first.operationId, stepId: first.stepId });
      await expectHeading(page, character ? '回执角色' : `仅存一份 ${operationId}`);
      assert.equal(invokes, 1);
      if (character) assert.equal((await invoke('character.read', { characterId: character.characterId })).entries.length, 1);
      else assert.equal((await invoke('source.search', { query: `仅存一份 ${operationId}` })).items.length, 1);
    });
  }

  await t.test('write completing after unmount can be recovered without another submission', async t => {
    const page = await open(t, origin);
    let release;
    let seen;
    const received = new Promise(resolve => { seen = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/web/invoke', async route => {
      if (route.request().postDataJSON().operationId !== 'source.create') return route.continue();
      const response = await route.fetch();
      seen();
      await gate;
      await route.fulfill({ response });
    });
    await fill(page, { title: '离开时仍在保存', body: '后台保存的原文。' });
    await click(page, '新建资料');
    await received;
    await navigate(page, '/__sources_outside');
    const response = page.waitForResponse(response => response.url().endsWith('/api/web/invoke') && response.request().postDataJSON()?.operationId === 'source.create');
    release();
    await response;
    await navigate(page, '/sources/new');
    await link(page, '查看已保存资料').waitFor();
    await link(page, '查看已保存资料').click();
    await saved(page, '离开时仍在保存');
    assert.equal((await invoke('source.search', { query: '离开时仍在保存' })).items.length, 1);
    await navigate(page, '/sources/new');
    assert.equal(await field(page, '标题').inputValue(), '', 'recovering the saved record releases the completed draft');
  });

  await t.test('a missing receipt resubmits the same immutable call', async t => {
    const page = await open(t, origin);
    const calls = [];
    await page.route('**/api/web/invoke', route => {
      const call = route.request().postDataJSON();
      if (call.operationId !== 'source.create') return route.continue();
      calls.push(call);
      return calls.length === 1 ? route.abort() : route.continue();
    });
    await fill(page, { title: '未送达的第一次提交', body: '重发同一次请求。' });
    await click(page, '新建资料');
    await page.getByRole('alert').filter({ hasText: '重试同一次提交' }).waitFor();
    assert.equal(await field(page, '正文').isDisabled(), true);
    const receipt = page.waitForRequest('**/api/web/receipt');
    await click(page, '重试同一次提交');
    assert.equal((await receipt).postDataJSON().stepId, calls[0].stepId);
    await saved(page, '未送达的第一次提交');
    assert.deepEqual(calls[0], calls[1]);
    assert.equal((await invoke('source.search', { query: '未送达的第一次提交' })).items.length, 1);
  });

  await t.test('cancelled reads cannot replace a newer route and long histories retain old versions', async t => {
    const slow = await create({ title: '延迟旧页面', body: '不应显示的旧正文。' });
    const current = await create({ title: '新的资料页面', body: '初版正文。' });
    for (let revision = 1; revision <= 21; revision++) await invoke('source.revise', {
      sourceId: current.sourceId, expectedRevision: revision, body: `第 ${revision + 1} 次正文。`,
    });
    const page = await open(t, origin, '/sources');
    let release;
    let seen;
    let finished;
    const received = new Promise(resolve => { seen = resolve; });
    const settled = new Promise(resolve => { finished = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route('**/api/web/invoke', async route => {
      const call = route.request().postDataJSON();
      if (call.operationId !== 'source.read' || call.input.sourceId !== slow.sourceId) return route.continue();
      const response = await route.fetch();
      seen();
      await gate;
      try { await route.fulfill({ response }); } finally { finished(); }
    });
    await page.evaluate(href => window.__sourcesNavigate(href), path(slow.sourceId));
    await received;
    await navigate(page, path(current.sourceId));
    release();
    await settled;
    await h1(page, current.title).waitFor();
    assert.equal(await h1(page, slow.title).count(), 0);
    assert.equal(await page.locator('.sources-history a').count(), 22);
    await expand(page, '版本历史');
    await link(page, '第 1 版').click();
    await ready(page);
    assert.equal(await page.locator('#passage-body').textContent(), '初版正文。');
    await expand(page, '更多');
    assert.equal(await link(page, '修订资料').count(), 0);
  });

  await t.test('list and exact-match pagination, literal safe text and fallback boundaries', async t => {
    for (let i = 0; i < 21; i++) await create({ title: `分页验证 ${String(i).padStart(2, '0')}`, body: '分页正文' });
    const source = await create({ title: '匹配分页', body: `🚢 ${'同一句。'.repeat(12)}<img src=x onerror=alert(1)>` });
    const page = await open(t, origin, `/sources?q=${encodeURIComponent('分页验证')}`);
    assert.equal(await page.locator('#workspace-list h2 a').count(), 20);
    await click(page, '加载更多');
    await page.locator('#workspace-count').filter({ hasText: '21 条记录' }).waitFor();
    assert.equal(await page.locator('#workspace-list h2 a').count(), 21);
    await navigate(page, `${path(source.sourceId)}?revision=1&q=${encodeURIComponent('同一句')}`);
    assert.equal(await page.getByRole('link', { name: /^定位第/ }).count(), 10);
    await link(page, '下一页').click();
    await ready(page);
    await link(page, '定位第 12 处').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('matchOffset'), '10');
    assert.equal(await page.locator('#passage-body img').count(), 0);
    await link(page, '定位第 12 处').click();
    await ready(page);
    const exact = new URL(page.url());
    assert.equal(exact.searchParams.get('start'), String(source.body.lastIndexOf('同一句')));
    for (const [button, target] of [['提炼为事件', '/events/new'], ['引用到场景', '/scenes/new']]) {
      await click(page, button);
      await page.waitForURL(url => url.pathname === target);
      assert.equal(new URL(page.url()).searchParams.get('sourceRevision'), '1');
      assert.equal(new URL(page.url()).searchParams.get('start'), exact.searchParams.get('start'));
      await navigate(page, exact.pathname + exact.search);
    }
    await navigate(page, '/sources');
    await expand(page, '工作区');
    await link(page, '外部检索').click();
    await expectHeading(page, '外部检索');
    assert.equal(await page.locator('.legacy-route').count(), 1);
    await navigate(page, '/sources');
    await expand(page, '工作区');
    await link(page, '判断').click();
    await h1(page, '判断').waitFor();
    assert.equal(await page.locator('.legacy-route').count(), 1);
    await page.evaluate(() => window.__sourcesNavigate('/sources/arbitrary/history'));
    await expectHeading(page, '找不到页面');
  });

  await t.test('impact filters and paging preserve exact versions after reload', async t => {
    const source = await create({ title: '来源影响', body: '泊船。' });
    const pin = { sourceId: source.sourceId, revision: 1, excerpt: '泊船。', range: { start: 0, end: 3 } };
    for (let index = 0; index < 21; index++) await invoke('diary.create', { title: `影响记录 ${index}`, body: '已泊船。', diaryDate: '2026-11-24', sourcePins: [pin] });
    const page = await open(t, origin, path(source.sourceId));
    await expand(page, '更多');
    await link(page, '查看影响').click();
    await h1(page, '资料影响').waitFor();
    await field(page, '资源类型').selectOption('diary');
    await field(page, '版本范围').selectOption('1');
    await click(page, '筛选');
    await page.locator('[aria-label="资料影响"][aria-busy="false"]').waitFor();
    assert.equal(await page.locator('main h2 a').count(), 20);
    await link(page, '下一页').click();
    await page.locator('[aria-label="资料影响"][aria-busy="false"]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('offset'), '20');
    await page.reload();
    await page.locator('[aria-label="资料影响"][aria-busy="false"]').waitFor();
    assert.equal(await page.locator('main h2 a').count(), 1);
    assert.equal(new URL(page.url()).searchParams.get('currentOnly'), '1');
    await assertFitsViewport(page);
    await page.locator('main h2 a').click();
    await page.waitForURL(url => url.pathname.startsWith('/diaries/'));
    assert.equal(new URL(page.url()).searchParams.get('revision'), '1');
  });

  await t.test('read failures can retry and invalid selection or revision cannot cite another record', async t => {
    const source = await create({ title: '读取恢复', body: '可恢复的正文。' });
    const page = await open(t, origin, '/sources');
    await page.route('**/api/web/invoke', route => route.request().postDataJSON().operationId === 'source.read'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable' } }) }) : route.continue());
    await page.evaluate(href => window.__sourcesNavigate(href), path(source.sourceId));
    await h1(page, '页面暂时无法打开').waitFor();
    await page.unroute('**/api/web/invoke');
    await click(page, '重试');
    await ready(page);
    await h1(page, source.title).waitFor();
    await navigate(page, `${path(source.sourceId)}?revision=1&start=99999&end=100000`);
    await click(page, '引用到日记');
    assert.equal(await page.locator('#passage-status').textContent(), '请先选中一段原文。');
    await page.evaluate(href => window.__sourcesNavigate(href), `${path(source.sourceId)}?revision=0`);
    await h1(page, '页面暂时无法打开').waitFor();
    await page.getByRole('alert').filter({ hasText: '版本号无效' }).waitFor();
  });
});
