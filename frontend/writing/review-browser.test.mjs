import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

const artifacts = resolve('frontend/.artifacts/review');

test('comparison and adoption keep exact draft identity, context and return paths', { timeout: 120_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir(artifacts, { recursive: true });

  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await t.test(`${width}px review and explicit adoption`, async t => {
      const practice = fixture.practices[width === 1280 ? 'chromium-desktop' : 'chromium-phone'];
      await workspace.invoke('scene.adopt', {
        sceneId: practice.scene.sceneId,
        expectedRevision: practice.scene.revision,
        draftId: practice.drafts[0].draftId,
        draftRevision: practice.drafts[0].revision,
      });
      const comparePath = `/scenes/${practice.scene.sceneId}?action=compare&left=${practice.drafts[0].draftId}@1&right=${practice.drafts[1].draftId}@1`;
      const context = await browser.newContext({
        baseURL: workspace.origin,
        viewport: { width, height },
        locale: 'zh-CN',
        isMobile: width < 640,
        hasTouch: width < 640,
      });
      t.after(() => context.close());
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));

      await page.goto(comparePath);
      await page.locator('.wr-review-compare').waitFor();
      assert.equal(await page.locator('.wr-reader-heading > a').count(), 1);
      assert.equal(await page.locator('.wr-compare-meta > span:first-child').count(), 2);
      assert.match(await page.locator('.wr-diff-key').nth(0).innerText(), /删[\s\S]*左稿删去/);
      assert.match(await page.locator('.wr-diff-key').nth(1).innerText(), /增[\s\S]*右稿新增/);
      assert.match(await page.locator('.wr-diff-key').nth(2).innerText(), /—[\s\S]*无对应段/);
      const leftArticle = page.getByRole('article', { name: '左稿', exact: true });
      assert.equal(await leftArticle.locator('.wr-review-draft-title').innerText(), `左稿 · ${practice.drafts[0].title} · 第 1 版`);
      const rightArticle = page.getByRole('article', { name: '右稿', exact: true });
      if (width < 640) {
        await page.getByRole('button', { name: '右稿', exact: true }).click();
        await rightArticle.waitFor();
      }
      assert.equal(await rightArticle.locator('.wr-review-draft-title').innerText(), `右稿 · ${practice.drafts[1].title} · 第 1 版`);
      await page.screenshot({ path: resolve(artifacts, `review-${width}-compare.png`), animations: 'disabled', fullPage: true });

      const compareAddress = new URL(page.url());
      await rightArticle.locator('.wr-compare-actions summary').click();
      const chooseDraft = page.getByRole('link', { name: '采纳右稿', exact: true });
      const adoptionHref = new URL(await chooseDraft.getAttribute('href'), workspace.origin);
      const adoptionReturn = adoptionHref.searchParams.get('returnTo');
      assert.equal(adoptionReturn, compareAddress.pathname + compareAddress.search);
      await chooseDraft.click();

      await page.locator('.wr-review-adopt').waitFor();
      assert.match(await page.locator('.wr-review-scope').innerText(), /主线/);
      assert.equal(await page.getByRole('button', { name: '采纳候选稿', exact: true }).isVisible(), true);
      const target = page.getByRole('region', { name: '即将采用的稿件', exact: true });
      assert.equal(await target.isVisible(), true);
      assert.equal(await page.locator('.wr-review-current summary').innerText(), `已有采用稿 · ${practice.drafts[0].title} · 第 1 版`);
      const readingOrder = await page.evaluate(() => ({
        adopted: document.querySelector('.wr-review-current-summary').getBoundingClientRect().top,
        confirmation: document.querySelector('.wr-review-adopt-form button[type="submit"]').getBoundingClientRect().top,
        target: document.querySelector('[aria-label="即将采用的稿件"]').getBoundingClientRect().top,
      }));
      assert.ok(readingOrder.adopted < readingOrder.target, JSON.stringify(readingOrder));
      assert.ok(readingOrder.confirmation < readingOrder.target, JSON.stringify(readingOrder));
      assert.equal(await page.locator('.wr-review-adopt > a').getAttribute('href'), adoptionReturn);
      const currentHref = new URL(await page.locator('.wr-review-current a').getAttribute('href'), workspace.origin);
      assert.equal(currentHref.searchParams.get('returnTo'), new URL(page.url()).pathname + new URL(page.url()).search, currentHref.href);
      await page.locator('.wr-review-current summary').click();
      const adoptedBody = await workspace.invoke('draft.read', { draftId: practice.drafts[0].draftId, revision: 1 });
      assert.equal(await page.locator('.wr-review-current .wr-prose').innerText(), adoptedBody.body);
      await page.screenshot({ path: resolve(artifacts, `review-${width}-adopt.png`), animations: 'disabled', fullPage: true });

      await page.getByRole('button', { name: '采纳候选稿', exact: true }).click();
      await page.getByRole('heading', { name: practice.scene.title, exact: true }).waitFor();
      const adopted = await workspace.invoke('scene.read', { sceneId: practice.scene.sceneId });
      assert.equal(adopted.adopted.draftId, practice.drafts[1].draftId);
      assert.equal(adopted.adopted.revision, practice.drafts[1].revision);
      assert.deepEqual(errors, []);
    });
  }
});
