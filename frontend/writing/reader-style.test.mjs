import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

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
  assert.equal(await desktop.locator('.wr-toolbar-label').textContent(), '稿件与版本');
  assert.equal(await desktop.locator('.wr-reader-path').isVisible(), true);
  await desktop.getByRole('button', { name: '稿件与版本', exact: true }).click();
  assert.equal(await desktop.locator('.wr-version-title').textContent(), fixture.drafts[0].title);
  assert.match(await desktop.locator('.wr-toolbar-meta').innerText(), /第 1 版\s+采用稿\s+旧版 · 最新第 2 版/);

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
});
