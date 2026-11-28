import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

function controlContrast(node) {
  const css = getComputedStyle(node);
  const lum = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const a = lum(css.color), b = lum(css.backgroundColor);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test('shared controls keep readable actions and writing typography across lazy-loaded domains', { timeout: 120_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      await t.test(`${engine.name()} mobile fields and primary link colors`, async () => {
        const page = await browser.newPage({ baseURL: workspace.origin, viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
        try {
          await page.goto('/');
          const note = page.getByLabel('此刻想记下什么', { exact: true });
          await note.waitFor();
          const measure = () => note.evaluate(node => {
            const css = getComputedStyle(node);
            return { height: node.clientHeight, scrollHeight: node.scrollHeight, font: parseFloat(css.fontSize),
              line: parseFloat(css.lineHeight), padding: parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) };
          });
          const empty = await measure();
          assert.equal(empty.font, 16, 'mobile text entry avoids zoom-inducing small text');
          assert.ok(empty.height - empty.padding >= empty.line * 2 - 1, JSON.stringify(empty));
          await note.fill(Array.from({ length: 14 }, (_, i) => `第${i + 1}行：雨夜站在岸边。`).join('\n'));
          await page.waitForFunction(() => {
            const node = document.querySelector('#quick-note');
            return node.scrollHeight > node.clientHeight;
          });
          const long = await measure();
          assert.ok(long.height <= long.line * 7 + long.padding, JSON.stringify(long));
          await note.fill('');
          await page.waitForFunction(height => document.querySelector('#quick-note').clientHeight <= height + 1, empty.height);

          // Real shell links retain the CSS of earlier lazy-loaded domains.
          await page.getByRole('link', { name: '查看资料', exact: true }).click();
          await page.locator('.sources-route:not([aria-busy=true])').waitFor();
          const action = page.getByRole('link', { name: '新建资料', exact: true });
          for (const name of ['sources-filter-disclosure', 'sources-type-menu', 'sources-workspace']) {
            const trigger = page.locator(`.${name}>summary`);
            await trigger.click();
            const panel = page.locator(`.${name}>.sources-toolbar-panel`);
            const box = await panel.boundingBox();
            assert.ok(box && box.x >= 0 && box.x + box.width <= 320, JSON.stringify({ name, box }));
            await page.keyboard.press('Escape');
            assert.equal(await trigger.evaluate(node => node.parentElement.open), false);
            assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
          }
          const contrast = await action.evaluate(controlContrast);
          assert.ok(contrast >= 4.5, `primary link contrast ${contrast}`);
          await action.click();
          const sourceBody = page.getByLabel('正文', { exact: true });
          await sourceBody.waitFor();
          assert.ok(await sourceBody.evaluate(node => parseFloat(getComputedStyle(node).fontSize)) >= 16);
          await page.goBack();
          await action.waitFor();
          await page.goBack();
          await note.waitFor();
          const returned = await measure();
          assert.equal(returned.font, 16);
          assert.ok(returned.height - returned.padding >= returned.line * 2 - 1);

          await page.goto(`${fixture.links.project}?view=overview`);
          const newProject = page.getByRole('link', { name: '新建作品', exact: true });
          await newProject.waitFor();
          assert.ok(await newProject.evaluate(controlContrast) >= 4.5, 'workspace link rules preserve primary button contrast');
          await newProject.click();
          await page.getByRole('heading', { name: '新建作品', exact: true }).waitFor();

          await page.goto(`/drafts/${fixture.drafts[0].draftId}?action=revise&revision=1`);
          const writing = page.locator('textarea[name=body]');
          await writing.waitFor();
          const typography = await writing.evaluate(node => ({ size: getComputedStyle(node).fontSize, line: getComputedStyle(node).lineHeight }));
          assert.equal(typography.size, '18px');
          assert.ok(Math.abs(parseFloat(typography.line) - 32.4) < .1, JSON.stringify(typography));
        } finally { await page.close(); }
      });
    } finally { await browser.close(); }
  }
});
