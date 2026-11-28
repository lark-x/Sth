import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { startManuscriptWorkspace, writeJson } from '../../scripts/manuscript-fixture.mjs';

const artifacts = resolve('frontend/.artifacts/cohesive-ui/motion');

test('animated navigation and menu tolerate reversal, reduced motion and resizing without trapping focus', { timeout: 120_000 }, async t => {
  await mkdir(artifacts, { recursive: true });
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const report = { build: workspace.capturedBuild, cases: [] };
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        await t.test(`${engine.name()} ${reducedMotion}`, async () => {
          const context = await browser.newContext({ baseURL: workspace.origin, viewport: { width: 320, height: 640 }, reducedMotion,
            recordVideo: reducedMotion === 'no-preference' ? { dir: artifacts, size: { width: 320, height: 640 } } : undefined });
          try {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto('/settings');
            await page.locator('main h1').waitFor();
            const original = await page.evaluate(() => ({ href: location.href, length: history.length }));
            const open = page.getByRole('button', { name: '打开资料库导航', exact: true });
            await open.click();
            const library = page.locator('#library-navigation');
            await library.waitFor();
            const create = page.getByRole('button', { name: '新建', exact: true });
            await create.press('Enter');
            const menu = page.getByRole('menu');
            await menu.waitFor();
            if (reducedMotion === 'reduce') {
              assert.equal(await menu.evaluate(node => node.getAnimations().filter(animation => animation.playState === 'running').length), 0);
              assert.equal(await library.evaluate(node => node.getAnimations().filter(animation => animation.playState === 'running').length), 0);
            }
            // Reopen before the exit animation has unmounted the menu. This is
            // the new failure mode introduced by animated Reka presence.
            await page.keyboard.press('Escape');
            await create.press('Enter');
            await menu.waitFor();
            await page.keyboard.press('End');
            assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), '继续写作');
            await page.keyboard.press('Escape');
            await menu.waitFor({ state: 'hidden' });
            await page.waitForFunction(() => document.activeElement?.matches('.library-create'));
            await page.getByRole('button', { name: '返回当前页面', exact: true }).press('Enter');
            await library.waitFor({ state: 'hidden' });
            assert.equal(await open.evaluate(node => node === document.activeElement), true);
            assert.deepEqual(await page.evaluate(() => ({ href: location.href, length: history.length })), original);

            // Reverse a pane while its entrance is running, then cross the
            // breakpoint. Animation may be cancelled; final layout must stand.
            await open.press('Enter');
            await page.getByRole('button', { name: '返回当前页面', exact: true }).press('Enter');
            await open.press('Enter');
            await page.setViewportSize({ width: 768, height: 1024 });
            // The title is visible in both wide panes. Wait for the media-query
            // state update, not merely for that already-visible title.
            await page.waitForFunction(() => document.querySelector('.manuscript-frame')?.getAttribute('data-pane') === 'editor');
            await page.setViewportSize({ width: 320, height: 640 });
            await library.waitFor({ state: 'hidden' });
            assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).pointerEvents), 'auto');
            assert.equal(await page.locator('main').evaluate(node => node.inert), false);
            assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            await page.screenshot({ path: resolve(artifacts, `${engine.name()}-${reducedMotion}-settled.png`), animations: 'disabled' });
            report.cases.push({ engine: engine.name(), reducedMotion, status: 'passed', video: await page.video()?.path() });
          } finally { await context.close(); }
        });
      }
    } finally { await browser.close(); }
  }
  await writeJson(resolve(artifacts, 'manifest.json'), report);
});
