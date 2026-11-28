import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';
import { assertFitsViewport } from '../../tests/browser/harness.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const body = page => page.getByRole('textbox', { name: '正文', exact: true });
const address = page => new URL(page.url());
const localHref = page => address(page).pathname + address(page).search + address(page).hash;
async function more(page, name) {
  await button(page, '更多').click();
  await page.locator('.wr-more-menu').getByRole('link', { name, exact: true }).click();
}
async function selectedTitle(page) {
  return page.locator('[aria-label="切换稿件"]').evaluate(select => select.selectedOptions[0]?.textContent.trim());
}

test('author reading, inline revision and comparison keep manuscript identity and navigation', { timeout: 240_000 }, async t => {
  const workspace = await startManuscriptWorkspace();
  t.after(workspace.close);
  const { origin, invoke } = workspace;
  async function fixture(revised = false) {
    const project = await invoke('project.create', { title: '作者读写回归' });
    const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '渡口' });
    const scene = await invoke('scene.create', { title: '船笛过后' });
    const text = Array.from({ length: 18 }, (_, i) => `第${i + 1}段。雨从栈桥另一头落下来。她把旧信收回衣袋，沿着灯影往前走。`).join('\n\n');
    const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '登船的讲法', body: text });
    const alternate = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '岸上的讲法', body: text + '\n她留在岸上。' });
    if (revised) await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: text + '\n她登上渡船。' });
    await invoke('scene.adopt', { sceneId: scene.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
    await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [scene.sceneId] });
    const chapterHref = `/chapters/${chapter.chapterId}?revision=1#scene-${scene.sceneId}`;
    const sceneHref = `/scenes/${scene.sceneId}?returnTo=${encodeURIComponent(chapterHref)}#passage-body`;
    return { scene, draft, alternate, chapterHref, sceneHref };
  }

  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    t.after(() => browser.close());
    for (const width of [1440, 390, 320]) {
      async function open(t, path) {
        const context = await browser.newContext({ baseURL: origin, viewport: { width, height: width === 320 ? 640 : 900 }, hasTouch: width < 500, locale: 'zh-CN' });
        t.after(() => context.close());
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
        await page.goto(path);
        await page.locator('#passage-body').waitFor();
        return page;
      }

      await t.test(`${engine.name()} ${width} saved title, selected manuscript and recovered edits agree`, async t => {
        const { scene, draft, alternate, sceneHref } = await fixture();
        const page = await open(t, `/drafts/${draft.draftId}?returnTo=${encodeURIComponent(sceneHref)}`);
        await button(page, '编辑').click();
        await body(page).waitFor();
        await page.getByRole('textbox', { name: '标题', exact: true }).fill('登船之前的一封信');
        const revised = draft.body + '\n作者保留的新段落。';
        await body(page).fill(revised);
        await button(page, '返回阅读').click();
        await page.locator('#passage-body').waitFor();
        assert.equal(await page.locator('#passage-body').textContent(), draft.body);
        await button(page, '编辑').click();
        await body(page).waitFor();
        assert.equal(await body(page).inputValue(), revised);
        await button(page, '保存修订').click();
        await page.getByRole('heading', { name: '登船之前的一封信', exact: true, level: 1 }).waitFor();
        await page.locator('#passage-body').waitFor();
        assert.equal(await selectedTitle(page), '登船之前的一封信');
        assert.equal(await page.getByRole('heading', { level: 1, name: '登船之前的一封信', exact: true }).count(), 1);
        assert.equal(await page.locator('.wr-toolbar-label').textContent(), '稿件与版本');
        await button(page, '稿件与版本').click();
        assert.equal(await page.locator('.wr-version-title').textContent(), '登船之前的一封信');
        assert.equal(await page.getByRole('combobox', { name: '切换稿件版本', exact: true }).inputValue(), '2');
        await page.keyboard.press('Escape');
        assert.equal((await invoke('draft.read', { draftId: draft.draftId })).body, revised);
        assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.revision, 1);
        await button(page, '编辑').click();
        await body(page).waitFor();
        await body(page).fill(revised + '\n切稿前的未保存文字。');
        await button(page, '稿件与版本').click();
        await page.getByRole('combobox', { name: '切换稿件', exact: true }).selectOption(alternate.draftId);
        await page.locator('#passage-body').waitFor();
        assert.equal(await selectedTitle(page), alternate.title);
        await button(page, '稿件与版本').click();
        await page.getByRole('combobox', { name: '切换稿件', exact: true }).selectOption(draft.draftId);
        await body(page).waitFor();
        assert.equal(await body(page).inputValue(), revised + '\n切稿前的未保存文字。');
        await button(page, '阅读').click();
        await page.locator('#passage-body').waitFor();
        await page.evaluate(() => window.scrollTo(0, 500));
        assert.equal(await button(page, '更多').evaluate(element => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }), true, 'toolbar action remains clickable after scrolling');
        await more(page, '对照候选稿');
        await page.locator('.wr-comparison').waitFor();
        await page.locator('.wr-compare-versions > summary').click();
        await page.locator('#wr-right').selectOption(`${alternate.draftId}@1`);
        await button(page, '对照').click();
        await page.locator('.wr-comparison').waitFor();
        if (width < 500) {
          await button(page, '右稿').click();
          assert.equal(await button(page, '右稿').getAttribute('aria-pressed'), 'true');
          assert.equal(await page.locator('[data-side="right"]').isVisible(), true);
          assert.equal(await page.locator('[data-side="left"]').isVisible(), false);
        }
        await assertFitsViewport(page);
      });

      await t.test(`${engine.name()} ${width} scene versions, candidate links and comparison preserve the return path`, async t => {
        const { scene, draft, chapterHref, sceneHref } = await fixture(true);
        const page = await open(t, sceneHref);
        await button(page, '稿件与版本').click();
        await page.getByRole('combobox', { name: '切换场景版本', exact: true }).selectOption('1');
        await page.locator('#passage-body').waitFor();
        assert.equal(address(page).searchParams.get('returnTo'), chapterHref);
        await more(page, '查看当前版本');
        await page.locator('#passage-body').waitFor();
        assert.equal(address(page).searchParams.get('returnTo'), chapterHref);
        await more(page, '版本历史');
        await page.locator('#scene-history').getByRole('link', { name: '第 1 版', exact: true }).click();
        await page.locator('#passage-body').waitFor();
        assert.equal(address(page).searchParams.get('returnTo'), chapterHref);
        await page.goto(sceneHref);
        await page.locator('#passage-body').waitFor();
        await more(page, '对照候选稿');
        await page.locator('.wr-comparison').waitFor();
        assert.equal(address(page).searchParams.get('returnTo'), sceneHref);
        await page.goto(sceneHref);
        await page.locator('#passage-body').waitFor();
        await more(page, '候选稿与场景操作');
        const candidateReturn = localHref(page);
        await page.locator('#candidates h3 a').filter({ hasText: draft.title }).click();
        await page.locator('#passage-body').waitFor();
        assert.equal(address(page).searchParams.get('returnTo'), candidateReturn);
        const reader = localHref(page) + '#passage-body';
        await page.goto(reader);
        await page.locator('#passage-body').waitFor();
        await more(page, '对照候选稿');
        await page.locator('.wr-comparison').waitFor();
        assert.equal(address(page).searchParams.get('returnTo'), reader);
        await page.locator('.wr-reader-heading > a').click();
        await page.locator('#passage-body').waitFor();
        assert.equal(localHref(page), reader);
        assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.revision, 1);
      });

      await t.test(`${engine.name()} ${width} returning to the adopted version after a scene edit keeps the originating page`, async t => {
        const { scene, draft, sceneHref } = await fixture(true);
        const page = await open(t, sceneHref);
        await button(page, '编辑').click();
        await body(page).waitFor();
        await button(page, '保留我的文字，以此版本继续修订').click();
        await body(page).fill(draft.body + '\n从旧采用稿继续修订。');
        await button(page, '保存修订').click();
        await page.locator('#passage-body').waitFor();
        assert.equal(await page.locator('[aria-label="切换稿件"]').inputValue(), `${draft.draftId}@3`);
        await button(page, '稿件与版本').click();
        await page.getByRole('combobox', { name: '切换稿件', exact: true }).selectOption(`${draft.draftId}@1`);
        await page.locator('#passage-body').waitFor();
        assert.equal(address(page).searchParams.get('returnTo'), sceneHref);
        await button(page, '更多').click();
        assert.equal(await page.locator('.wr-more-menu a').first().getAttribute('href'), sceneHref);
        assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.revision, 1);
      });
    }
  }
});
