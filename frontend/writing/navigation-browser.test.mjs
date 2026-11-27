import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

const recentKey = 'sth:manuscripts:recent:v1';
const button = (page, name) => page.getByRole('button', { name, exact: true });
const body = page => page.getByRole('textbox', { name: '正文', exact: true });
const address = page => new URL(page.url());
const moreMenu = page => page.locator('.wr-more-menu');

async function more(page, name) {
  await button(page, '更多').click();
  await moreMenu(page).getByRole('link', { name, exact: true }).click();
}

async function assertBack(page, expected) {
  await button(page, '更多').click();
  assert.equal(await moreMenu(page).getByRole('link').first().getAttribute('href'), expected);
  await page.keyboard.press('Escape');
}

async function recent(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), recentKey);
}

async function assertRecent(page, draft, expectedHref) {
  await page.waitForFunction(({ key, id, href }) => {
    const first = JSON.parse(localStorage.getItem(key) || '[]')[0];
    return first?.kind === 'draft' && first.id === id && first.href === href;
  }, { key: recentKey, id: draft.draftId, href: expectedHref });
  const [first] = await recent(page);
  assert.equal(first.title, draft.title);
  assert.equal(first.sceneId, draft.sceneId);
  const url = new URL(first.href, page.url());
  assert.equal(url.searchParams.has('action'), false);
  assert.equal(url.searchParams.has('edit'), false);
}

function draftHref(draft, params = {}) {
  const query = new URLSearchParams(params);
  return `/drafts/${draft.draftId}${query.size ? `?${query}` : ''}`;
}

test('writing navigation preserves return context and records the explicitly edited manuscript', { timeout: 240_000 }, async t => {
  const workspace = await startManuscriptWorkspace();
  t.after(workspace.close);
  const { invoke, origin } = workspace;

  async function fixture(label, revised = true) {
    const project = await invoke('project.create', { title: label });
    const chapter = await invoke('chapter.create', { projectId: project.projectId, title: `${label}的章节` });
    const scene = await invoke('scene.create', { title: `${label}的场景` });
    const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: `${label}的稿件`, body: '第一版，林澈仍然留在岸上。' });
    const latest = revised ? await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: '第二版，林澈已经登上渡船。' }) : draft;
    await invoke('scene.adopt', { sceneId: scene.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
    await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [scene.sceneId] });
    const returnTo = `/chapters/${chapter.chapterId}?revision=1&chapterId=${chapter.chapterId}&filter=a%2Bb%3D#scene-${scene.sceneId}`;
    return { project, chapter, scene, draft, latest, returnTo };
  }

  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    t.after(() => browser.close());
    async function pageFor(t) {
      const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
      t.after(() => context.close());
      const page = await context.newPage();
      page.setDefaultTimeout(7_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
      return page;
    }

    await t.test(`${engine.name()} history, current-version and version-select links preserve chapter query and anchor`, async t => {
      const { draft, latest, returnTo } = await fixture('历史返回');
      const page = await pageFor(t);
      await page.goto(draftHref(draft, { returnTo }));
      await page.locator('#passage-body').waitFor();
      await more(page, '版本历史');
      await page.locator('#draft-history').getByRole('link', { name: '第 1 版', exact: true }).click();
      await page.waitForFunction(text => document.querySelector('#passage-body')?.textContent === text, draft.body);
      assert.equal(address(page).searchParams.get('returnTo'), returnTo);
      await assertBack(page, returnTo);
      await more(page, '查看当前版本');
      await page.waitForFunction(text => document.querySelector('#passage-body')?.textContent === text, latest.body);
      assert.equal(address(page).searchParams.get('returnTo'), returnTo);
      await page.getByRole('button', { name: '稿件与版本', exact: true }).click();
      await page.getByRole('combobox', { name: '切换稿件版本', exact: true }).selectOption('1');
      await page.waitForFunction(text => document.querySelector('#passage-body')?.textContent === text, draft.body);
      await assertBack(page, returnTo);
      await button(page, '更多').click();
      await moreMenu(page).getByRole('link').first().click();
      await page.waitForURL(origin + returnTo);
      assert.equal(address(page).pathname + address(page).search + address(page).hash, returnTo);
    });

    await t.test(`${engine.name()} explicit revision from a collection preserves its source version and returns after saving`, async t => {
      const { draft, returnTo } = await fixture('独立修订');
      const page = await pageFor(t);
      const readingHref = draftHref(draft, { revision: '1', returnTo });
      const seeded = [{ kind: 'draft', id: draft.draftId, title: draft.title, href: readingHref, sceneId: draft.sceneId, updatedAt: Date.now() }];
      await page.addInitScript(({ key, items }) => localStorage.setItem(key, JSON.stringify(items)), { key: recentKey, items: seeded });
      await page.goto('/workspace?tab=recent');
      await page.locator('#passage-body').waitFor();
      assert.deepEqual(await recent(page), seeded, 'automatic preview does not change recent');
      await more(page, '修订候选稿');
      await body(page).waitFor();
      assert.equal(address(page).pathname, `/drafts/${draft.draftId}`);
      assert.equal(address(page).searchParams.get('returnTo'), returnTo);
      assert.equal(address(page).searchParams.get('revision'), '1');
      assert.equal(await body(page).inputValue(), draft.body);
      assert.equal(await button(page, '保存修订').isDisabled(), true, 'old versions require acknowledgement');
      assert.equal(await page.getByRole('link', { name: '返回候选稿', exact: true }).getAttribute('href'), readingHref);
      await assertRecent(page, draft, readingHref);
      await button(page, '保留我的文字，以此版本继续修订').click();
      await page.getByRole('textbox', { name: '标题', exact: true }).fill('从第一版明确续写');
      await body(page).fill('作者从第一版继续，保存为第三版。');
      await button(page, '保存修订').click();
      await page.locator('#passage-body').waitFor();
      const saved = await invoke('draft.read', { draftId: draft.draftId });
      assert.equal(saved.revision, 3);
      assert.equal(saved.body, '作者从第一版继续，保存为第三版。');
      assert.equal(address(page).searchParams.get('returnTo'), returnTo);
      assert.equal(address(page).searchParams.has('action'), false);
      assert.equal(address(page).searchParams.has('revision'), false);
      await assertBack(page, returnTo);
      await assertRecent(page, saved, draftHref(draft, { returnTo }));
    });

    await t.test(`${engine.name()} collection scene preview opens the adopted draft for explicit editing and saving`, async t => {
      const { project, chapter, scene, draft } = await fixture('预览编辑', false);
      const page = await pageFor(t);
      await page.goto(`/projects/${project.projectId}?chapterId=${chapter.chapterId}`);
      await page.locator('#passage-body').waitFor();
      assert.deepEqual(await recent(page), [], 'a scene preview is not an explicit open');
      assert.equal(await page.locator('#passage-body').textContent(), draft.body);
      const back = await page.locator('a.library-sheet').first().getAttribute('href');
      assert.equal(new URL(back, origin).pathname, `/scenes/${scene.sceneId}`);
      await page.locator('#passage-body').evaluate(element => {
        const selection = getSelection();
        const range = document.createRange();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode()) && !text.textContent.length) { /* Skip Vue's empty branch text. */ }
        range.setStart(text, 4);
        range.setEnd(text, 6);
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await button(page, '编辑').click();
      await body(page).waitFor();
      assert.equal(address(page).pathname, `/drafts/${draft.draftId}`);
      assert.equal(address(page).searchParams.get('revision'), '1');
      const selection = await body(page).evaluate(element => [element.selectionStart, element.selectionEnd]);
      assert.deepEqual(selection, [4, 6]);
      const reading = draftHref(draft, { revision: '1', returnTo: back, start: '4', end: '6' });
      await assertRecent(page, draft, reading);
      await button(page, '阅读').click();
      await page.locator('#passage-body').waitFor();
      assert.equal(await page.locator('#passage-body').textContent(), draft.body);
      await assertRecent(page, draft, reading);
      await button(page, '编辑').click();
      await body(page).waitFor();
      await body(page).fill('从作品预览明确保存的候选稿。');
      await button(page, '保存修订').click();
      await page.locator('#passage-body').waitFor();
      const saved = await invoke('draft.read', { draftId: draft.draftId });
      assert.equal(saved.revision, 2);
      assert.equal(saved.body, '从作品预览明确保存的候选稿。');
      assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.revision, 1);
      await assertRecent(page, saved, draftHref(draft, { returnTo: back }));
    });

    await t.test(`${engine.name()} recent draft preview becomes an owned inline edit and returns to reading`, async t => {
      const { draft, returnTo } = await fixture('最近稿件');
      const page = await pageFor(t);
      const readingHref = draftHref(draft, { returnTo });
      const seeded = [{ kind: 'draft', id: draft.draftId, title: draft.title, href: readingHref, sceneId: draft.sceneId, updatedAt: Date.now() }];
      await page.addInitScript(({ key, items }) => localStorage.setItem(key, JSON.stringify(items)), { key: recentKey, items: seeded });
      await page.goto('/workspace?tab=recent');
      await page.locator('#passage-body').waitFor();
      assert.deepEqual(await recent(page), seeded);
      await button(page, '编辑').click();
      await body(page).waitFor();
      assert.equal(address(page).pathname, `/drafts/${draft.draftId}`);
      await assertRecent(page, draft, readingHref);
      await body(page).fill('这段仍留在本标签页。');
      await button(page, '阅读').click();
      await page.locator('#passage-body').waitFor();
      assert.equal(address(page).searchParams.has('edit'), false);
      await page.reload();
      await page.locator('#passage-body').waitFor();
      await assertBack(page, returnTo);
      await assertRecent(page, draft, readingHref);
      await button(page, '编辑').click();
      assert.equal(await body(page).inputValue(), '这段仍留在本标签页。');
      await button(page, '保存修订').click();
      await page.locator('#passage-body').waitFor();
      const saved = await invoke('draft.read', { draftId: draft.draftId });
      assert.equal(saved.body, '这段仍留在本标签页。');
      await assertRecent(page, saved, readingHref);
    });

    await t.test(`${engine.name()} direct scene edits record the actual candidate while adoption stays pinned`, async t => {
      const { scene, draft } = await fixture('场景原位');
      const page = await pageFor(t);
      await page.goto(`/scenes/${scene.sceneId}`);
      await page.locator('#passage-body').waitFor();
      assert.equal((await recent(page))[0].kind, 'scene');
      await button(page, '编辑').click();
      await body(page).waitFor();
      const readingHref = draftHref(draft, { revision: '1', returnTo: `/scenes/${scene.sceneId}` });
      await assertRecent(page, draft, readingHref);
      await button(page, '返回阅读').click();
      await page.locator('#passage-body').waitFor();
      await assertRecent(page, draft, readingHref);
      await button(page, '编辑').click();
      await body(page).waitFor();
      await button(page, '保留我的文字，以此版本继续修订').click();
      await body(page).fill('仍从采用的第一版修订为新的候选稿。');
      await button(page, '保存修订').click();
      await page.locator('#passage-body').waitFor();
      const saved = await invoke('draft.read', { draftId: draft.draftId });
      assert.equal(await page.locator('#passage-body').textContent(), saved.body);
      await assertRecent(page, saved, draftHref(draft, { returnTo: `/scenes/${scene.sceneId}` }));
      assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.revision, 1);
    });

    await t.test(`${engine.name()} explicit reading and new-candidate saving from collection use their own records`, async t => {
      const { project, scene } = await fixture('明确打开与新稿');
      const page = await pageFor(t);
      await page.goto(`/projects/${project.projectId}`);
      await page.locator('#passage-body').waitFor();
      assert.deepEqual(await recent(page), []);
      const link = page.locator('a.library-sheet').first();
      const sceneHref = await link.getAttribute('href');
      assert.equal(new URL(sceneHref, origin).pathname, `/scenes/${scene.sceneId}`);
      await link.click();
      await page.waitForURL(origin + sceneHref);
      await page.locator('#passage-body').waitFor();
      const [opened] = await recent(page);
      assert.equal(opened.kind, 'scene');
      assert.equal(opened.id, scene.sceneId);
      assert.equal(opened.href, sceneHref);
      await more(page, '新建候选稿');
      await body(page).waitFor();
      await page.getByRole('textbox', { name: '标题', exact: true }).fill('明确新建的独立候选稿');
      await body(page).fill('另写一个结尾，等天亮再选。');
      await button(page, '新建候选稿').click();
      await page.locator('#passage-body').waitFor();
      const id = address(page).pathname.split('/').at(-1);
      const created = await invoke('draft.read', { draftId: id });
      assert.equal(created.title, '明确新建的独立候选稿');
      assert.equal(created.sceneId, scene.sceneId);
      await assertRecent(page, created, draftHref(created));
    });
  }
});
