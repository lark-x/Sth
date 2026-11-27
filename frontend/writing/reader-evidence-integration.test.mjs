import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

test('real reader menus keep evidence bound to the displayed manuscript revision', { timeout: 90_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  for (const [engine, width] of [[chromium, 1280], [webkit, 390]]) {
    await t.test(`${engine.name()}-${width}`, async t => {
      const browser = await engine.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ baseURL: workspace.origin, viewport: { width, height: 844 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const panel = page.locator('.evidence-panel');
      const button = name => page.getByRole('button', { name, exact: true });
      const bodyStyles = () => page.evaluate(() => Object.fromEntries(
        ['position', 'top', 'left', 'width', 'overflow'].map(name => [name, document.body.style[name]])));
      async function openEvidence() {
        if (!await panel.isVisible()) await button('来源与依据').click();
        await panel.waitFor();
      }
      async function choose(label, value) {
        // A mobile modal owns interaction; on desktop exercise the real version
        // menu while the fixed evidence sidebar is still open.
        if (width < 640 && await panel.isVisible()) await button('关闭依据').click();
        await button('稿件与版本').click();
        await page.getByRole('combobox', { name: label, exact: true }).selectOption(value);
        await page.locator('#passage-body').waitFor();
      }
      await page.goto(fixture.links.oldDraft);
      await page.locator('#passage-body').waitFor();
      const originalBodyStyles = await bodyStyles();
      await openEvidence();
      await panel.locator('.evidence-content').getByText(fixture.sourcePin.excerpt, { exact: true }).waitFor();
      await choose('切换稿件版本', '2');
      await page.waitForURL(fixture.links.newDraft);
      assert.equal(await page.locator('#passage-body').textContent(), fixture.bodies.latest);
      await openEvidence();
      await panel.getByText('这版稿件还没有已确认的来源记录', { exact: true }).waitFor();
      assert.equal(await panel.locator('.evidence-content').count(), 0, 'the new revision does not inherit the old evidence');
      await choose('切换稿件', fixture.drafts[1].draftId);
      await page.waitForURL(url => url.pathname === `/drafts/${fixture.drafts[1].draftId}`);
      await openEvidence();
      await panel.locator('.evidence-content').getByText(fixture.alternatePin.excerpt, { exact: true }).waitFor();
      const reference = new URL(await panel.locator('.evidence-source a').first().getAttribute('href'), page.url());
      const manuscript = new URL(page.url());
      assert.equal(reference.searchParams.get('revision'), '1');
      assert.equal(reference.searchParams.getAll('returnTo').length, 1);
      assert.equal(reference.searchParams.get('returnTo'), manuscript.pathname + manuscript.search + manuscript.hash);
      await button('关闭依据').click();
      assert.equal(await page.locator('[inert]').count(), 0);
      assert.deepEqual(await bodyStyles(), originalBodyStyles, 'all body scroll-lock styles are restored');
      assert.deepEqual(errors, []);
    });
  }
});
