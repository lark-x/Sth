import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

test('shared create menu preserves keyboard focus and native authoring navigation', { timeout: 90_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  try {
    for (const [engine, name, width, height] of [
      [chromium, 'chromium-desktop', 1280, 800],
      [chromium, 'chromium-phone', 390, 844],
      [webkit, 'webkit-compact', 320, 640],
    ]) {
      await t.test(name, async () => {
        const browser = await engine.launch();
        try {
          const page = await browser.newPage({ baseURL: workspace.origin, viewport: { width, height } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.goto('/settings');
          await page.locator('main h1').waitFor();
          if (width < 640) await page.getByRole('button', { name: '打开资料库导航', exact: true }).click();
          const historyBefore = await page.evaluate(() => ({ length: history.length, href: location.href }));
          const trigger = page.getByRole('button', { name: '新建', exact: true });
          await trigger.focus();
          await page.keyboard.press('Enter');
          const menu = page.getByRole('menu');
          await menu.waitFor();
          assert.equal(await menu.getAttribute('aria-labelledby'), await trigger.getAttribute('id'),
            'the menu is named by its create trigger');
          assert.deepEqual(await menu.getByRole('menuitem').evaluateAll(items => items.map(item => item.getAttribute('href'))),
            ['/diaries/new', '/scenes/new', '/projects/new', '/workspace?tab=continue']);
          assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '写日记');
          await page.keyboard.press('ArrowDown');
          assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '新建场景');
          await page.keyboard.press('End');
          assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '继续写作');
          await page.keyboard.press('Home');
          assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '写日记');
          const box = await menu.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height,
            'the popup stays within the viewport');
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'hidden' });
          // Reka restores focus from its unmount callback on the next task.
          await page.waitForFunction(() => document.activeElement?.matches('button.library-create'));
          assert.equal(await trigger.evaluate(element => element === document.activeElement), true,
            'Escape restores the menu trigger');
          assert.equal(await page.locator('.manuscript-library').isVisible(), true,
            'Escape closes only the menu and keeps the phone library open');
          assert.deepEqual(await page.evaluate(() => ({ length: history.length, href: location.href })), historyBefore,
            'opening and dismissing the menu does not add a history entry');
          await page.keyboard.press('Enter');
          await menu.waitFor();
          await page.keyboard.press('Enter');
          await page.waitForURL('**/diaries/new');
          await page.locator('main h1').waitFor();
          await page.waitForFunction(() => Boolean(document.activeElement?.closest('main')));
          await menu.waitFor({ state: 'hidden' });
          assert.equal(await page.locator('body').evaluate(element => getComputedStyle(element).pointerEvents), 'auto');
          await page.goBack();
          await page.waitForURL('**/settings');
          await page.locator('main h1').waitFor();
          assert.deepEqual(errors, []);
        } finally { await browser.close(); }
      });
    }
  } finally { await workspace.close(); }
});
