import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';
import { matchWritingRoute, writingRoute } from '../writing/routes.ts';
import { compareLines } from '../writing/diff.ts';

const root = resolve(import.meta.dirname, '../..');
const desktop = { width: 1280, height: 900 };
const phone = { width: 390, height: 844 };
const compact = { width: 320, height: 800 };
const h1 = (page, title) => page.getByRole('heading', { level: 1, name: title, exact: true });
const field = (page, name) => page.getByLabel(new RegExp(`^${RegExp.escape(name)}(?: \\*)?$`));
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const link = (page, name) => page.getByRole('link', { name, exact: true });
const idAt = page => new URL(page.url()).pathname.split('/').at(-1);

async function toolLink(page, name) {
  const tools = page.getByRole('navigation', { name: '读写工具', exact: true });
  await tools.getByRole('button', { name: '更多', exact: true }).click();
  await tools.getByRole('link', { name, exact: true }).click();
}

test('writing matcher preserves unimplemented operations and complete legacy addresses', () => {
  const matches = path => matchWritingRoute(new URL(path, 'http://sth.test'));
  for (const path of ['/scenes/id', '/scenes/id/', '/scenes/id?revision=3', '/scenes/id?action=compare&left=a@1&right=b@2',
    '/scenes/id?action=branch&revision=1&draftId=a&draftRevision=2', '/drafts/new?sceneId=x&revision=3',
    '/drafts/id?revision=1&start=3&end=8', '/drafts/id?action=revise', '/drafts/id?action=adopt&revision=2']) assert.equal(matches(path), true, path);
  for (const path of ['/scenes', '/scenes/new', '/scenes/id/unknown', '/scenes/id?action=revise', '/scenes/id?action=adopt',
    '/scenes/id?narrativeId=n&narrativeRevision=1', '/drafts', '/drafts/id?action=adopt-entry&revision=1&start=2&end=3',
    '/drafts/id?action=unknown', '/drafts/new?action=revise', '/scenes/id?action=compare&action=branch',
    '/scenes//', '/scenes/%ZZ', '/scenes/%2f', '/scenes/%5c', '/scenes/%00', `/drafts/${'a'.repeat(129)}`,
    '/events/new', '/narratives/n?action=branch', '/branches/b?action=checkpoint']) assert.equal(matches(path), false, path);
  assert.deepEqual(writingRoute(new URL('http://sth.test/drafts/a?action=adopt')), { kind: 'draft', id: 'a', page: 'adopt' });
});

test('paragraph comparison retains every line and bounds long manuscript work', () => {
  const diff = compareLines('开头\n旧段落\n结尾', '开头\n新段落\n结尾');
  assert.deepEqual(diff.left.map(line => line.changed), [false, true, false]);
  assert.deepEqual(diff.right.map(line => line.changed), [false, true, false]);
  for (const [a, b] of [['', ''], ['一\n\n二\n', '一\n二\n'], ['相同', '相同'], ['a\n'.repeat(5000), 'b\n'.repeat(5000)]]) {
    const compared = compareLines(a, b);
    assert.equal(compared.left.map(line => line.text).join('\n'), a);
    assert.equal(compared.right.map(line => line.text).join('\n'), b);
  }
});

// The real App shell runs against an isolated backend. Until the shell owner
// registers this domain, inject only its registry entry in Vite's in-memory
// transform. No shared source or frontend/dist file is written by this suite.
async function fixture(t) {
  const backend = await startService(t);
  const directory = await mkdtemp(join(tmpdir(), 'sth-writing-vue-'));
  let vite;
  const web = createServer();
  t.after(async () => {
    web?.closeAllConnections();
    if (web) await new Promise(done => web.close(done));
    await vite?.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.match(basename(directory), /^sth-writing-vue-[a-z0-9]+$/i);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  vite = await createViteServer({
    configFile: false, root, publicDir: false, cacheDir: join(directory, 'vite-cache'), logLevel: 'error',
    resolve: { alias: { '/assets': resolve(root, 'web/assets') } },
    plugins: [{
      name: 'writing-test-register-domain', enforce: 'pre',
      transform(code, id) {
        if (id.replaceAll('\\', '/') !== `${root.replaceAll('\\', '/')}/frontend/routes.ts`) return;
        if (code.includes("module: './writing/WritingRoute.vue'")) return;
        return `import { matchWritingRoute as __writingTestMatch } from './writing/routes.ts';\n` + code
          .replace('export const domainRoutes:', `components['./writing/WritingRoute.vue'] = () => import('./writing/WritingRoute.vue');\nexport const domainRoutes:`)
          .replace(/(export const domainRoutes[^=]*=\s*\[)/, `$1\n  { id: 'writing-vue-test', paths: [], match: __writingTestMatch, navigation: '/create', module: './writing/WritingRoute.vue' },`);
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.headers.accept?.includes('text/html')) return next();
          try {
            const html = await server.transformIndexHtml(request.url, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/web/assets/notebook.css"><title>Sth 写作验收</title></head><body><div id="app"></div><script type="module" src="/frontend/main.ts"></script></body></html>`);
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
    const response = await fetch(`${backend}/api/web/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, input, stepId: `writing-test:${randomUUID()}` }) });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  return { origin, invoke };
}
async function open(t, origin, path, viewport = phone) {
  const page = await openBrowser(t, origin, viewport);
  await goto(page, path);
  return page;
}
async function goto(page, path, title) {
  assert.equal((await page.goto(path)).status(), 200);
  if (title) await expectHeading(page, title);
}
async function expectHeading(page, title) {
  await h1(page, title).waitFor().catch(async error => { throw new Error(`Expected ${title} at ${page.url()}\n${await page.locator('main').innerText()}`, { cause: error }); });
}
async function capture(page, name) {
  const directory = process.env.STH_WRITING_ARTIFACTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true, animations: 'disabled' });
}
async function candidate(page, title, body) {
  await toolLink(page, '新建候选稿');
  await expectHeading(page, '新建候选稿');
  await field(page, '标题').fill(title);
  await field(page, '正文').fill(body);
  await click(page, '新建候选稿');
  await expectHeading(page, title);
  assert.equal(await page.locator('.writing-route').count(), 1);
  return idAt(page);
}

test('contextual scene creation preserves work and chapter placement', { timeout: 90_000 }, async t => {
  const { origin, invoke } = await fixture(t);
  const viewport = { width: 768, height: 1024 };

  await t.test('chapter creation retains the saved scene and retries a concurrent arrangement safely', async t => {
    const project = await invoke('project.create', { title: '章节内新建验收' });
    const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '已有章节' });
    const existing = await invoke('scene.create', { title: '原有的一幕' });
    await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [existing.sceneId] });
    const source = `/projects/${project.projectId}?chapterId=${chapter.chapterId}`;
    const page = await open(t, origin, source, viewport);
    const create = page.locator('.library-sheets-footer').getByRole('link', { name: '新建场景', exact: true });
    await create.waitFor();
    const address = new URL(await create.getAttribute('href'), origin);
    assert.equal(address.searchParams.get('chapterId'), chapter.chapterId);
    let creations = 0;
    page.on('request', request => {
      if (request.url().endsWith('/api/web/invoke') && request.postDataJSON()?.operationId === 'scene.create') creations++;
    });
    await create.click();
    await expectHeading(page, '新建场景');
    await page.getByText('章节内新建验收 · 已有章节 · 保存后归入本章', { exact: true }).waitFor();
    assert.equal(await field(page, 'IF 分支').count(), 0);
    const concurrent = await invoke('scene.create', { title: '另一位作者刚编入的一幕' });
    const arrangeCalls = [];
    await page.route('**/api/web/invoke', async route => {
      const call = route.request().postDataJSON();
      if (call.operationId === 'chapter.arrange') {
        arrangeCalls.push(call);
        if (arrangeCalls.length === 1) {
          await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 2, sceneIds: [concurrent.sceneId, existing.sceneId] });
        }
      }
      await route.continue();
    });
    await field(page, '标题').fill('本章新增的一幕');
    await click(page, '新建场景');
    await page.getByRole('alert').filter({ hasText: '章节顺序已有更新' }).waitFor();
    const created = (await invoke('scene.list', { title: '本章新增的一幕' })).items[0];
    assert.ok(created);
    assert.deepEqual(arrangeCalls[0].input.sceneIds, [existing.sceneId, created.sceneId]);
    assert.deepEqual((await invoke('chapter.read', { chapterId: chapter.chapterId })).scenes.map(scene => scene.sceneId), [concurrent.sceneId, existing.sceneId]);
    assert.equal((await invoke('scene.read', { sceneId: created.sceneId })).placement, undefined);
    await link(page, '查看已保存场景').waitFor();
    await capture(page, 'placement-tablet-conflict');
    await page.reload();
    await click(page, '重新读取最新章节');
    await page.getByRole('heading', { name: '已有章节 · 当前章序' }).waitFor();
    assert.deepEqual(await page.getByRole('region', { name: '场景创建进度' }).getByRole('listitem').allTextContents(), [concurrent.title, existing.title]);
    assert.equal(arrangeCalls.length, 1, 'reading the updated order must wait for the author to apply it');
    await click(page, '归入本章并开始写作');
    await page.waitForURL(url => url.pathname === '/drafts/new' && url.searchParams.get('sceneId') === created.sceneId);
    await expectHeading(page, '新建候选稿');
    const returnTo = new URL(new URL(page.url()).searchParams.get('returnTo'), origin);
    assert.equal(returnTo.pathname, `/projects/${project.projectId}`);
    assert.equal(returnTo.searchParams.get('chapterId'), chapter.chapterId);
    assert.equal(returnTo.searchParams.get('selected'), created.sceneId);
    assert.notEqual(arrangeCalls[1].stepId, arrangeCalls[0].stepId);
    assert.equal(arrangeCalls[1].input.expectedRevision, 3);
    assert.deepEqual((await invoke('chapter.read', { chapterId: chapter.chapterId })).scenes.map(scene => scene.sceneId), [concurrent.sceneId, existing.sceneId, created.sceneId]);
    assert.equal((await invoke('scene.read', { sceneId: created.sceneId })).placement.projectId, project.projectId);
    assert.equal(creations, 1, 'arrangement retries never create another scene');
    await assertFitsViewport(page);
    await capture(page, 'placement-tablet-returned');
  });

  await t.test('an empty work explains chapter creation and finishes in the same work', async t => {
    const project = await invoke('project.create', { title: '空书新建验收' });
    const page = await open(t, origin, `/projects/${project.projectId}`, viewport);
    await page.locator('.library-empty').getByRole('link', { name: '新建场景', exact: true }).click();
    await expectHeading(page, '新建场景');
    await page.getByText('空书新建验收 · 下一步选择或新建章节', { exact: true }).waitFor();
    assert.equal(await field(page, 'IF 分支').count(), 0);
    await field(page, '标题').fill('空书的第一幕');
    await click(page, '新建场景');
    await expectHeading(page, '选择章节');
    await page.getByRole('status').filter({ hasText: '本书还没有章节，请先新建章节' }).waitFor();
    const created = (await invoke('scene.list', { title: '空书的第一幕' })).items[0];
    assert.deepEqual((await invoke('scene.list', { projectId: project.projectId })).items, []);
    await capture(page, 'placement-empty-work-next-step');
    await link(page, '新建章节').click();
    await expectHeading(page, '新建章节');
    await field(page, '标题').fill('从第一章开始');
    await click(page, '新建章节');
    await page.waitForURL(url => url.pathname === '/drafts/new' && url.searchParams.get('sceneId') === created.sceneId);
    await expectHeading(page, '新建候选稿');
    const placed = (await invoke('scene.read', { sceneId: created.sceneId })).placement;
    assert.equal(placed.projectId, project.projectId);
    const chapter = await invoke('chapter.read', { chapterId: placed.chapterId });
    assert.equal(chapter.title, '从第一章开始');
    assert.deepEqual(chapter.scenes.map(scene => scene.sceneId), [created.sceneId]);
    await capture(page, 'placement-empty-work-returned');

    await goto(page, `/projects/${project.projectId}?view=overview`);
    const overviewCreate = page.locator('.ce-book-footer').getByRole('link', { name: '新建场景', exact: true });
    await overviewCreate.waitFor();
    const address = new URL(await overviewCreate.getAttribute('href'), origin);
    assert.equal(address.searchParams.get('projectId'), project.projectId);
    assert.equal(address.searchParams.get('returnTo'), `/projects/${project.projectId}?view=overview`);
  });

  await t.test('the work overview selects a chapter and returns to the same overview on a phone', async t => {
    const project = await invoke('project.create', { title: '作品总览新建验收' });
    const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '总览中的一章' });
    const source = `/projects/${project.projectId}?view=overview`;
    const page = await open(t, origin, source, phone);
    await page.getByRole('region', { name: '开始写作品', exact: true }).getByRole('link', { name: '新建场景', exact: true }).click();
    await expectHeading(page, '新建场景');
    await field(page, '标题').fill('总览里新建的一幕');
    await click(page, '新建场景');
    await expectHeading(page, '选择章节');
    const created = (await invoke('scene.list', { title: '总览里新建的一幕' })).items[0];
    assert.equal(created.placement, undefined);
    await click(page, '放入「总览中的一章」');
    await page.waitForURL(url => url.pathname === '/drafts/new' && url.searchParams.get('sceneId') === created.sceneId);
    await expectHeading(page, '新建候选稿');
    assert.equal(new URL(page.url()).searchParams.get('returnTo'), source);
    await goto(page, source);
    await page.locator('.ce-book').getByRole('link', { name: created.title, exact: true }).waitFor();
    assert.equal((await invoke('scene.read', { sceneId: created.sceneId })).placement.chapterId, chapter.chapterId);
    await assertFitsViewport(page);
    await capture(page, 'placement-phone-overview-returned');
  });

  await t.test('creation without work context keeps its existing independent-scene flow', async t => {
    const page = await open(t, origin, '/scenes/new', phone);
    await expectHeading(page, '新建场景');
    assert.ok(await field(page, 'IF 分支').isVisible());
    await field(page, '标题').fill('保持独立创建');
    await click(page, '新建场景');
    await expectHeading(page, '保持独立创建');
    assert.equal(new URL(page.url()).search, '');
    assert.equal((await invoke('scene.read', { sceneId: idAt(page) })).placement, undefined);
  });
});

test('Vue long-form writing in the normal shell', { timeout: 180_000 }, async t => {
  const { origin, invoke } = await fixture(t);
  for (const [name, viewport] of [['desktop', desktop], ['phone', phone]]) {
    await t.test(`${name} exact candidate selection, pinned sources, chapter arrangement and IF`, async t => {
      const project = await invoke('project.create', { title: `${name} 港口手记` });
      const source = await invoke('source.create', { title: '港口公告', kind: 'setting', body: '末班渡船在十点离岸。' });
      const character = await invoke('character.create', { name: `${name} 林澈`, persona: '负责巡夜。' });
      const scene = await invoke('scene.create', { title: `${name} 北港夜航`, place: '北港', time: '十点',
        characters: [{ characterId: character.characterId, revision: 1 }],
        sources: [{ sourceId: source.sourceId, revision: 1, excerpt: '十点', range: { start: 5, end: 7 } }] });
      const page = await open(t, origin, `/scenes/${scene.sceneId}`, viewport);
      await expectHeading(page, scene.title);
      assert.equal(await page.locator('.writing-route').count(), 1);
      const left = await candidate(page, '远景', '风吹过百盏港灯。\n她在岸上停步。');
      await toolLink(page, `返回${scene.title}`);
      const right = await candidate(page, '近景', '风吹过百盏港灯。\n船票在她手里打湿了。');
      await toolLink(page, `返回${scene.title}`);
      await toolLink(page, '对照候选稿');
      await expectHeading(page, '对照候选稿');
      assert.equal(await page.getByRole('combobox', { name: '左稿', exact: true }).inputValue(), `${left}@1`);
      assert.equal(await page.getByRole('combobox', { name: '右稿', exact: true }).inputValue(), `${right}@1`);
      assert.equal(await page.getByRole('article', { name: '左稿', exact: true }).locator('del').innerText(), '她在岸上停步。');
      if (viewport.width <= 768) await click(page, '右稿');
      assert.equal(await page.getByRole('article', { name: '右稿', exact: true }).locator('ins').innerText(), '船票在她手里打湿了。');
      assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted, undefined);
      await assertFitsViewport(page);
      await capture(page, `${name}-comparison`);
      await invoke('draft.revise', { draftId: right, expectedRevision: 1, body: '随后修订的文字。' });
      await page.getByRole('article', { name: '右稿', exact: true }).locator('summary').filter({ hasText: /^采用与 IF$/ }).click();
      await link(page, '采纳右稿').click();
      await expectHeading(page, '采纳候选稿');
      await page.getByRole('region', { name: '即将采用的稿件' }).getByText('风吹过百盏港灯。\n船票在她手里打湿了。', { exact: true }).waitFor();
      await click(page, '采纳候选稿');
      await expectHeading(page, scene.title);
      const adopted = await invoke('scene.read', { sceneId: scene.sceneId });
      assert.equal(adopted.adopted.draftId, right);
      assert.equal(adopted.adopted.revision, 1);
      assert.equal(adopted.revision, 2);
      await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '末班渡船在九点离岸。' });
      await invoke('character.revise', { characterId: character.characterId, expectedRevision: 1, persona: '已离开港口。' });
      await page.reload();
      await expectHeading(page, scene.title);
      await page.locator('summary').filter({ hasText: /^场景上下文与角色证据$/ }).click();
      assert.equal(await link(page, '查看资料原文 · 第 1 版').getAttribute('href'), `/sources/${source.sourceId}?revision=1&start=5&end=7`);
      await page.locator('summary').filter({ hasText: `${character.name} · 第 1 版` }).click();
      await page.getByRole('region', { name: '场景上下文', exact: true }).getByText('负责巡夜。', { exact: true }).waitFor();
      await assertFitsViewport(page);
      await capture(page, `${name}-scene`);

      // The pre-existing chapter editor and its work placement remain reachable.
      await goto(page, '/chapters', '章节');
      await link(page, '新建章节').click();
      await field(page, '项目').selectOption(project.projectId);
      await field(page, '标题').fill('第一章');
      await click(page, '新建章节');
      await expectHeading(page, '第一章');
      const chapterId = idAt(page);
      await link(page, '编排章节').click();
      await click(page, '添加场景');
      await field(page, '场景').selectOption(scene.sceneId);
      await click(page, '编排章节');
      await expectHeading(page, '第一章');
      assert.equal((await invoke('chapter.read', { chapterId })).scenes[0].adopted.draftId, right);
      await goto(page, `/scenes/${scene.sceneId}?revision=2`, scene.title);
      await click(page, '更多');
      assert.equal(await link(page, '返回作品').getAttribute('href'), `/projects/${project.projectId}`);
      await page.keyboard.press('Escape');
      await page.locator('summary').filter({ hasText: /^候选稿与场景操作$/ }).click();
      assert.equal(await link(page.getByRole('navigation', { name: '构图操作', exact: true }), '创作决定').getAttribute('href'), `/author-context?projectId=${project.projectId}`);
      await toolLink(page, '建立 IF 分支');
      await expectHeading(page, '建立 IF 分支');
      await field(page, '分歧点').fill('她没有上船。');
      await field(page, '标题').fill(`${name} 错过末班船`);
      await page.getByLabel('分支名称（选填）', { exact: true }).fill(`${name} 岸上路线`);
      await click(page, '建立 IF 分支');
      await expectHeading(page, `${name} 错过末班船`);
      const branch = await invoke('scene.read', { sceneId: idAt(page) });
      assert.deepEqual(branch.branchFrom, { sceneId: scene.sceneId, revision: 2, divergence: '她没有上船。', draft: { draftId: right, revision: 1 } });
      assert.equal(branch.adopted, undefined);
      assert.equal((await invoke('branch.read', { branchId: branch.sceneId })).name, `${name} 岸上路线`);
      assert.deepEqual((await invoke('draft.list', { sceneId: branch.sceneId })).items, []);
      assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.draftId, right);
      await page.locator('summary').filter({ hasText: /^候选稿与场景操作$/ }).click();
      await link(page, '查看 IF 接续').click();
      await expectHeading(page, `${name} 岸上路线`);
      assert.equal(await link(page, '新建接续场景').count(), 1);
      assert.ok(left);
    });
  }

  await t.test('same-candidate versions, literal text and exact repeated UTF-16 evidence survive fallback', async t => {
    const scene = await invoke('scene.create', { title: '逐版本核对' });
    const body = '🙂他说：等一下。\n他又说：等一下。<script>danger</script>';
    const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '两次喊话', body });
    await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: '最新喊话。' });
    const page = await open(t, origin, `/scenes/${scene.sceneId}?action=compare&left=${draft.draftId}@1&right=${draft.draftId}@2`, compact);
    await expectHeading(page, '对照候选稿');
    await page.getByRole('article', { name: '左稿', exact: true }).getByText(/<script>danger<\/script>/).waitFor();
    assert.equal(await page.locator('.writing-route script').count(), 0);
    await assertFitsViewport(page);
    await page.getByRole('article', { name: '左稿', exact: true }).locator('summary').filter({ hasText: /^采用与 IF$/ }).click();
    await link(page, '采纳左稿').click();
    await expectHeading(page, '采纳候选稿');
    assert.match(await page.locator('main').innerText(), /第 1 版/);
    await click(page, '采纳候选稿');
    await expectHeading(page, scene.title);
    assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.revision, 1);
    const character = await invoke('character.create', { name: '守船人' });
    const start = body.lastIndexOf('等一下。');
    const end = start + '等一下。'.length;
    await goto(page, `/drafts/${draft.draftId}?revision=1&start=${start}&end=${end}`, draft.title);
    assert.equal(await page.locator('#passage-body mark').innerText(), '等一下。');
    await click(page, '更多');
    await click(page, '采纳为角色条目');
    await field(page, '采纳到角色').selectOption(character.characterId);
    await field(page, '条目名称').fill('第二次喊话');
    await click(page, '采纳条目');
    await expectHeading(page, '守船人');
    const card = await invoke('character.read', { characterId: character.characterId });
    assert.deepEqual(card.entries[0].blocks[0].range, { start, end });
    await link(page, '候选稿 · 第 1 版').click();
    await expectHeading(page, draft.title);
    assert.equal(await page.locator('#passage-body mark').innerText(), '等一下。');
    await assertFitsViewport(page);
    await capture(page, 'compact-draft-evidence');
    // An actual DOM selection must disambiguate the second repeated passage too.
    await goto(page, `/drafts/${draft.draftId}?revision=1`, draft.title);
    await page.evaluate(({ start, end }) => {
      const walker = document.createTreeWalker(document.querySelector('#passage-body'), NodeFilter.SHOW_TEXT);
      let node;
      do { node = walker.nextNode(); } while (node && !node.textContent.length);
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, { start, end });
    await click(page, '更多');
    await click(page, '提炼为事件');
    await expectHeading(page, '新建事件');
    assert.equal(new URL(page.url()).searchParams.get('start'), String(start));
    assert.equal(new URL(page.url()).searchParams.get('draftRevision'), '1');
  });

  await t.test('adoption conflicts require rereading the current scene and another explicit choice', async t => {
    const scene = await invoke('scene.create', { title: '采纳冲突' });
    const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '选中的旧版', body: '保留此稿。' });
    const page = await open(t, origin, `/drafts/${draft.draftId}?revision=1&action=adopt`);
    await expectHeading(page, '采纳候选稿');
    await invoke('scene.revise', { sceneId: scene.sceneId, expectedRevision: 1, title: '已更新的场景', place: '码头' });
    await click(page, '采纳候选稿');
    await page.getByRole('alert').filter({ hasText: '内容已有更新' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '采纳候选稿', exact: true }).isDisabled(), true);
    assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted, undefined);
    await click(page, '读取最新场景后重新核对');
    await page.locator('.wr-heading').getByText('已更新的场景 · 第 2 版', { exact: true }).waitFor();
    await click(page, '采纳候选稿');
    await expectHeading(page, '已更新的场景');
    const saved = await invoke('scene.read', { sceneId: scene.sceneId });
    assert.equal(saved.adopted.revision, 1);
    assert.equal(saved.revision, 3);
    assert.equal(saved.place, '码头');
  });

  await t.test('unsaved prose survives reload and revision conflicts preserve the authored text', async t => {
    const scene = await invoke('scene.create', { title: '修订冲突' });
    const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '原稿', body: '原有文字。' });
    await invoke('scene.adopt', { sceneId: scene.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
    const page = await open(t, origin, `/drafts/${draft.draftId}?action=revise`);
    await expectHeading(page, '修订候选稿');
    await field(page, '正文').fill('我的未保存长文。\n第二段。');
    await page.reload();
    await expectHeading(page, '修订候选稿');
    assert.equal(await field(page, '正文').inputValue(), '我的未保存长文。\n第二段。');
    await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, sceneRevision: 2, body: '另一会话的第二版。' });
    await click(page, '保存修订');
    await page.getByRole('alert').filter({ hasText: '内容已有更新' }).waitFor();
    await click(page, '读取最新版本');
    await page.getByText('另一会话的第二版。', { exact: true }).waitFor();
    assert.equal(await field(page, '正文').inputValue(), '我的未保存长文。\n第二段。');
    await click(page, '保留我的文字，以此版本继续修订');
    await click(page, '保存修订');
    await expectHeading(page, '原稿');
    assert.equal((await invoke('draft.read', { draftId: draft.draftId })).revision, 3);
    assert.equal((await invoke('draft.read', { draftId: draft.draftId })).sceneRevision, 1, 'keep the context actually shown with the authored text');
    assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.body, '原有文字。');
  });

  await t.test('an unadopted historical candidate anchors an IF and its own context', async t => {
    const scene = await invoke('scene.create', { title: '不同选择' });
    const first = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '登船稿', body: '她登上船。' });
    const other = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '岸上稿', body: '她留在岸上。' });
    await invoke('draft.revise', { draftId: other.draftId, expectedRevision: 1, body: '岸上稿第二版。' });
    await invoke('scene.adopt', { sceneId: scene.sceneId, expectedRevision: 1, draftId: first.draftId, draftRevision: 1 });
    const page = await open(t, origin, `/drafts/${other.draftId}?revision=1`, phone);
    await expectHeading(page, '岸上稿');
    await toolLink(page, '从此稿建立 IF');
    await expectHeading(page, '建立 IF 分支');
    await page.getByText('她留在岸上。', { exact: true }).waitFor();
    await field(page, '分歧点').fill('另一种选择。');
    await field(page, '标题').fill('未采用稿的 IF');
    await page.reload();
    await expectHeading(page, '建立 IF 分支');
    assert.equal(await field(page, '分歧点').inputValue(), '另一种选择。');
    await click(page, '建立 IF 分支');
    await expectHeading(page, '未采用稿的 IF');
    const branch = await invoke('scene.read', { sceneId: idAt(page) });
    assert.deepEqual(branch.branchFrom.draft, { draftId: other.draftId, revision: 1 });
    assert.equal(branch.branchFrom.revision, 1);
    assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.draftId, first.draftId);
  });

  await t.test('a save completing after navigation is recovered without another candidate', async t => {
    const scene = await invoke('scene.create', { title: '导航中的写作' });
    const path = `/drafts/new?sceneId=${scene.sceneId}&revision=1`;
    const page = await open(t, origin, path);
    await expectHeading(page, '新建候选稿');
    await field(page, '标题').fill('稍后返回的稿');
    await field(page, '正文').fill('仍然能够找回。');
    let release;
    let wrote;
    const gate = new Promise(done => { release = done; });
    const saved = new Promise(done => { wrote = done; });
    t.after(() => release());
    let writes = 0;
    await page.route('**/api/web/invoke', async route => {
      if (route.request().postDataJSON().operationId !== 'draft.create') return route.continue();
      writes++;
      const response = await route.fetch();
      wrote();
      await gate;
      await route.fulfill({ response });
    });
    await click(page, '新建候选稿');
    await saved;
    await click(page, '返回文稿列表');
    await click(page, '资料库');
    await page.getByRole('navigation', { name: '文稿资料库', exact: true }).getByRole('link', { name: '日记', exact: true }).click();
    await page.locator('.manuscript-sheets').getByRole('heading', { name: '日记', exact: true }).waitFor();
    release();
    await goto(page, path, '新建候选稿');
    await click(page, '重试同一次提交');
    await expectHeading(page, '稍后返回的稿');
    assert.equal(writes, 1);
    assert.equal((await invoke('draft.list', { sceneId: scene.sceneId })).items.length, 1);
  });

  for (const operationId of ['draft.create', 'draft.revise', 'scene.adopt', 'scene.branch']) {
    await t.test(`${operationId} recovers the original receipt after a lost response and reload`, async t => {
      const scene = await invoke('scene.create', { title: `${operationId} 回执` });
      const draft = operationId === 'draft.create' ? undefined : await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '回执稿', body: '回执原文。' });
      const path = operationId === 'draft.create' ? `/drafts/new?sceneId=${scene.sceneId}&revision=1`
        : operationId === 'scene.branch' ? `/scenes/${scene.sceneId}?action=branch&revision=1`
        : `/drafts/${draft.draftId}?action=${operationId === 'scene.adopt' ? 'adopt&revision=1' : 'revise'}`;
      const page = await open(t, origin, path);
      await page.locator('.writing-route form').waitFor();
      if (operationId === 'draft.create') { await field(page, '标题').fill('丢响应稿'); await field(page, '正文').fill('不应重复的正文。'); }
      if (operationId === 'draft.revise') await field(page, '正文').fill('修订后的回执正文。');
      if (operationId === 'scene.branch') { await field(page, '分歧点').fill('停留在岸边。'); await field(page, '标题').fill('回执分支'); }
      let result;
      let call;
      let writeCount = 0;
      await page.route('**/api/web/invoke', async route => {
        const body = route.request().postDataJSON();
        if (body.operationId !== operationId) return route.continue();
        writeCount++;
        call = body;
        const response = await route.fetch();
        result = (await response.json()).result;
        await route.abort('failed');
      });
      await click(page, { 'draft.create': '新建候选稿', 'draft.revise': '保存修订', 'scene.adopt': '采纳候选稿', 'scene.branch': '建立 IF 分支' }[operationId]);
      await page.getByRole('alert').filter({ hasText: '保存结果尚未确认' }).waitFor();
      assert.ok(result);
      await page.reload();
      await click(page, '重试同一次提交');
      await expectHeading(page, operationId === 'scene.adopt' ? scene.title : result.title);
      assert.equal(writeCount, 1, 'receipt recovery must not execute another write');
      assert.equal(new URL(page.url()).pathname, `/${operationId === 'scene.branch' || operationId === 'scene.adopt' ? 'scenes' : 'drafts'}/${result.sceneId && operationId.startsWith('scene.') ? result.sceneId : result.draftId}`);
      assert.match(call.stepId, /^web:/);
      assert.equal((await invoke('draft.list', { sceneId: scene.sceneId })).items.length, 1);
      if (operationId === 'scene.branch') assert.equal((await invoke('scene.list', { branchOf: scene.sceneId })).items.length, 1);
      if (operationId === 'scene.adopt') assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).revision, 2);
    });
  }

  await t.test('paging, recoverable reads, invalid pins, history and legacy links', async t => {
    const scene = await invoke('scene.create', { title: '分页写作' });
    const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '多版稿', body: '版本1' });
    for (let i = 2; i <= 52; i++) await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: i - 1, body: `版本${i}` });
    const page = await openBrowser(t, origin, compact);
    let failing = true;
    await page.route('**/api/web/invoke', async route => {
      if (failing && route.request().postDataJSON().operationId === 'scene.read') return route.fulfill({ status: 503, json: { error: { code: 'temporary' } } });
      return route.continue();
    });
    await goto(page, `/scenes/${scene.sceneId}`);
    await page.getByRole('alert').waitFor();
    failing = false;
    await click(page, '重试读取');
    await expectHeading(page, scene.title);
    await toolLink(page, '对照候选稿');
    await expectHeading(page, '对照候选稿');
    assert.equal(await page.getByRole('combobox', { name: '左稿', exact: true }).locator('option').count(), 52);
    await page.getByRole('combobox', { name: '左稿', exact: true }).selectOption(`${draft.draftId}@1`);
    await page.getByRole('combobox', { name: '右稿', exact: true }).selectOption(`${draft.draftId}@52`);
    await click(page, '对照');
    await page.getByRole('article', { name: '左稿', exact: true }).getByText('版本1', { exact: true }).waitFor();
    await page.reload();
    await expectHeading(page, '对照候选稿');
    assert.equal(new URL(page.url()).searchParams.get('left'), `${draft.draftId}@1`);
    await assertFitsViewport(page);
    for (const path of [`/scenes/${scene.sceneId}?revision=0`, `/drafts/${draft.draftId}?revision=no`, `/scenes/${scene.sceneId}?action=compare&left=foreign@1`, '/scenes/missing']) {
      await goto(page, path);
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByRole('button', { name: '采纳候选稿', exact: true }).count(), 0);
    }
    await goto(page, `/scenes/${scene.sceneId}`, scene.title);
    await toolLink(page, '修订场景');
    await expectHeading(page, '修订场景');
    assert.equal(await page.locator('.legacy-route').count(), 1);
    await page.goBack();
    await expectHeading(page, scene.title);
    await page.locator('summary').filter({ hasText: /^候选稿与场景操作$/ }).click();
    await link(page, '新建讲述').click();
    await expectHeading(page, '新建讲述');
    assert.equal(new URL(page.url()).searchParams.get('sceneRevision'), '1');
  });
});
