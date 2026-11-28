import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

const localAddress = page => {
  const url = new URL(page.url());
  return url.pathname + url.search + url.hash;
};

test('review pages give manuscripts room and restore the reader without changing its view preference', { timeout: 150_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'built' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  for (const [engine, width, height] of [[chromium, 1280, 800], [chromium, 1050, 800], [chromium, 1049, 800],
    [chromium, 768, 1024], [chromium, 640, 800], [chromium, 639, 800], [chromium, 390, 844], [webkit, 320, 640]]) {
    await t.test(`${engine.name()} ${width}`, async t => {
      const browser = await engine.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ baseURL: workspace.origin, viewport: { width, height } });
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(fixture.links.oldPassage);
      await page.locator('#passage-body mark').waitFor();
      assert.equal(await page.locator('#passage-body mark').innerText(), fixture.target.excerpt);
      const readerAddress = localAddress(page);
      const frame = page.locator('.manuscript-frame');
      const library = page.locator('.manuscript-library');
      const sheets = page.locator('.manuscript-sheets');
      const before = { library: await library.isVisible(), sheets: await sheets.isVisible() };
      await library.evaluate(node => { node.dataset.reviewContinuity = 'same-library'; });
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await page.locator('.wr-more-menu').getByRole('link', { name: '对照候选稿', exact: true }).click();
      await page.locator('.wr-comparison').waitFor();
      assert.equal(await frame.evaluate(node => node.classList.contains('ms-focus')), false,
        'entering review does not set the author focus preference');
      assert.equal(await sheets.isVisible(), false, 'the document list does not compete with the two compared manuscripts');
      const editorWidth = await page.locator('#main').evaluate(node => node.getBoundingClientRect().width);
      assert.ok(editorWidth >= width - (width >= 1050 ? 240 : 1), `review receives readable space: ${editorWidth}/${width}`);
      assert.equal(await library.getAttribute('data-review-continuity'), 'same-library');
      if (width >= 1050) {
        assert.equal(await library.isVisible(), true, 'desktop review retains the library');
      }
      if (width >= 640 && width < 1050) {
        const toggle = page.getByRole('button', { name: '资料库', exact: true });
        await toggle.click();
        assert.equal(await library.isVisible(), true, 'the existing library action remains usable in tablet review');
        const librarySize = await library.evaluate(node => ({
          width: node.getBoundingClientRect().width,
          expected: parseFloat(getComputedStyle(document.documentElement).fontSize) * 15,
        }));
        assert.ok(Math.abs(librarySize.width - librarySize.expected) <= 1,
          `tablet library occupies the existing 15rem column: ${JSON.stringify(librarySize)}`);
        assert.equal(await page.locator('.wr-comparison').isVisible(), true);
        await toggle.click();
        assert.equal(await library.isVisible(), false);
      }
      const overflow = await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - innerWidth);
      assert.ok(overflow <= 1, `review must reflow without horizontal scrolling: ${overflow}`);
      await page.locator('.wr-compare-heading > a').click();
      await page.locator('#passage-body mark').waitFor();
      assert.equal(localAddress(page), readerAddress, 'return preserves the exact draft revision and selected passage');
      assert.equal(await page.locator('#passage-body mark').innerText(), fixture.target.excerpt);
      assert.deepEqual({ library: await library.isVisible(), sheets: await sheets.isVisible() }, before,
        'the original reading layout returns after review');
      assert.equal(await library.getAttribute('data-review-continuity'), 'same-library');

      if (width === 1280) {
        await page.getByRole('button', { name: '专注阅读', exact: true }).click();
        await page.getByRole('button', { name: '更多', exact: true }).click();
        await page.locator('.wr-more-menu').getByRole('link', { name: '对照候选稿', exact: true }).click();
        await page.locator('.wr-comparison').waitFor();
        assert.equal(await frame.evaluate(node => node.classList.contains('ms-focus')), true);
        assert.equal(await library.isVisible(), false, 'review respects an explicit author focus preference');
        await page.locator('.wr-compare-heading > a').click();
        await page.locator('#passage-body mark').waitFor();
        assert.equal(await frame.evaluate(node => node.classList.contains('ms-focus')), true);
        await page.getByRole('button', { name: '显示目录', exact: true }).click();
      }

      const adoption = new URL(fixture.links.oldDraft, workspace.origin);
      adoption.searchParams.set('action', 'adopt');
      await page.goto(adoption.href);
      await page.getByRole('heading', { name: '采纳候选稿', exact: true, level: 1 }).waitFor();
      assert.equal(await sheets.isVisible(), false, 'adoption gives its manuscript the same review space');
      assert.equal(await library.isVisible(), width >= 1050, 'adoption retains the responsive library visibility');
      const adoptionWidth = await page.locator('#main').evaluate(node => node.getBoundingClientRect().width);
      assert.ok(adoptionWidth >= width - (width >= 1050 ? 240 : 1),
        `adoption receives the same readable space: ${adoptionWidth}/${width}`);
      assert.equal((await workspace.invoke('scene.read', { sceneId: fixture.scene.sceneId })).adopted.revision, 1,
        'viewing a confirmation never changes the adopted revision');
      assert.deepEqual(errors, []);
    });
  }
});
