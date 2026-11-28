import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

const artifacts = resolve('frontend/.artifacts/evidence-ai/fixed-frame');
const viewports = [
  { width: 1280, height: 800 }, { width: 768, height: 1024 }, { width: 640, height: 900 },
  { width: 390, height: 844 }, { width: 320, height: 640 },
];
const evidence = page => page.locator('.evidence-panel:visible');
const toolbarEntry = page => page.getByRole('navigation', { name: '读写工具', exact: true })
  .getByRole('button', { name: '来源与依据', exact: true });
const relative = address => address.pathname + address.search + address.hash;

async function pinnedLink(panel, destination, manuscript, origin) {
  const expected = new URL(destination, origin);
  expected.searchParams.set('returnTo', manuscript);
  const link = panel.locator(`a[href="${relative(expected)}"]`).first();
  const actual = new URL(await link.getAttribute('href'), origin);
  assert.equal(actual.origin, origin);
  assert.deepEqual(actual.searchParams.getAll('returnTo'), [manuscript]);
  actual.searchParams.delete('returnTo');
  assert.equal(relative(actual), destination);
  return link;
}

test('actual manuscript toolbar opens the fixed panel on Chromium and mobile WebKit', async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(() => workspace.close());
  const fixture = await createManuscriptFixture(workspace.invoke);
  await mkdir(artifacts, { recursive: true });
  const results = [];
  for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
    const browser = await browserType.launch();
    try {
      for (const viewport of viewports.filter(item => engine === 'chromium' || item.width < 640)) {
        const context = await browser.newContext({ baseURL: workspace.origin, viewport, locale: 'zh-CN',
          ...(engine === 'webkit' ? { isMobile: true, hasTouch: true } : {}) });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          const manuscript = `${fixture.links.oldPassage}&${new URLSearchParams({ returnTo: `${fixture.links.scene}?revision=2#passage-body` })}#draft-reading-position`;
          await page.goto(manuscript);
          await page.locator('#passage-body mark').waitFor();
          await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
          await toolbarEntry(page).focus();
          assert.equal(await toolbarEntry(page).getAttribute('aria-expanded'), 'false');
          const before = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
          const entryBox = await toolbarEntry(page).boundingBox();
          assert.ok(entryBox && entryBox.y >= 0 && entryBox.y + entryBox.height <= viewport.height);
          await page.screenshot({ path: resolve(artifacts, `${engine}-${viewport.width}-toolbar.png`), animations: 'disabled' });
          await toolbarEntry(page).press('Enter');
          const panel = evidence(page);
          const fixed = panel.locator('.evidence-content');
          const quote = fixed.getByText(fixture.sourcePin.excerpt, { exact: true });
          await quote.waitFor();
          const typography = await quote.evaluate(node => {
            const style = getComputedStyle(node);
            return { size: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) };
          });
          assert.equal(typography.size, 18);
          assert.ok(Math.abs(typography.lineHeight / typography.size - 1.8) < .001);
          for (const text of [fixture.sourcePin.excerpt, fixture.character.persona, '林澈在第三声钟响后登船，信仍未拆开。']) {
            const content = await fixed.getByText(text, { exact: true }).boundingBox();
            assert.ok(content && content.y >= 0 && content.y + content.height <= viewport.height, `first screen shows ${text}`);
          }
          assert.equal(await panel.getByRole('combobox').count(), 0);
          assert.equal(await panel.getByRole('link', { name: '完整提示词与出处' }).count(), 0);
          await pinnedLink(fixed, fixture.links.source, manuscript, workspace.origin);
          await pinnedLink(fixed, fixture.links.character, manuscript, workspace.origin);
          const toolbarState = page.locator('.wr-reader-toolbar button[aria-label="来源与依据"]');
          assert.equal(await toolbarState.getAttribute('aria-expanded'), 'true');
          assert.equal(await toolbarState.getAttribute('aria-controls'), await panel.getAttribute('id'));
          const box = await panel.boundingBox();
          assert.ok(box);
          assert.equal(box.y, 0);
          assert.ok(Math.abs(box.height - viewport.height) < 1, 'panel fills the dynamic viewport including browser subpixel rounding');
          const expectedWidth = viewport.width < 640 ? viewport.width : Math.min(320, viewport.width * .4);
          assert.ok(Math.abs(box.width - expectedWidth) < 1, `panel uses the frame width at ${viewport.width}px`);
          assert.ok(Math.abs(box.x + box.width - viewport.width) < 1);
          assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
          const identity = panel.locator('.evidence-identity-line');
          assert.equal(await identity.innerText(), `${fixture.drafts[0].title} · 修订 1`);
          const revision = await identity.boundingBox();
          assert.ok(revision && revision.x + revision.width <= box.x + box.width);
          if (viewport.width >= 640) {
            const main = await page.locator('main').boundingBox();
            assert.ok(main && main.x + main.width <= box.x + 1, 'frame reserves the same width as the fixed panel');
          } else {
            assert.equal(await panel.getAttribute('aria-modal'), 'true');
            assert.equal(await page.locator('.wr-reader-toolbar').evaluate(node => Boolean(node.closest('[inert]'))), true);
            assert.equal(await page.evaluate(() => document.body.style.position), 'fixed');
          }
          await page.screenshot({ path: resolve(artifacts, `${engine}-${viewport.width}-open.png`), animations: 'disabled' });
          await panel.getByText('其他引用', { exact: true }).click();
          await panel.locator('.evidence-other').getByText('查看完整内容', { exact: true }).click();
          await panel.evaluate(node => { node.scrollTop = node.scrollHeight; });
          assert.ok(await panel.evaluate(node => node.scrollTop > 0), 'evidence scrolls independently');
          const close = panel.getByRole('button', { name: '关闭依据', exact: true });
          assert.equal(await close.evaluate(node => {
            const bounds = node.getBoundingClientRect();
            return bounds.top >= 0 && bounds.bottom < 120
              && node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
          }), true, 'close stays above the reading toolbar after scrolling');
          const heading = await panel.getByRole('heading', { name: '本次依据', exact: true }).boundingBox();
          assert.ok(heading && heading.y >= 0 && heading.y < 100);
          await page.screenshot({ path: resolve(artifacts, `${engine}-${viewport.width}-scrolled.png`), animations: 'disabled' });
          await panel.press('Escape');
          assert.equal(await evidence(page).count(), 0);
          assert.equal(await toolbarEntry(page).evaluate(node => document.activeElement === node), true);
          assert.equal(await toolbarEntry(page).getAttribute('aria-expanded'), 'false');
          const returned = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
          assert.ok(Math.abs(returned.x - before.x) <= 1 && Math.abs(returned.y - before.y) <= 1, 'closing restores the exact reading scroll');
          assert.equal(await page.evaluate(() => document.body.style.position), '');
          assert.equal(await page.locator('.wr-reader-toolbar').evaluate(node => Boolean(node.closest('[inert]'))), false);
          await page.screenshot({ path: resolve(artifacts, `${engine}-${viewport.width}-returned.png`), animations: 'disabled' });
          if (viewport.width < 640) {
            for (const destination of [fixture.links.source, fixture.links.character]) {
              await toolbarEntry(page).click();
              await (await pinnedLink(evidence(page).locator('.evidence-content'), destination, manuscript, workspace.origin)).click();
              if (destination === fixture.links.source) {
                await page.locator('#passage-body mark').waitFor();
                assert.equal(await page.locator('#passage-body mark').innerText(), fixture.sourcePin.excerpt);
              } else {
                await page.getByText(fixture.character.persona, { exact: true }).waitFor();
                assert.equal(await page.getByText(/她在对岸学会修船/).count(), 0);
              }
              assert.equal(await page.evaluate(() => document.body.style.position), '');
              assert.equal(await page.locator('[inert]').count(), 0, 'navigation releases the mobile background');
              await page.getByRole('link', { name: '返回原稿', exact: true }).click();
              await page.waitForURL(workspace.origin + manuscript);
              await page.waitForFunction(y => document.activeElement?.matches('#passage-body mark') && Math.abs(scrollY - y) <= 1, before.y);
            }
          }
          for (const [draft, excerpt] of [[fixture.revised, null], [fixture.drafts[1], fixture.alternatePin.excerpt], [fixture.drafts[2], null]]) {
            await page.goto(`/drafts/${draft.draftId}?revision=${draft.revision}`);
            await toolbarEntry(page).click();
            await evidence(page).getByText(`${draft.title} · 修订 ${draft.revision}`, { exact: true }).waitFor();
            if (excerpt) await fixed.getByText(excerpt, { exact: true }).waitFor();
            else {
              await evidence(page).getByText('这版稿件还没有已确认的来源记录', { exact: true }).waitFor();
              assert.equal(await evidence(page).locator('.evidence-content').count(), 0);
            }
            assert.equal(await fixed.getByText(fixture.sourcePin.excerpt, { exact: true }).isVisible(), false);
            if (draft === fixture.revised) {
              await page.screenshot({ path: resolve(artifacts, `${engine}-${viewport.width}-revision2-empty.png`), animations: 'disabled' });
              await evidence(page).getByText('查看场景资料', { exact: true }).click();
              await pinnedLink(evidence(page).locator('.evidence-scene-links'), fixture.links.source,
                `/drafts/${draft.draftId}?revision=${draft.revision}`, workspace.origin);
            }
          }
          assert.deepEqual(errors, []);
          results.push({ engine, viewport, panel: box, typography, before, returned, passed: true });
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  const served = await workspace.inspectServedBundle();
  assert.equal(served.sha256, workspace.capturedBuild.bundle.sha256);
  await writeFile(resolve(artifacts, 'manifest.json'), JSON.stringify({
    status: 'passed', build: workspace.capturedBuild, servedBundle: served, results,
    isolation: 'temporary database and frozen frontend bundle',
  }, null, 2));
});
