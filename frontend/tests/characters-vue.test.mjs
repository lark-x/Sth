import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';
import { characterRoute, matchCharactersRoute } from '../characters/routes.ts';
import { diagnoseRoute } from './route-diagnostics.mjs';

const root = resolve(import.meta.dirname, '../..');
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };
const h1 = (page, name) => page.getByRole('heading', { level: 1, name, exact: true });
const field = (page, name) => page.getByLabel(new RegExp(`^${RegExp.escape(name)}(?: \\*)?$`));
const link = (page, name) => page.getByRole('link', { name, exact: true });
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const idAt = page => new URL(page.url()).pathname.split('/').at(-1);
async function expand(page, label) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${label}$`) });
  await summary.waitFor();
  if (!await summary.evaluate(element => element.parentElement.open)) await summary.click();
}
const path = id => `/characters/${encodeURIComponent(id)}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ4sAAAAASUVORK5CYII=', 'base64');

function wav() {
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(16000, 40);
  return buffer;
}

test('character matcher claims only delivered routes and preserves query semantics', () => {
  const matches = value => matchCharactersRoute(new URL(value, 'http://sth.test'));
  for (const value of ['/characters', '/characters/', '/characters?projectId=p', '/characters/new', '/characters/new/',
    '/characters/one', '/characters/one/', '/characters/%E5%B2%9A?revision=2&edit=1', '/characters/one?revision=bad']) {
    assert.equal(matches(value), true, value);
  }
  for (const value of ['/character', '/characters2', '/characters//', '/characters/one/history', '/characters/new/edit',
    '/characters/one?action=unknown', '/characters?action=', '/characters/%ZZ', '/characters/%2F', '/characters/%5c',
    '/characters/%00', '/characters/%20', `/characters/${'a'.repeat(129)}`]) {
    assert.equal(matches(value), false, value);
  }
  assert.deepEqual(characterRoute(new URL('http://sth.test/characters/%E5%B2%9A')), { page: 'detail', characterId: '岚' });
});

// The independent host exercises the exact integration contract before Hubble
// changes the shared registry. Cross-domain routes retain their real pages.
async function fixture(t) {
  const backend = await startService(t);
  const cache = await mkdtemp(join(tmpdir(), 'sth-characters-vue-'));
  const entry = '/__characters_test_entry.js';
  const vite = await createServer({
    configFile: false, root, publicDir: false, cacheDir: cache, logLevel: 'error',
    // Scan the delivered app, not archived HTML under the repository's artifacts.
    optimizeDeps: { entries: ['frontend/main.ts'], include: ['vue', 'reka-ui', '@lucide/vue'] },
    resolve: { alias: { '/assets': resolve(root, 'web/assets') } },
    plugins: [vue(), {
      name: 'characters-route-test',
      resolveId(id) { if (id === entry) return '\0characters-route-test'; },
      load(id) {
        if (id !== '\0characters-route-test') return;
        return `import { createApp, defineComponent, h, shallowRef, ref } from 'vue';
          import CharacterRoute from '/frontend/characters/CharacterRoute.vue';
          import { matchCharactersRoute } from '/frontend/characters/routes.ts';
          import DiaryRoute from '/frontend/diary/DiaryRoute.vue';
          import WorkspaceRoute from '/frontend/workspace/WorkspaceRoute.vue';
          import LegacyRoute from '/frontend/LegacyRoute.vue';
          import '/frontend/styles.css';
          const url = shallowRef(new URL(location.href));
          const refresh = ref(0);
          const navigate = (href, replace = false) => {
            history[replace ? 'replaceState' : 'pushState'](null, '', href);
            url.value = new URL(location.href);
            window.scrollTo(0, 0);
          };
          window.__charactersNavigate = navigate;
          window.__charactersRefresh = () => refresh.value++;
          window.addEventListener('popstate', () => { url.value = new URL(location.href); });
          const onClick = event => {
            if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const a = event.target.closest('a[href]');
            if (!a || a.target || a.hash || a.hasAttribute('download') || new URL(a.href).origin !== location.origin) return;
            event.preventDefault(); navigate(a.href);
          };
          const component = () => matchCharactersRoute(url.value) ? CharacterRoute
            : url.value.pathname.startsWith('/diaries') ? DiaryRoute
            : url.value.pathname === '/workspace' ? WorkspaceRoute : LegacyRoute;
          createApp(defineComponent({ setup: () => () => h('div', { class: 'sth-app', onClick,
            'onSth:replace': event => navigate(event.detail, true) }, [
            h('div', { class: 'shell sth-shell' }, [
              h('aside', { class: 'sidebar sth-sidebar' }, [h('a', { class: 'brand', href: '/characters' }, 'Sth'),
                h('nav', { id: 'navigation', 'aria-label': '主导航' }, [['日记','/diaries'],['创作','/workspace'],['角色','/characters'],['资料','/sources'],['任务','/jobs']].map(([text, href]) => h('a', { href }, text)))]),
              h('main', { id: 'main' }, [url.value.pathname === '/__characters_outside'
                ? h('h1', '其他页面') : h(component(), { url: url.value, key: refresh.value,
                  onNavigate: navigate, onRefresh: () => refresh.value++ })])
            ])
          ]) })).mount('#app');`;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.method !== 'GET' || !/^\/(?:characters|diaries|sources|scenes|drafts|workspace|__characters_outside)(?:\/|\?|$)/.test(req.url)) return next();
          try {
            const requestedShell = new URL(req.url, 'http://localhost').searchParams.has('__characters_shell');
            if (requestedShell) res.setHeader('Set-Cookie', 'sth-characters-shell=1; Path=/; SameSite=Strict');
            const shell = requestedShell || /(?:^|;\s*)sth-characters-shell=1(?:;|$)/.test(req.headers.cookie ?? '');
            const script = shell ? '/frontend/main.ts' : entry;
            const html = await server.transformIndexHtml(req.url, `<!doctype html><html lang="zh-CN"><head>
              <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
              <link rel="stylesheet" href="/web/assets/notebook.css"><title>角色测试</title></head>
              <body><div id="app"></div><script type="module" src="${script}"></script></body></html>`);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
          } catch (error) { next(error); }
        });
      },
    }],
    server: { host: '127.0.0.1', strictPort: false, hmr: false, proxy: {
      '/assets': { target: backend, changeOrigin: true,
        configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', backend)); } },
      '/api': { target: backend, changeOrigin: true,
        configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', backend)); } },
    } },
  });
  t.after(async () => {
    await vite.close();
    assert.equal(dirname(resolve(cache)), resolve(tmpdir()));
    assert.match(basename(cache), /^sth-characters-vue-[a-z0-9]+$/i);
    await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  async function invoke(operationId, input) {
    const response = await fetch(`${backend}/api/web/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, input, stepId: `characters-vue:${randomUUID()}` }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  return { origin, invoke };
}
async function ready(page) {
  await page.locator('.characters-route > section[aria-busy="false"]').waitFor().catch(async error => {
    throw new Error(`Character route did not settle. ${await page.locator('main').innerText()}`, { cause: error });
  });
}
async function open(t, origin, href = '/characters', viewport = phone) {
  const page = await openBrowser(t, origin, viewport);
  assert.equal((await diagnoseRoute(page, () => page.goto(href))).status(), 200);
  await ready(page);
  return page;
}
async function navigate(page, href) {
  await page.evaluate(href => window.__charactersNavigate(href), href);
  if (href === '/__characters_outside') await h1(page, '其他页面').waitFor();
  else await ready(page);
}
async function editorReady(page) {
  await page.locator('.characters-editor[aria-busy="false"] #editor').waitFor().catch(async error => {
    throw new Error(`Character editor did not settle. ${await page.locator('main').innerText()}`, { cause: error });
  });
}
async function capture(page, name) {
  if (process.env.STH_CHARACTER_SCREENSHOTS !== '1') return;
  const directory = join(tmpdir(), 'sth-characters-vue-screenshots');
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  console.log(`Character screenshot ${target}`);
}

test('Vue character pages retain the character business flows', { timeout: 180_000 }, async t => {
  const { origin, invoke } = await fixture(t);

  for (const [size, viewport] of [['desktop', desktop], ['phone', phone]]) {
    await t.test(`${size} uses the delivered matcher through the current real shell`, async t => {
      const page = await open(t, origin, '/characters?__characters_shell=1', viewport);
      if (size === 'phone') await click(page, '打开资料库导航');
      const navigation = page.locator('#library-navigation');
      assert.equal(await link(navigation, '角色').getAttribute('aria-current'), 'page');
      if (size === 'phone') await click(page, '返回当前页面');
      assert.equal(await page.locator('.legacy-route').count(), 0);
      await link(page, '新建角色').click();
      await editorReady(page);
      await field(page, '角色名称').fill(`${size} shell 角色`);
      await field(page, '角色设定').fill('从正常导航进入的角色设定。');
      await click(page, '创建角色');
      await h1(page, `${size} shell 角色`).waitFor();
      assert.equal((await invoke('character.read', { characterId: idAt(page) })).persona, '从正常导航进入的角色设定。');
      assert.equal(await page.locator('.legacy-route').count(), 0);
      await assertFitsViewport(page);
      await capture(page, `${size}-real-shell`);
      await expand(page, '更多');
      await link(page, '编辑设定').click();
      await editorReady(page);
      await field(page, '角色设定').fill('从正常导航保存的新设定。');
      await click(page, '保存设定');
      await h1(page, `${size} shell 角色`).waitFor();
      assert.equal((await invoke('character.read', { characterId: idAt(page) })).revision, 2);
      await page.reload();
      await page.getByText('从正常导航保存的新设定。', { exact: true }).waitFor();
      assert.equal(await page.locator('#app .sth-mobile-toolbar').count(), 1, 'reload retains the actual delivered shell');
      if (size === 'phone') await click(page, '打开资料库导航');
      await link(navigation, '角色').click();
      await ready(page);
      await page.getByRole('heading', { name: `${size} shell 角色`, exact: true }).waitFor();
    });
  }

  for (const [size, viewport] of [['desktop', desktop], ['phone', phone], ['small-phone', { width: 320, height: 740 }]]) {
    await t.test(`${size} creates, reads, revises and filters project and personal characters`, async t => {
      const project = await invoke('project.create', { title: `${size} 的港口手记` });
      const page = await open(t, origin, `/characters?projectId=${project.projectId}`, viewport);
      await page.getByText('还没有角色', { exact: true }).waitFor();
      await link(page, '新建角色').click();
      await editorReady(page);
      assert.equal(await field(page, '项目').inputValue(), project.projectId);
      await field(page, '角色名称').fill(`${size} 林澈`);
      await field(page, '角色设定').fill('负责港口夜间巡逻。\n记得每一盏灯的位置。');
      await assertFitsViewport(page);
      await capture(page, `${size}-editor`);
      await click(page, '创建角色');
      await h1(page, `${size} 林澈`).waitFor();
      const characterId = idAt(page);
      const record = await invoke('character.read', { characterId });
      assert.equal(record.projectId, project.projectId);
      assert.equal(record.revision, 1);
      await page.getByRole('article', { name: '角色设定' }).getByText(record.persona, { exact: true }).waitFor();
      assert.equal(await page.locator('.legacy-route').count(), 0);
      await capture(page, `${size}-reading`);
      await expand(page, '更多');
      await link(page, '编辑设定').click();
      await editorReady(page);
      assert.equal(await field(page, '项目').count(), 0, 'project assignment stays immutable');
      await field(page, '角色设定').fill('巡夜后整理旧航图。');
      await click(page, '保存设定');
      await h1(page, `${size} 林澈`).waitFor();
      assert.equal((await invoke('character.read', { characterId })).revision, 2);
      await page.reload();
      await page.getByText('巡夜后整理旧航图。', { exact: true }).waitFor();
      await assertFitsViewport(page);
      await link(page.getByRole('main'), '角色').click();
      await ready(page);
      assert.equal(await field(page, '项目').inputValue(), project.projectId);
      await page.getByRole('link').filter({ has: page.getByRole('heading', { name: `${size} 林澈`, exact: true }) }).waitFor();
      await expand(page, '筛选');
      await field(page, '项目').selectOption('');
      await ready(page);
      assert.equal(new URL(page.url()).searchParams.get('projectId'), null);
      await navigate(page, '/characters/new');
      await editorReady(page);
      assert.equal(await field(page, '项目').inputValue(), '');
      await field(page, '角色名称').fill(`${size} 独立角色`);
      await click(page, '创建角色');
      await h1(page, `${size} 独立角色`).waitFor();
      assert.equal((await invoke('character.read', { characterId: idAt(page) })).projectId, undefined);
    });
  }

  await t.test('real image and audio, entry ordering, scene backlinks and original diary persona version survive', async t => {
    const scene = await invoke('scene.create', { title: '夜航' });
    const page = await open(t, origin, '/characters/new');
    await editorReady(page);
    await click(page, '添加条目');
    await field(page, '条目名称').fill('港口记录');
    await click(page, '添加图片');
    await field(page, '图片文件').setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: png });
    await page.getByText('已上传 portrait.png', { exact: true }).waitFor();
    await click(page, '添加音频');
    const clip = wav();
    await field(page, '音频文件').setInputFiles({ name: 'voice.wav', mimeType: 'audio/x-wav', buffer: clip });
    await page.getByText('已上传 voice.wav', { exact: true }).waitFor();
    await assertFitsViewport(page);
    await click(page, '创建角色');
    await h1(page, '未命名角色').waitFor();
    const characterId = idAt(page);
    const first = await invoke('character.read', { characterId, revision: 1 });
    assert.deepEqual(first.entries[0].blocks.map(block => block.type), ['image', 'audio']);
    await page.getByRole('img', { name: '港口记录' }).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('main img')?.naturalWidth === 1);
    const audio = page.locator('audio');
    const bytes = await page.request.get(await audio.getAttribute('src'));
    assert.equal(bytes.headers()['content-type'], 'audio/wav');
    assert.deepEqual(await bytes.body(), clip);
    await audio.evaluate(async player => { await player.play(); });
    assert.equal(await audio.evaluate(player => player.duration), 1);
    await capture(page, 'phone-multimedia');
    await expand(page, '更多');
    await link(page, '写角色日记').click();
    await h1(page, '写日记').waitFor();
    await page.locator('summary').filter({ hasText: /^写作上下文/ }).click();
    assert.equal(await field(page, '叙述者').inputValue(), characterId);
    await field(page, '标题').fill('晚班日记');
    await field(page, '正文').fill('我登上末班渡轮。');
    await click(page, '保存日记');
    await h1(page, '晚班日记').waitFor();
    const diaryId = idAt(page);
    await click(page, '依据与修订');
    await link(page, '查看角色证据 · 第 1 版').click();
    await h1(page, '未命名角色').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('revision'), '1');
    await expand(page, '更多');
    assert.equal(await link(page, '编辑设定').count(), 0);
    await link(page, '查看当前版本').click();
    await ready(page);
    await expand(page, '更多');
    await link(page, '编辑设定').click();
    await editorReady(page);
    await field(page, '角色名称').fill('渡船领航员');
    await field(page, '角色设定').fill('只上夜班。');
    await field(page, '图片文件').setInputFiles({ name: 'wrong.txt', mimeType: 'text/plain', buffer: Buffer.from('wrong type') });
    await page.getByText('请选择受支持的图片文件。 已保留原文件。', { exact: true }).waitFor();
    await click(page, '添加文本');
    await field(page, '文本内容').fill('熟悉潮汐。');
    await click(page, '添加资料链接');
    await field(page, '资料类型').selectOption('scene');
    await field(page, '资料记录').selectOption(scene.sceneId);
    assert.equal(await field(page, '资料版本').inputValue(), '1');
    await click(page.locator('.character-block').nth(3), '上移内容');
    await click(page, '添加条目');
    await field(page, '条目名称').nth(1).fill('临时条目');
    await click(page.locator('.character-entry').nth(1), '移除条目');
    await click(page, '添加条目');
    await field(page, '条目名称').nth(1).fill('私下记录');
    await click(page.locator('.character-entry').nth(1), '添加文本');
    await field(page, '文本内容').nth(1).fill('收集旧船票。');
    await click(page.locator('.character-entry').nth(1), '上移条目');
    await click(page.locator('.character-block').filter({ has: field(page, '音频文件') }), '移除内容');
    await click(page, '保存设定');
    await h1(page, '渡船领航员').waitFor();
    const latest = await invoke('character.read', { characterId });
    assert.equal(latest.revision, 2);
    assert.deepEqual(latest.entries.map(entry => entry.label), ['私下记录', '港口记录']);
    assert.equal(latest.entries[1].entryId, first.entries[0].entryId);
    assert.equal(latest.entries[1].blocks[0].assetId, first.entries[0].blocks[0].assetId);
    assert.deepEqual(latest.entries[1].blocks.map(block => block.type), ['image', 'reference', 'text']);
    await link(page, '场景 · 第 1 版').click();
    await h1(page, '夜航').waitFor();
    await link(page, '渡船领航员 · 第 2 版 · 港口记录').click();
    await h1(page, '渡船领航员').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('revision'), '2');
    await navigate(page, `${path(characterId)}?revision=1&edit=1`);
    await h1(page, '未命名角色').waitFor();
    assert.equal(await page.getByRole('form').count(), 0);
    await page.locator('audio[controls]').waitFor();
    assert.equal((await invoke('diary.read', { noteId: diaryId })).character.revision, 1);
    await assertFitsViewport(page);
  });

  await t.test('historical references retain repeated UTF-16 passages and stable entries through editing', async t => {
    const body = '🚢 第一张：末班十点。\n第二张：末班十点。';
    const start = body.lastIndexOf('末班十点');
    const range = { start, end: start + '末班十点'.length };
    const source = await invoke('source.create', { kind: 'excerpt', title: '北港通告', body });
    const saved = await invoke('character.create', { name: '守船人', entries: [{ label: '第二次通知', blocks: [
      { type: 'reference', kind: 'source', id: source.sourceId, revision: 1, excerpt: '末班十点', range },
    ] }] });
    await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '末班九点。' });
    const page = await open(t, origin, saved.href);
    const reference = link(page, '资料 · 第 1 版');
    const sourceHref = `/sources/${source.sourceId}?revision=1&start=${range.start}&end=${range.end}`;
    assert.equal(await reference.getAttribute('href'), sourceHref);
    await reference.click();
    await h1(page, '北港通告').waitFor();
    assert.equal(await page.locator('#passage-body mark').textContent(), '末班十点');
    await navigate(page, `${saved.href}?edit=1`);
    await editorReady(page);
    assert.equal(await link(page, '查看所选版本原文').getAttribute('href'), sourceHref);
    await field(page, '角色设定').fill('牢记第二张公告。');
    await click(page, '保存设定');
    await h1(page, '守船人').waitFor();
    const readback = await invoke('character.read', { characterId: saved.characterId });
    assert.deepEqual(readback.entries, saved.entries);
    assert.equal(readback.revision, 2);
    await expand(page, '版本历史');
    await link(page, '第 1 版').click();
    await ready(page);
    assert.equal(await page.getByText('牢记第二张公告。', { exact: true }).count(), 0);
    await expand(page, '版本历史');
    await link(page, '第 2 版').click();
    await ready(page);
    await page.getByText('牢记第二张公告。', { exact: true }).waitFor();
    await expand(page, '更多');
    const sceneStart = link(page, '从这个版本构思场景');
    assert.equal(new URL(await sceneStart.getAttribute('href'), origin).searchParams.get('revision'), '2');
    await sceneStart.click();
    await h1(page, '从已有内容继续').waitFor();
    await page.getByText('牢记第二张公告。', { exact: true }).waitFor();
    await assertFitsViewport(page);
  });

  await t.test('draft persists across route and component changes and can be cleared explicitly', async t => {
    const page = await open(t, origin, '/characters/new');
    await editorReady(page);
    await field(page, '角色名称').fill('待写完的人');
    await click(page, '添加条目');
    await field(page, '条目名称').fill('未完成的记录');
    await click(page, '添加文本');
    await field(page, '文本内容').fill('明天继续。');
    await navigate(page, '/__characters_outside');
    await navigate(page, '/characters/new');
    await editorReady(page);
    assert.equal(await field(page, '角色名称').inputValue(), '待写完的人');
    assert.equal(await field(page, '文本内容').inputValue(), '明天继续。');
    await page.evaluate(() => window.__charactersRefresh());
    await editorReady(page);
    assert.equal(await field(page, '条目名称').inputValue(), '未完成的记录');
    page.once('dialog', dialog => dialog.accept());
    await click(page, '清除草稿');
    await editorReady(page);
    assert.equal(await field(page, '角色名称').inputValue(), '');
    assert.equal(await page.locator('.character-entry').count(), 0);
  });

  await t.test('a selected draft passage can be adopted into a character and read back through its exact source link', async t => {
    const character = await invoke('character.create', { name: '片段接收者', persona: '记住归航的声音。' });
    const scene = await invoke('scene.create', { title: '船边的呼喊' });
    const body = '他喊：等一下。\n他又喊：等一下。';
    const start = body.lastIndexOf('等一下。');
    const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '两次喊话', body });
    const page = await open(t, origin, character.href);
    await page.evaluate(href => window.__charactersNavigate(href), `/drafts/${draft.draftId}?revision=1&start=${start}&end=${body.length}`);
    await h1(page, '两次喊话').waitFor();
    assert.equal(await page.locator('#passage-body mark').textContent(), '等一下。');
    await click(page, '采纳为角色条目');
    await field(page, '采纳到角色').selectOption(character.characterId);
    await field(page, '条目名称').fill('第二次喊话');
    await click(page, '采纳条目');
    await h1(page, '片段接收者').waitFor();
    assert.equal(await page.locator('.characters-route').count(), 1);
    await page.getByRole('heading', { name: '第二次喊话', exact: true }).waitFor();
    const latest = await invoke('character.read', { characterId: character.characterId });
    assert.equal(latest.persona, character.persona);
    assert.deepEqual(latest.entries[0].blocks[0].range, { start, end: body.length });
    await link(page, '候选稿 · 第 1 版').click();
    await h1(page, '两次喊话').waitFor();
    assert.equal(await page.locator('#passage-body mark').textContent(), '等一下。');
  });

  await t.test('late reads are cancelled when another character opens', async t => {
    const older = await invoke('character.create', { name: '迟到的旧页', persona: '旧页正文' });
    const current = await invoke('character.create', { name: '正在阅读的人', persona: '当前正文' });
    const page = await open(t, origin, '/characters');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    let arrived;
    const started = new Promise(resolve => { arrived = resolve; });
    let completed;
    const finished = new Promise(resolve => { completed = resolve; });
    await page.route('**/api/web/invoke', async route => {
      const call = route.request().postDataJSON();
      if (call?.operationId !== 'character.read' || call.input.characterId !== older.characterId) return route.continue();
      const response = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response });
      completed();
    });
    await page.evaluate(href => window.__charactersNavigate(href), older.href);
    await started;
    await navigate(page, current.href);
    release();
    await finished;
    await h1(page, current.name).waitFor();
    assert.equal(await page.getByText(older.persona, { exact: true }).count(), 0);
  });

  await t.test('revision conflict merges edited entries with remote persona, and replacing uses exact latest entries', async t => {
    const saved = await invoke('character.create', { name: '旧称', persona: '旧设定', entries: [{ label: '习惯', blocks: [{ type: 'text', text: '原记录' }] }] });
    const page = await open(t, origin, `${saved.href}?edit=1`, desktop);
    await editorReady(page);
    await field(page, '文本内容').fill('本地记录');
    await invoke('character.revise', { characterId: saved.characterId, expectedRevision: 1, name: '新称', persona: '新版设定' });
    await click(page, '保存设定');
    const conflict = page.getByRole('region', { name: '版本冲突' });
    await conflict.getByText('新版设定', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存设定', exact: true }).isDisabled(), true);
    assert.equal(await field(page, '文本内容').inputValue(), '本地记录');
    await capture(page, 'desktop-conflict');
    await click(page, '保留我的修改并采用新版');
    assert.equal(await field(page, '角色名称').inputValue(), '新称');
    assert.equal(await field(page, '角色设定').inputValue(), '新版设定');
    await click(page, '保存设定');
    await h1(page, '新称').waitFor();
    const merged = await invoke('character.read', { characterId: saved.characterId });
    assert.equal(merged.revision, 3);
    assert.equal(merged.entries[0].entryId, saved.entries[0].entryId);
    assert.equal(merged.entries[0].blocks[0].text, '本地记录');
    await expand(page, '更多');
    await link(page, '编辑设定').click();
    await editorReady(page);
    await field(page, '角色名称').fill('本地称呼');
    await invoke('character.revise', { characterId: saved.characterId, expectedRevision: 3, persona: '第四版', entries: [] });
    let failLatest = true;
    await page.route('**/api/web/invoke', route => failLatest && route.request().postDataJSON()?.operationId === 'character.read'
      ? route.fulfill({ status: 503, json: { code: 'temporarily_unavailable' } }) : route.continue());
    await click(page, '保存设定');
    await page.getByRole('button', { name: '重新读取最新版', exact: true }).waitFor();
    failLatest = false;
    await click(page, '重新读取最新版');
    await click(page, '改用最新版');
    assert.equal(await field(page, '角色名称').inputValue(), '新称');
    assert.equal(await page.locator('.character-entry').count(), 0);
    await click(page, '保存设定');
    await h1(page, '新称').waitFor();
    assert.equal((await invoke('character.read', { characterId: saved.characterId })).revision, 4);
  });

  await t.test('lost save response resolves through the original receipt with one creation', async t => {
    const page = await open(t, origin, '/characters/new');
    await editorReady(page);
    await field(page, '角色名称').fill('回执找回的人');
    const writes = [];
    await page.route('**/api/web/invoke', async route => {
      const call = route.request().postDataJSON();
      if (call?.operationId !== 'character.create') return route.continue();
      writes.push(call);
      await route.fetch();
      await route.abort('failed');
    });
    await click(page, '创建角色');
    await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
    assert.equal(await field(page, '角色名称').isDisabled(), true);
    const receipt = page.waitForRequest(request => new URL(request.url()).pathname === '/api/web/receipt');
    await click(page, '重试保存');
    assert.equal((await receipt).postDataJSON().stepId, writes[0].stepId);
    await h1(page, '回执找回的人').waitFor();
    assert.equal(writes.length, 1);
    assert.equal((await invoke('character.list', { name: '回执找回的人' })).items.length, 1);
  });

  await t.test('an initiated save finishes after navigation without redirecting the next page', async t => {
    const page = await open(t, origin, '/characters/new');
    await editorReady(page);
    await field(page, '角色名称').fill('离开时保存的人');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    let arrived;
    const started = new Promise(resolve => { arrived = resolve; });
    await page.route('**/api/web/invoke', async route => {
      if (route.request().postDataJSON()?.operationId !== 'character.create') return route.continue();
      arrived();
      await gate;
      await route.continue();
    });
    await click(page, '创建角色');
    await started;
    await navigate(page, '/__characters_outside');
    const response = page.waitForResponse(response => response.request().postDataJSON()?.operationId === 'character.create');
    release();
    await response;
    await h1(page, '其他页面').waitFor();
    assert.equal(new URL(page.url()).pathname, '/__characters_outside');
    assert.equal((await invoke('character.list', { name: '离开时保存的人' })).items.length, 1);
  });

  await t.test('a committed save with an incomplete result also retains its receipt for retry', async t => {
    const page = await open(t, origin, '/characters/new');
    await editorReady(page);
    await field(page, '角色名称').fill('补全结果的人');
    let writeCount = 0;
    await page.route('**/api/web/invoke', async route => {
      if (route.request().postDataJSON()?.operationId !== 'character.create') return route.continue();
      writeCount++;
      await route.fetch();
      await route.fulfill({ status: 200, json: { result: {} } });
    });
    await click(page, '创建角色');
    await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
    assert.equal(await field(page, '角色名称').isDisabled(), true);
    await click(page, '重试保存');
    await h1(page, '补全结果的人').waitFor();
    assert.equal(writeCount, 1);
    assert.equal((await invoke('character.list', { name: '补全结果的人' })).items.length, 1);
  });

  await t.test('lists and editor choices include later API pages and read failures have a visible retry', async t => {
    const project = await invoke('project.create', { title: '分页名单' });
    for (let i = 0; i < 23; i++) await invoke('character.create', { name: `分页角色 ${i}`, projectId: project.projectId });
    const page = await open(t, origin, `/characters?projectId=${project.projectId}`);
    assert.equal(await page.locator('.characters-list > li').count(), 23);
    await navigate(page, '/characters/new');
    await editorReady(page);
    await click(page, '添加条目');
    await click(page, '添加资料链接');
    await field(page, '资料类型').selectOption('character');
    assert.ok(await field(page, '资料记录').locator('option').count() > 23);
    let fail = true;
    await page.route('**/api/web/invoke', route => fail && route.request().postDataJSON()?.operationId === 'character.list'
      ? route.fulfill({ status: 503, json: { code: 'unavailable' } }) : route.continue());
    await navigate(page, `/characters?projectId=${project.projectId}`);
    await page.getByRole('alert').waitFor();
    fail = false;
    await click(page, '重试');
    await ready(page);
    assert.equal(await page.locator('.characters-list > li').count(), 23);
    await assertFitsViewport(page);
  });

  await t.test('malformed and missing versions show errors and query changes reread the same component', async t => {
    const saved = await invoke('character.create', { name: '版本检查', persona: '第一版' });
    await invoke('character.revise', { characterId: saved.characterId, expectedRevision: 1, persona: '第二版' });
    const page = await open(t, origin, `${saved.href}?revision=0&edit=1`);
    await h1(page, '页面暂时无法打开').waitFor();
    await page.getByText('版本号无效，请使用正整数版本号。', { exact: true }).waitFor();
    for (const revision of ['1.5', '9007199254740992', 'no']) {
      await navigate(page, `${saved.href}?revision=${revision}`);
      await h1(page, '页面暂时无法打开').waitFor();
    }
    await navigate(page, `${saved.href}?revision=99`);
    await h1(page, '页面暂时无法打开').waitFor();
    await navigate(page, `${saved.href}?revision=1`);
    await page.getByText('第一版', { exact: true }).waitFor();
    await navigate(page, saved.href);
    await page.getByText('第二版', { exact: true }).waitFor();
    await page.goBack();
    await page.getByText('第一版', { exact: true }).waitFor();
    await navigate(page, '/characters/missing-record');
    await h1(page, '页面暂时无法打开').waitFor();
    await link(page, '返回角色').click();
    await h1(page, '角色').waitFor();
  });
});
