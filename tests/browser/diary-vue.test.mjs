import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { assertFitsViewport, openBrowser, startService } from './harness.mjs';

const root = resolve(import.meta.dirname, '../..');
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };
const first = { title: '雨停后的第一篇', body: '我把窗台擦干，听见街上的水声。\n今天开始写日记。', diaryDate: '2026-11-21' };
const revised = { title: '雨停后的第二稿', body: '天色慢慢亮了。\n我重新写下窗外的水声。', diaryDate: '2026-11-22' };
const h1 = (page, name) => page.getByRole('heading', { level: 1, name, exact: true });
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const field = (page, name) => page.getByLabel(new RegExp(`^${RegExp.escape(name)}(?: \\*)?$`));
const link = (page, name) => page.getByRole('link', { name, exact: true });

// Mount the delivered route directly so the checks do not depend on shell migration order.
async function fixture(t) {
  const backend = await startService(t);
  const cache = await mkdtemp(join(tmpdir(), 'sth-diary-vue-'));
  const entry = '/__diary_test_entry.js';
  const vite = await createServer({
    configFile: false, root, publicDir: false, cacheDir: cache, logLevel: 'error',
    resolve: { alias: { '/assets': resolve(root, 'web/assets') } },
    plugins: [vue(), {
      name: 'diary-route-test',
      resolveId(id) { if (id === entry) return '\0diary-route-test'; },
      load(id) {
        if (id !== '\0diary-route-test') return;
        return `import { createApp, defineComponent, h, shallowRef, ref } from 'vue';
          import DiaryRoute from '/frontend/diary/DiaryRoute.vue';
          const url = shallowRef(new URL(location.href));
          const refresh = ref(0);
          const navigate = href => {
            history.pushState(null, '', href);
            url.value = new URL(location.href);
            window.scrollTo(0, 0);
          };
          window.__diaryNavigate = navigate;
          window.__diaryRefresh = () => refresh.value++;
          window.addEventListener('popstate', () => { url.value = new URL(location.href); });
          createApp(defineComponent({ setup: () => () => h('div', { class: 'shell' }, [
            h('aside', { class: 'sidebar' }, [h('a', { class: 'brand' }, 'Sth'),
              h('nav', { id: 'navigation' }, ['日记', '创作', '角色', '资料', '任务'].map(text => h('span', text)))]),
            h('main', { id: 'main' }, [url.value.pathname === '/__diary_outside'
              ? h('h1', '其他页面')
              : h(DiaryRoute, { url: url.value, key: refresh.value,
                onNavigate: navigate, onRefresh: () => refresh.value++ })])
          ]) })).mount('#app');`;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.method !== 'GET' || !/^\/(?:diaries(?:\/|\?|$)|__diary_outside|\?projectId=)/.test(req.url)) return next();
          try {
            const script = new URL(req.url, 'http://localhost').searchParams.has('__diary_shell') ? '/frontend/main.ts' : entry;
            const html = await server.transformIndexHtml(req.url, `<!doctype html><html lang="zh-CN"><head>
              <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
              <link rel="stylesheet" href="/web/assets/notebook.css"><title>日记测试</title></head>
              <body><div id="app"></div><script type="module" src="${script}"></script></body></html>`);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
          } catch (error) { next(error); }
        });
      },
    }],
    server: { host: '127.0.0.1', strictPort: false, proxy: {
      '/assets': { target: backend, changeOrigin: true },
      '/api': { target: backend, changeOrigin: true,
        configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', backend)); } },
    } },
  });
  t.after(async () => {
    await vite.close();
    assert.equal(dirname(resolve(cache)), resolve(tmpdir()));
    assert.match(basename(cache), /^sth-diary-vue-[a-z0-9]+$/i);
    await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  async function invoke(operationId, input) {
    const response = await fetch(`${backend}/api/web/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, input, stepId: `diary-vue:${randomUUID()}` }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  return { origin, invoke };
}

async function open(t, origin, href = '/diaries/new', viewport = phone) {
  const page = await openBrowser(t, origin, viewport);
  assert.equal((await page.goto(href)).status(), 200);
  await page.locator('.diary-route[aria-busy="false"]').waitFor().catch(async error => {
    throw new Error(`Vue diary did not mount at ${href}. ${await page.locator('body').innerText()}`, { cause: error });
  });
  return page;
}

async function fill(page, values) {
  await field(page, '标题').fill(values.title);
  await field(page, '日期').fill(values.diaryDate);
  await field(page, '正文').fill(values.body);
}

async function expectDiary(page, values) {
  await page.waitForURL(/\/diaries\/[0-9a-f-]{36}$/i);
  await h1(page, values.title).waitFor();
  await page.getByRole('article').getByText(values.body, { exact: true }).waitFor();
  assert.equal(await page.locator('.diary-meta time').getAttribute('datetime'), values.diaryDate);
  return new URL(page.url()).pathname.split('/').at(-1);
}

async function navigate(page, href) {
  await page.evaluate(href => window.__diaryNavigate(href), href);
  if (href === '/__diary_outside') return h1(page, '其他页面').waitFor();
  await page.locator('.diary-route[aria-busy="false"]').waitFor();
}

async function reload(page) {
  const accept = dialog => dialog.accept();
  page.on('dialog', accept);
  try {
    await page.reload();
    await page.locator('.diary-route[aria-busy="false"]').waitFor();
  } finally { page.off('dialog', accept); }
}

const draftKey = href => `sth:diary:draft:v1:${href}`;
const storedDraft = (page, href) => page.evaluate(key => sessionStorage.getItem(key), draftKey(href));

async function capture(page, name) {
  const folder = process.env.STH_DIARY_VUE_ARTIFACTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`), animations: 'disabled' });
}

test('Vue diary independent routes and public API readback', { timeout: 180_000 }, async t => {
  const { origin, invoke } = await fixture(t);

  for (const [name, viewport] of [['phone', phone], ['desktop', desktop]]) {
    await t.test(`${name} personal create, revise, pinned deep link and reload`, async t => {
      const page = await open(t, origin, '/diaries/new', viewport);
      await h1(page, '写日记').waitFor();
      const localToday = await page.evaluate(() => {
        const date = new Date();
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      });
      assert.equal(await field(page, '日期').inputValue(), localToday);
      assert.equal(await field(page, '项目').inputValue(), '');
      assert.equal(await field(page, '叙述者').inputValue(), '');
      const body = await field(page, '正文').boundingBox();
      assert.ok(body.y + 100 < viewport.height, 'body is usable in the first viewport');
      await fill(page, first);
      await page.evaluate(() => window.scrollTo(0, 0));
      await capture(page, `${name}-editor`);
      await assertFitsViewport(page);
      await click(page, '保存日记');
      const noteId = await expectDiary(page, first);
      assert.deepEqual(await invoke('diary.read', { noteId }), { ...first, noteId, href: `/diaries/${noteId}`, revision: 1 });
      await link(page, '编辑').click();
      await h1(page, '编辑日记').waitFor();
      assert.equal(await field(page, '正文').inputValue(), first.body);
      await fill(page, revised);
      await click(page, '保存修改');
      assert.equal(await expectDiary(page, revised), noteId);
      assert.equal((await invoke('diary.read', { noteId })).revision, 2);
      await page.reload();
      await expectDiary(page, revised);
      await capture(page, `${name}-reading`);
      await assertFitsViewport(page);
      await navigate(page, `/diaries/${noteId}?revision=1&edit=1`);
      await h1(page, first.title).waitFor();
      assert.equal(await link(page, '编辑').count(), 0);
      assert.equal(await field(page, '正文').count(), 0);
      await page.getByRole('article').getByText(first.body, { exact: true }).waitFor();
      assert.equal(await link(page, '查看当前版本').getAttribute('href'), `/diaries/${noteId}`);
    });
  }

  for (const [name, viewport] of [['phone', phone], ['desktop', desktop]]) {
    await t.test(`${name} actual shell navigation, refresh and first viewport`, async t => {
      const page = await open(t, origin, '/diaries/new?__diary_shell=1', viewport);
      await h1(page, '写日记').waitFor();
      const body = await field(page, '正文').boundingBox();
      assert.ok(body.y + 100 < viewport.height, 'body remains usable below the actual shell');
      await fill(page, { ...first, title: 'shell 中的随记' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await capture(page, `${name}-shell-editor`);
      await assertFitsViewport(page);
      await click(page, '保存日记');
      const noteId = await expectDiary(page, { ...first, title: 'shell 中的随记' });
      assert.equal((await invoke('diary.read', { noteId })).projectId, undefined);
      await capture(page, `${name}-shell-reading`);
      await link(page, '编辑').click();
      await h1(page, '编辑日记').waitFor();
      await fill(page, revised);
      await click(page, '保存修改');
      await expectDiary(page, revised);
      await page.locator('.diary-back').click();
      await h1(page, '我的日记').waitFor();
      await assertFitsViewport(page);
    });
  }

  await t.test('draft survives navigation and remount, clear is explicit, whitespace and invalid dates cannot save', async t => {
    const page = await open(t, origin);
    await field(page, '标题').fill('尚未写完');
    await field(page, '正文').fill('留给下次接着写。');
    await navigate(page, '/__diary_outside');
    await navigate(page, '/diaries/new');
    assert.equal(await field(page, '正文').inputValue(), '留给下次接着写。');
    await page.evaluate(() => window.__diaryRefresh());
    await h1(page, '写日记').waitFor();
    assert.equal(await field(page, '标题').inputValue(), '尚未写完');
    page.once('dialog', dialog => dialog.accept());
    await click(page, '清除草稿');
    await h1(page, '写日记').waitFor();
    assert.equal(await field(page, '标题').inputValue(), '');
    await fill(page, { ...first, title: '   ' });
    await click(page, '保存日记');
    assert.equal(await field(page, '标题').evaluate(input => input.validity.customError), true);
    await field(page, '标题').fill('有效标题');
    await field(page, '日期').evaluate(input => {
      input.value = '2026-02-29';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(page, '保存日记');
    assert.match(page.url(), /\/diaries\/new$/);
    await field(page, '日期').fill('2024-02-29');
    await click(page, '保存日记');
    await expectDiary(page, { ...first, title: '有效标题', diaryDate: '2024-02-29' });
  });

  await t.test('phone reload restores text, date, context, persona version and unfinished citation fields in this tab', async t => {
    const project = await invoke('project.create', { title: '可恢复的海边手记' });
    const character = await invoke('character.create', { name: '守灯人', persona: '夜里记录潮声。', projectId: project.projectId });
    const sourceBody = '🌧️潮声在这里。明天再回来。';
    const source = await invoke('source.create', { kind: 'setting', title: '旧灯塔记录', body: sourceBody });
    const excerpt = '潮声在这里';
    const range = { start: sourceBody.indexOf(excerpt), end: sourceBody.indexOf(excerpt) + excerpt.length };
    const href = `/diaries/new?projectId=${project.projectId}`;
    const page = await open(t, origin, href);
    await page.locator('summary').filter({ hasText: /^写作上下文/ }).click();
    await field(page, '叙述者').selectOption(character.characterId);
    await page.getByText('夜里记录潮声。', { exact: true }).waitFor();
    const local = { ...first, title: '刷新后接着写', body: '第一行还没有写完。\n🌧️ 留在这一页。' };
    await fill(page, local);
    await page.locator('summary').filter({ hasText: /^资料引用/ }).click();
    await click(page, '添加资料引用');
    await field(page, '资料').selectOption(source.sourceId);
    await field(page, '引用原文').fill(excerpt);
    await page.getByRole('checkbox', { name: '限定原文位置', exact: true }).check();
    await field(page, '原文起点').fill(String(range.start));
    await field(page, '原文终点').fill(String(range.end));
    await field(page, '资料版本').fill('');
    await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '资料已经更新。' });
    await invoke('character.revise', { characterId: character.characterId, expectedRevision: 1, persona: '白天记录船只。' });

    await reload(page);
    for (const [label, value] of [['标题', local.title], ['日期', local.diaryDate], ['正文', local.body],
      ['项目', project.projectId], ['叙述者', character.characterId], ['引用原文', excerpt], ['资料版本', ''],
      ['原文起点', String(range.start)], ['原文终点', String(range.end)]]) {
      assert.equal(await field(page, label).inputValue(), value, label);
    }
    assert.equal(await page.getByRole('checkbox', { name: '限定原文位置', exact: true }).isChecked(), true);
    await page.locator('summary').filter({ hasText: /^写作上下文/ }).click();
    await page.getByText('角色设定 · 第 1 版', { exact: true }).waitFor();
    await field(page, '资料版本').fill('1');
    await assertFitsViewport(page);

    const otherTab = await page.context().newPage();
    await otherTab.goto(href);
    await h1(otherTab, '写日记').waitFor();
    assert.equal(await field(otherTab, '正文').inputValue(), '', 'a separate tab has its own draft');
    await otherTab.close();

    await click(page, '保存日记');
    await page.getByRole('region', { name: '版本冲突' }).getByText('白天记录船只。', { exact: true }).waitFor();
    await reload(page);
    await page.getByRole('region', { name: '版本冲突' }).getByText('白天记录船只。', { exact: true }).waitFor();
    assert.equal(await field(page, '正文').inputValue(), local.body);
    assert.equal(await field(page, '资料版本').inputValue(), '1');
    await click(page, '采用最新角色设定');
    await click(page, '保存日记');
    const noteId = await expectDiary(page, local);
    assert.equal(await storedDraft(page, href), null);
    const saved = await invoke('diary.read', { noteId });
    assert.equal(saved.character.revision, 2);
    assert.deepEqual(saved.sourcePins, [{ sourceId: source.sourceId, revision: 1, excerpt, range, href: source.href }]);
    await reload(page);
    await expectDiary(page, local);
    assert.equal((await invoke('diary.read', { noteId })).revision, 1);
    await navigate(page, href);
    assert.equal(await field(page, '正文').inputValue(), '');
    assert.equal(await field(page, '引用原文').count(), 0);
    assert.equal((await invoke('diary.list', { projectId: project.projectId })).items.length, 1);
  });

  await t.test('phone edit reload retains its original baseline, local citations and conflict decisions', async t => {
    const source = await invoke('source.create', { kind: 'setting', title: '续写证据', body: '开场。后来。' });
    const pin = { sourceId: source.sourceId, revision: 1, excerpt: '开场。', range: { start: 0, end: 3 } };
    const localPin = { ...pin, excerpt: '后来。', range: { start: 3, end: 6 } };
    const saved = await invoke('diary.create', { ...first, sourcePins: [pin] });
    const href = `${saved.href}?edit=1`;
    const page = await open(t, origin, href);
    const body = '手机上还没提交的补写。';
    await field(page, '正文').fill(body);
    await field(page, '引用原文').fill(localPin.excerpt);
    await field(page, '原文起点').fill('3');
    await field(page, '原文终点').fill('6');
    await invoke('diary.revise', { ...revised, noteId: saved.noteId, expectedRevision: 1 });
    await reload(page);
    assert.equal(await field(page, '标题').inputValue(), first.title);
    assert.equal(await field(page, '正文').inputValue(), body);
    assert.equal(await field(page, '引用原文').inputValue(), localPin.excerpt);
    await click(page, '保存修改');
    const conflict = page.getByRole('region', { name: '版本冲突' });
    await conflict.getByText(revised.body, { exact: true }).waitFor();
    const newest = { ...revised, title: '冲突期间又有了新版', diaryDate: '2026-11-23' };
    await invoke('diary.revise', { ...newest, noteId: saved.noteId, expectedRevision: 2 });
    await reload(page);
    await conflict.getByText(newest.title, { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存修改', exact: true }).isDisabled(), true);
    assert.equal(await field(page, '正文').inputValue(), body);
    await click(page, '保留我的修改并采用新版');
    await reload(page);
    assert.equal(await field(page, '标题').inputValue(), newest.title);
    assert.equal(await field(page, '日期').inputValue(), newest.diaryDate);
    assert.equal(await field(page, '正文').inputValue(), body);
    assert.equal(await field(page, '引用原文').inputValue(), localPin.excerpt);
    await click(page, '保存修改');
    await expectDiary(page, { ...newest, body });
    const readback = await invoke('diary.read', { noteId: saved.noteId });
    assert.equal(readback.revision, 4);
    assert.deepEqual(readback.sourcePins, [{ ...localPin, href: source.href }]);
    assert.equal(await storedDraft(page, href), null);
    await reload(page);
    await expectDiary(page, { ...newest, body });
    assert.equal((await invoke('diary.read', { noteId: saved.noteId })).revision, 4);
  });

  await t.test('explicit discard removes a restored phone draft and reload does not resurrect it', async t => {
    const page = await open(t, origin);
    await fill(page, first);
    await reload(page);
    assert.equal(await field(page, '正文').inputValue(), first.body);
    page.once('dialog', dialog => dialog.dismiss());
    await click(page, '清除草稿');
    assert.notEqual(await storedDraft(page, '/diaries/new'), null);
    page.once('dialog', dialog => dialog.accept());
    await click(page, '清除草稿');
    await h1(page, '写日记').waitFor();
    assert.equal(await storedDraft(page, '/diaries/new'), null);
    await reload(page);
    assert.equal(await field(page, '标题').inputValue(), '');
    assert.equal(await field(page, '正文').inputValue(), '');
    assert.equal(await page.getByRole('button', { name: '清除草稿', exact: true }).count(), 0);
  });

  await t.test('diary conflict merges local fields with latest title, date and sources', async t => {
    const saved = await invoke('diary.create', first);
    const source = await invoke('source.create', { kind: 'setting', title: '新版里的引用', body: '雨停了。' });
    const sourcePin = { sourceId: source.sourceId, revision: 1, excerpt: '雨停了。' };
    const page = await open(t, origin, `${saved.href}?edit=1`);
    await field(page, '正文').fill('浏览器里补写的段落。');
    const remote = await invoke('diary.revise', { ...revised, noteId: saved.noteId, expectedRevision: 1, sourcePins: [sourcePin] });
    await click(page, '保存修改');
    const conflict = page.getByRole('region', { name: '版本冲突' });
    await conflict.getByText(remote.body, { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存修改', exact: true }).isDisabled(), true);
    await click(page, '保留我的修改并采用新版');
    assert.equal(await field(page, '标题').inputValue(), revised.title);
    assert.equal(await field(page, '日期').inputValue(), revised.diaryDate);
    assert.equal(await field(page, '正文').inputValue(), '浏览器里补写的段落。');
    await click(page, '保存修改');
    await expectDiary(page, { ...revised, body: '浏览器里补写的段落。' });
    const readback = await invoke('diary.read', { noteId: saved.noteId });
    assert.equal(readback.revision, 3);
    assert.deepEqual(readback.sourcePins, [{ ...sourcePin, href: source.href }]);
  });

  await t.test('untouched forms reload current server values and dirty forms install an unload warning', async t => {
    const saved = await invoke('diary.create', first);
    const page = await open(t, origin, `${saved.href}?edit=1`);
    const warned = () => page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(await warned(), false);
    await navigate(page, '/__diary_outside');
    await invoke('diary.revise', { ...revised, noteId: saved.noteId, expectedRevision: 1 });
    await navigate(page, `${saved.href}?edit=1`);
    assert.equal(await field(page, '标题').inputValue(), revised.title);
    await field(page, '正文').fill('这次只改正文。');
    assert.equal(await warned(), true);
    await click(page, '保存修改');
    await expectDiary(page, { ...revised, body: '这次只改正文。' });
    assert.equal(await warned(), false);
    assert.equal((await invoke('diary.read', { noteId: saved.noteId })).revision, 3);
  });

  await t.test('replace draft with latest, failed conflict read can retry', async t => {
    const saved = await invoke('diary.create', first);
    const page = await open(t, origin, `${saved.href}?edit=1`);
    await fill(page, { ...first, title: '本地标题' });
    await invoke('diary.revise', { ...revised, noteId: saved.noteId, expectedRevision: 1 });
    let rejectRead = true;
    await page.route('**/api/web/invoke', async route => {
      if (rejectRead && route.request().postDataJSON()?.operationId === 'diary.read') {
        return route.fulfill({ status: 503, json: { code: 'temporarily_unavailable' } });
      }
      return route.continue();
    });
    await click(page, '保存修改');
    await page.getByRole('button', { name: '重新读取最新版', exact: true }).waitFor();
    rejectRead = false;
    await click(page, '重新读取最新版');
    await click(page, '改用最新版');
    assert.equal(await field(page, '标题').inputValue(), revised.title);
    assert.equal(await field(page, '正文').inputValue(), revised.body);
    await click(page, '保存修改');
    await expectDiary(page, revised);
    assert.equal((await invoke('diary.read', { noteId: saved.noteId })).revision, 2, 'unchanged revision is not duplicated');
  });

  await t.test('character context, stale character conflict and immutable narrator pin', async t => {
    const project = await invoke('project.create', { title: '港口记事' });
    const character = await invoke('character.create', { name: '林澈', persona: '负责夜间巡逻。', projectId: project.projectId });
    const page = await open(t, origin, `/diaries/new?characterId=${character.characterId}`);
    assert.equal(await field(page, '项目').inputValue(), project.projectId);
    assert.equal(await field(page, '叙述者').inputValue(), character.characterId);
    await fill(page, first);
    await invoke('character.revise', { characterId: character.characterId, expectedRevision: 1, persona: '记录每一盏港灯。' });
    await click(page, '保存日记');
    await page.getByText('记录每一盏港灯。', { exact: true }).waitFor();
    await click(page, '采用最新角色设定');
    assert.equal(await field(page, '正文').inputValue(), first.body);
    await click(page, '保存日记');
    const noteId = await expectDiary(page, first);
    assert.deepEqual((await invoke('diary.read', { noteId })).character, { characterId: character.characterId, name: '林澈', revision: 2 });
    await link(page, '编辑').click();
    await h1(page, '编辑日记').waitFor();
    assert.equal(await page.getByRole('combobox', { name: '叙述者', exact: true }).count(), 0);
    await page.getByText('写作上下文 · 林澈 · 港口记事', { exact: true }).click();
    assert.equal(await link(page, '查看角色证据 · 第 2 版').getAttribute('href'), `/characters/${character.characterId}?revision=2`);
  });

  await t.test('exact source deep link, source history, editing, clear pins and backlink evidence', async t => {
    const body = '🌧️北港末班渡船是晚上十点。';
    const source = await invoke('source.create', { kind: 'setting', title: '港口公告牌', body });
    const excerpt = '晚上十点';
    const range = { start: body.indexOf(excerpt), end: body.indexOf(excerpt) + excerpt.length };
    const params = new URLSearchParams({ sourceId: source.sourceId, sourceRevision: '1', start: String(range.start), end: String(range.end) });
    const page = await open(t, origin, `/diaries/new?${params}`);
    assert.equal(await field(page, '引用原文').inputValue(), excerpt);
    assert.equal(await field(page, '原文起点').inputValue(), String(range.start));
    await fill(page, first);
    await click(page, '保存日记');
    const noteId = await expectDiary(page, first);
    const expectedPin = { sourceId: source.sourceId, revision: 1, excerpt, range };
    const readback = await invoke('diary.read', { noteId });
    assert.deepEqual(readback.sourcePins[0], { ...expectedPin, href: source.href });
    const sourceHref = `/sources/${source.sourceId}?revision=1&start=${range.start}&end=${range.end}`;
    assert.equal(await link(page, '查看资料原文 · 第 1 版').getAttribute('href'), sourceHref);
    await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '北港末班渡船是晚上九点。' });
    const witness = await invoke('character.create', { name: '港口证人', entries: [{ label: '夜航记录', blocks: [{
      type: 'reference', kind: 'diary', id: noteId, revision: 1, excerpt: first.body,
    }] }] });
    await page.reload();
    await h1(page, first.title).waitFor();
    await link(page, '港口证人 · 第 1 版 · 夜航记录').waitFor();
    assert.equal(await link(page, '港口证人 · 第 1 版 · 夜航记录').getAttribute('href'), `/characters/${witness.characterId}?revision=1`);
    await link(page, '编辑').click();
    await h1(page, '编辑日记').waitFor();
    assert.equal(await field(page, '资料版本').inputValue(), '1');
    await field(page, '标题').fill('有出处的夜航');
    await click(page, '保存修改');
    await expectDiary(page, { ...first, title: '有出处的夜航' });
    assert.equal((await invoke('diary.read', { noteId })).sourcePins[0].revision, 1);
    await link(page, '编辑').click();
    await h1(page, '编辑日记').waitFor();
    await page.getByRole('button', { name: '移除资料引用 1' }).click();
    await click(page, '保存修改');
    await expectDiary(page, { ...first, title: '有出处的夜航' });
    assert.equal((await invoke('diary.read', { noteId })).sourcePins, undefined);
  });

  await t.test('project switch clears narrator and keeps shared personal characters selectable', async t => {
    const firstProject = await invoke('project.create', { title: '山间手记' });
    const secondProject = await invoke('project.create', { title: '海边手记' });
    const mountain = await invoke('character.create', { name: '山间叙述者', projectId: firstProject.projectId });
    const seaside = await invoke('character.create', { name: '海边叙述者', projectId: secondProject.projectId });
    const shared = await invoke('character.create', { name: '旅人' });
    const page = await open(t, origin, `/diaries/new?projectId=${firstProject.projectId}`);
    await page.getByText('写作上下文 · 个人日记 · 山间手记', { exact: true }).click();
    await field(page, '叙述者').selectOption(mountain.characterId);
    await page.getByText('角色设定 · 第 1 版', { exact: true }).waitFor();
    await field(page, '项目').selectOption(secondProject.projectId);
    assert.equal(await field(page, '叙述者').inputValue(), '');
    const choices = await field(page, '叙述者').locator('option').evaluateAll(options => options.map(option => option.value));
    assert.equal(choices.includes(mountain.characterId), false);
    assert.equal(choices.includes(seaside.characterId), true);
    assert.equal(choices.includes(shared.characterId), true);
    await field(page, '叙述者').selectOption(shared.characterId);
    await page.getByText('角色设定 · 第 1 版', { exact: true }).waitFor();
    await fill(page, first);
    await click(page, '保存日记');
    const noteId = await expectDiary(page, first);
    const readback = await invoke('diary.read', { noteId });
    assert.equal(readback.projectId, secondProject.projectId);
    assert.equal(readback.character.characterId, shared.characterId);
  });

  await t.test('manual source citation uses selected revision and exact excerpt', async t => {
    const source = await invoke('source.create', { kind: 'setting', title: '手动引用的公告', body: '今天的潮汐在下午三点到来。' });
    const page = await open(t, origin);
    await page.getByText('资料引用', { exact: true }).click();
    await click(page, '添加资料引用');
    await field(page, '资料').selectOption(source.sourceId);
    await field(page, '引用原文').fill('下午三点');
    await fill(page, { ...first, title: '手动补充来源' });
    await click(page, '保存日记');
    const noteId = await expectDiary(page, { ...first, title: '手动补充来源' });
    assert.deepEqual((await invoke('diary.read', { noteId })).sourcePins, [{
      sourceId: source.sourceId, revision: 1, excerpt: '下午三点', href: source.href,
    }]);
  });

  await t.test('uncertain committed write retries its receipt after leaving, remounting and phone reload', async t => {
    const page = await open(t, origin);
    await fill(page, { ...first, title: '回执读回' });
    const attempts = [];
    let loseReply = true;
    await page.route('**/api/web/invoke', async route => {
      const call = route.request().postDataJSON();
      if (call.operationId !== 'diary.create') return route.continue();
      attempts.push(call);
      if (!loseReply) return route.continue();
      loseReply = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      return route.abort('failed');
    });
    await click(page, '保存日记');
    await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
    assert.equal(await field(page, '正文').isDisabled(), true);
    await navigate(page, '/__diary_outside');
    await navigate(page, '/diaries/new');
    await reload(page);
    assert.equal(await field(page, '正文').inputValue(), first.body);
    assert.equal(await field(page, '正文').isDisabled(), true);
    const receipt = page.waitForRequest('**/api/web/receipt');
    await click(page, '重试保存');
    const call = (await receipt).postDataJSON();
    assert.deepEqual(call, { operationId: attempts[0].operationId, stepId: attempts[0].stepId });
    const noteId = await expectDiary(page, { ...first, title: '回执读回' });
    assert.equal(attempts.length, 1, 'receipt recovery does not create a second diary');
    assert.equal((await invoke('diary.read', { noteId })).revision, 1);
    assert.equal(await storedDraft(page, '/diaries/new'), null);
    await navigate(page, '/diaries/new');
    assert.equal(await field(page, '正文').inputValue(), '');
  });

  await t.test('receipt missing after phone reload replays identical step and input', async t => {
    const page = await open(t, origin);
    await fill(page, { ...first, title: '同一步骤重试' });
    const calls = [];
    await page.route('**/api/web/invoke', route => {
      const call = route.request().postDataJSON();
      if (call.operationId !== 'diary.create') return route.continue();
      calls.push(call);
      return calls.length === 1 ? route.abort('failed') : route.continue();
    });
    await click(page, '保存日记');
    await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
    await reload(page);
    assert.equal(await field(page, '正文').isDisabled(), true);
    await click(page, '重试保存');
    await expectDiary(page, { ...first, title: '同一步骤重试' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  });

  await t.test('phone reload during an in-flight write recovers its pre-dispatch receipt without a second create', { timeout: 15_000 }, async t => {
    const project = await invoke('project.create', { title: '刷新中保存' });
    const href = `/diaries/new?projectId=${project.projectId}`;
    const page = await open(t, origin, href);
    const local = { ...first, title: '保存时意外刷新' };
    await fill(page, local);
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { started = resolve; });
    t.after(() => release());
    const calls = [];
    await page.route('**/api/web/invoke', async route => {
      const call = route.request().postDataJSON();
      if (call.operationId !== 'diary.create') return route.continue();
      calls.push(call);
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    const request = page.waitForRequest(request => request.url().endsWith('/api/web/invoke') && request.postDataJSON()?.operationId === 'diary.create');
    await click(page, '保存日记');
    await request;
    await pending;
    assert.deepEqual(JSON.parse(await storedDraft(page, href)).call, calls[0]);
    await reload(page);
    assert.equal(await field(page, '正文').inputValue(), local.body);
    assert.equal(await field(page, '正文').isDisabled(), true);
    const receipt = page.waitForRequest('**/api/web/receipt');
    await click(page, '重试保存');
    assert.deepEqual((await receipt).postDataJSON(), { operationId: calls[0].operationId, stepId: calls[0].stepId });
    const noteId = await expectDiary(page, local);
    release();
    assert.equal(await storedDraft(page, href), null);
    assert.equal(calls.length, 1);
    assert.equal((await invoke('diary.read', { noteId })).revision, 1);
    assert.equal((await invoke('diary.list', { projectId: project.projectId })).items.length, 1);
    await navigate(page, href);
    await reload(page);
    assert.equal(await field(page, '正文').inputValue(), '');
  });

  await t.test('phone reload of an uncertain revision keeps the original request despite reading the saved server version', async t => {
    const saved = await invoke('diary.create', first);
    const href = `${saved.href}?edit=1`;
    const page = await open(t, origin, href);
    await fill(page, revised);
    const calls = [];
    await page.route('**/api/web/invoke', async route => {
      const call = route.request().postDataJSON();
      if (call.operationId !== 'diary.revise') return route.continue();
      calls.push(call);
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      return route.abort('failed');
    });
    await click(page, '保存修改');
    await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
    await reload(page);
    const restored = JSON.parse(await storedDraft(page, href));
    assert.equal(restored.record.revision, 1);
    assert.deepEqual(restored.call, calls[0]);
    assert.equal(await field(page, '正文').isDisabled(), true);
    const receipt = page.waitForRequest('**/api/web/receipt');
    await click(page, '重试保存');
    assert.equal((await receipt).postDataJSON().stepId, calls[0].stepId);
    await expectDiary(page, revised);
    assert.equal(calls.length, 1);
    assert.equal((await invoke('diary.read', { noteId: saved.noteId })).revision, 2);
    assert.equal(await storedDraft(page, href), null);
    await navigate(page, href);
    await reload(page);
    assert.equal(await field(page, '正文').inputValue(), revised.body);
    assert.equal(await page.getByRole('button', { name: '清除草稿', exact: true }).count(), 0);
  });

  for (const outcome of ['success', 'uncertain']) {
    await t.test(`an older module copy's ${outcome} response cannot overwrite or clear a newer phone draft`, { timeout: 15_000 }, async t => {
      const page = await open(t, origin);
      await fill(page, { ...first, title: `旧副本 ${outcome}` });
      await page.evaluate(async key => {
        const store = await import('/frontend/diary/drafts.ts');
        const { initial } = JSON.parse(sessionStorage.getItem(key));
        window.__olderDiaryDraft = store.getDraft('/diaries/new', initial);
      }, draftKey('/diaries/new'));
      let release;
      let started;
      const gate = new Promise(resolve => { release = resolve; });
      const pending = new Promise(resolve => { started = resolve; });
      t.after(() => release());
      await page.route('**/api/web/invoke', async route => {
        if (route.request().postDataJSON().operationId !== 'diary.create') return route.continue();
        const response = await route.fetch();
        started();
        await gate;
        if (outcome === 'uncertain') return route.fulfill({ status: 503, json: { code: 'temporarily_unavailable' } }).catch(() => {});
        return route.fulfill({ response }).catch(() => {});
      });
      const request = page.waitForRequest(request => request.url().endsWith('/api/web/invoke') && request.postDataJSON()?.operationId === 'diary.create');
      await click(page, '保存日记');
      await request;
      await pending;
      await navigate(page, '/__diary_outside');
      const newer = { ...revised, title: `新副本 ${outcome}` };
      const snapshot = await page.evaluate(async ({ key, newer }) => {
        // A separately loaded domain instance recovers the same receipt and starts a new draft.
        const store = await import('/frontend/diary/drafts.ts?newer-copy');
        const api = await import('/frontend/diary/api.ts');
        const { initial } = JSON.parse(sessionStorage.getItem(key));
        const recovered = store.getDraft('/diaries/new', initial);
        const saved = await api.retryWrite(recovered.call);
        if (!saved.noteId || !store.forgetDraft('/diaries/new', recovered)) throw new Error('newer copy did not recover the save');
        const draft = store.getDraft('/diaries/new', initial);
        Object.assign(draft.values, newer);
        return sessionStorage.getItem(key);
      }, { key: draftKey('/diaries/new'), newer });
      release();
      await page.waitForFunction(() => window.__olderDiaryDraft.busy === false);
      assert.match(page.url(), /\/__diary_outside$/);
      assert.equal(await storedDraft(page, '/diaries/new'), snapshot, 'late completion leaves the newer snapshot intact');
      await navigate(page, '/diaries/new');
      await reload(page);
      assert.equal(await field(page, '标题').inputValue(), newer.title);
      assert.equal(await field(page, '正文').inputValue(), newer.body);
      assert.equal(await field(page, '正文').isDisabled(), false);
    });
  }

  for (const mode of ['disabled', 'full']) {
    await t.test(`${mode} session storage preserves editing, in-memory remounts, discard and saving`, async t => {
      const page = await open(t, origin);
      await page.evaluate(mode => {
        if (mode === 'disabled') Object.defineProperty(window, 'sessionStorage', {
          get() { throw new DOMException('Storage is disabled', 'SecurityError'); },
        });
        else Storage.prototype.setItem = () => { throw new DOMException('Storage is full', 'QuotaExceededError'); };
      }, mode);
      const local = { ...first, title: `存储不可用 ${mode}` };
      await fill(page, local);
      await navigate(page, '/__diary_outside');
      await navigate(page, '/diaries/new');
      assert.equal(await field(page, '正文').inputValue(), local.body);
      page.once('dialog', dialog => dialog.accept());
      await click(page, '清除草稿');
      await h1(page, '写日记').waitFor();
      assert.equal(await field(page, '正文').inputValue(), '');
      await fill(page, local);
      await click(page, '保存日记');
      const noteId = await expectDiary(page, local);
      assert.equal((await invoke('diary.read', { noteId })).revision, 1);
      await navigate(page, '/diaries/new');
      assert.equal(await field(page, '正文').inputValue(), '');
    });
  }

  await t.test('malformed session snapshots do not block a fresh phone editor', async t => {
    const page = await open(t, origin);
    for (const snapshot of ['{broken', JSON.stringify({ values: { body: 'partial' } })]) {
      await page.evaluate(({ key, snapshot }) => sessionStorage.setItem(key, snapshot), { key: draftKey('/diaries/new'), snapshot });
      await reload(page);
      assert.equal(await field(page, '标题').inputValue(), '');
      assert.equal(await field(page, '正文').inputValue(), '');
      assert.equal(await storedDraft(page, '/diaries/new'), null);
    }
    await fill(page, { ...first, title: '损坏草稿后仍可写' });
    await click(page, '保存日记');
    await expectDiary(page, { ...first, title: '损坏草稿后仍可写' });
  });

  await t.test('save completes while off route and read cancellation cannot redirect another page', async t => {
    const page = await open(t, origin);
    await fill(page, { ...first, title: '离开后仍保存' });
    let release;
    let started;
    const pending = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/web/invoke', async route => {
      if (route.request().postDataJSON()?.operationId !== 'diary.create') return route.continue();
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    });
    await click(page, '保存日记');
    await pending;
    await navigate(page, '/__diary_outside');
    const completed = page.waitForResponse(response => response.url().endsWith('/api/web/invoke') && response.request().postDataJSON()?.operationId === 'diary.create');
    release();
    await h1(page, '其他页面').waitFor();
    await completed;
    assert.match(page.url(), /\/__diary_outside$/);
    const { items } = await invoke('diary.list', { limit: 50 });
    assert.equal(items.filter(item => item.title === '离开后仍保存').length, 1);
  });

  await t.test('outdated read cannot replace the next diary on a reused component', async t => {
    const slow = await invoke('diary.create', { ...first, title: '较慢的日记' });
    const next = await invoke('diary.create', { ...revised, title: '后来打开的日记' });
    const page = await open(t, origin, next.href);
    let release;
    let started;
    let finished;
    const pending = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const completed = new Promise(resolve => { finished = resolve; });
    await page.route('**/api/web/invoke', async route => {
      const input = route.request().postDataJSON();
      if (input.operationId !== 'diary.read' || input.input.noteId !== slow.noteId) return route.continue();
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response }).catch(() => {});
      finished();
    });
    await page.evaluate(href => window.__diaryNavigate(href), slow.href);
    await pending;
    await navigate(page, next.href);
    release();
    await completed;
    await h1(page, next.title).waitFor();
    assert.equal(await h1(page, slow.title).count(), 0);
    assert.equal(new URL(page.url()).pathname, next.href);
  });

  await t.test('old list and project links, pagination, invalid versions, missing records and escaped text', async t => {
    const project = await invoke('project.create', { title: '分页测试作品' });
    for (let index = 0; index < 21; index++) await invoke('diary.create', { ...first, projectId: project.projectId, title: `分页日记 ${index}` });
    const page = await open(t, origin, `/?projectId=${project.projectId}`);
    await h1(page, '我的日记').waitFor();
    assert.equal(await page.locator('.diary-row').count(), 20);
    assert.equal(await link(page, '写日记').getAttribute('href'), `/diaries/new?projectId=${project.projectId}`);
    await click(page, '加载更多');
    await page.getByText('21 篇日记', { exact: true }).waitFor();
    assert.equal(await page.locator('.diary-row').count(), 21);
    await assertFitsViewport(page);
    await navigate(page, '/diaries');
    await h1(page, '我的日记').waitFor();
    const malicious = await invoke('diary.create', { ...first, title: '<img src=x onerror=alert(1)>', body: '<script>window.diaryInjected=true</script>\n保留为原文。' });
    await navigate(page, malicious.href);
    await h1(page, malicious.title).waitFor();
    assert.equal(await page.locator('.diary-entry script,.diary-heading img').count(), 0);
    assert.equal(await page.evaluate(() => window.diaryInjected), undefined);
    for (const revision of ['0', '-1', '01', '1.2', '9007199254740992', '']) {
      await navigate(page, `${malicious.href}?revision=${revision}`);
      await page.getByRole('alert').getByText('版本号无效，请使用正整数版本号。', { exact: true }).waitFor();
    }
    await navigate(page, '/diaries/missing');
    await page.getByRole('alert').getByText('找不到这条记录。', { exact: true }).waitFor();
  });
});
