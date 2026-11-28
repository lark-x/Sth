import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';
import { diagnoseRoute } from '../tests/route-diagnostics.mjs';

async function assertVersionState(page, expected) {
  const state = page.locator('.wr-version-state');
  await state.waitFor();
  assert.equal(await state.isVisible(), true);
  const labels = state.locator(':scope > span');
  assert.deepEqual((await labels.allTextContents()).map(value => value.trim()), expected);
  for (let index = 0; index < expected.length; index++)
    assert.equal(await labels.nth(index).isVisible(), true, expected[index]);
}

async function closeVersions(page) {
  await page.keyboard.press('Escape');
  await page.locator('.wr-versions-menu').waitFor({ state: 'hidden' });
}

test('reader keeps the manuscript name on the paper and exposes the full path in the mobile version menu', { timeout: 90_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  const browser = await chromium.launch();
  t.after(() => browser.close());

  const desktop = await browser.newPage({
    baseURL: workspace.origin,
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  });
  await desktop.goto(fixture.links.oldDraft);
  await desktop.locator('#passage-body').waitFor();
  assert.equal(await desktop.getByRole('heading', { level: 1, name: fixture.drafts[0].title, exact: true }).count(), 1);
  const desktopPicker = desktop.getByRole('button', { name: '稿件与版本', exact: true });
  assert.equal(await desktopPicker.isVisible(), true);
  assert.equal(await desktopPicker.innerText(), '第 1 版 · 历史');
  assert.equal(await desktopPicker.getAttribute('aria-describedby'), await desktop.locator('.wr-toolbar-meta').getAttribute('id'));
  assert.equal(await desktop.locator('.wr-reader-path').isVisible(), true);
  await desktop.getByRole('button', { name: '稿件与版本', exact: true }).click();
  assert.equal(await desktop.locator('.wr-version-title').textContent(), fixture.drafts[0].title);
  assert.match(await desktop.locator('.wr-toolbar-meta').textContent(), /第 1 版\s*采用稿\s*旧版 · 最新第 2 版/);
  await assertVersionState(desktop, ['正在查看 · 第 1 版', '采用稿', '最新修订 · 第 2 版']);
  await closeVersions(desktop);

  const mobile = await browser.newPage({
    baseURL: workspace.origin,
    viewport: { width: 320, height: 640 },
    locale: 'zh-CN',
    isMobile: true,
    hasTouch: true,
  });
  await mobile.goto(fixture.links.oldDraft);
  await mobile.locator('#passage-body').waitFor();
  assert.equal(await mobile.locator('.wr-reader-path').isVisible(), false);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 320);
  await mobile.getByRole('button', { name: '稿件与版本', exact: true }).tap();
  const versionPath = mobile.locator('.wr-version-path');
  assert.equal(await versionPath.isVisible(), true);
  assert.deepEqual(await versionPath.locator('a').allTextContents(), [fixture.project.title, fixture.chapters[1].title]);
  assert.equal(await versionPath.locator('span').last().textContent(), fixture.scene.title);
  assert.equal(await mobile.locator('.wr-version-title').textContent(), fixture.drafts[0].title);
  await assertVersionState(mobile, ['正在查看 · 第 1 版', '采用稿', '最新修订 · 第 2 版']);
  await closeVersions(mobile);

  await diagnoseRoute(mobile, async () => {
    await mobile.goto(fixture.links.scene);
    await mobile.getByRole('button', { name: '稿件与版本', exact: true }).click();
  });
  assert.equal(await mobile.locator('.wr-version-path').isVisible(), true);
  assert.equal(await mobile.locator('.wr-version-path > span:last-child').textContent(), fixture.scene.title);
  assert.deepEqual(await mobile.locator('.wr-version-path a').allTextContents(), [fixture.project.title, fixture.chapters[1].title]);
  await assertVersionState(mobile, ['正在查看 · 第 1 版', '采用稿', '最新修订 · 第 2 版']);
  await closeVersions(mobile);

  const looseScene = await workspace.invoke('scene.create', { title: '尚未归入作品的空场景' });
  await mobile.goto(`/scenes/${looseScene.sceneId}`);
  await mobile.getByRole('button', { name: '稿件与版本', exact: true }).click();
  assert.equal(await mobile.locator('.wr-version-path').isVisible(), true);
  assert.equal(await mobile.locator('.wr-version-path a').count(), 0);
  assert.equal(await mobile.locator('.wr-version-path > span:last-child').textContent(), looseScene.title);
  assert.match(await mobile.locator('.wr-toolbar-meta').textContent(), /暂无稿件/);
  await assertVersionState(mobile, ['暂无稿件']);
  await closeVersions(mobile);
});
