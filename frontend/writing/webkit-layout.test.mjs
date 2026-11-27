import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { webkit } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

const artifacts = resolve(process.env.STH_WRITING_WEBKIT_ARTIFACTS ?? 'frontend/.artifacts/writing-reader/webkit-layout-final');

function geometry() {
  const describe = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName, id: element.id, className: element.className,
      left: rect.left, right: rect.right, width: rect.width,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      display: style.display, gridTemplateColumns: style.gridTemplateColumns,
      minInlineSize: style.minInlineSize, maxInlineSize: style.maxInlineSize,
      contain: style.contain, overflowX: style.overflowX,
    };
  };
  const elements = [...document.querySelectorAll('.writing-route *')]
    .filter(element => element.getClientRects().length > 0);
  return {
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    scrollX,
    overflowX: {
      html: getComputedStyle(document.documentElement).overflowX,
      body: getComputedStyle(document.body).overflowX,
      writing: getComputedStyle(document.querySelector('.writing-route')).overflowX,
    },
    protrudingElements: elements.filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.right > innerWidth + 1 || rect.left < -1;
    }).map(describe),
    overflowingContainers: elements.filter(element =>
      element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible',
    ).map(describe),
    controls: [...document.querySelectorAll('.wr-version-bar, .wr-version-bar > label, .wr-version-bar select, .wr-compare-form, .wr-compare-form > div, .wr-compare-form select')].map(describe),
  };
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

test('real WebKit manuscript layouts fit 320px and 390px before and after interaction', { timeout: 180_000 }, async t => {
  await mkdir(artifacts, { recursive: true });
  const report = { engine: 'webkit', startedAt: new Date().toISOString(), status: 'running', cases: [] };
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  let browser;
  try {
    report.build = workspace.capturedBuild;
    const fixture = await createManuscriptFixture(workspace.invoke);
    browser = await webkit.launch();
    report.browserVersion = browser.version();
    const paths = [
      ['scene', fixture.links.scene],
      ['draft', fixture.links.oldDraft],
      ['compare', fixture.links.compare],
      ['edit', `${fixture.links.latestDraft}?edit=1`],
    ];
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }]) {
      for (const [name, href] of paths) {
        await t.test(`${name} at ${viewport.width}px`, async () => {
          const context = await browser.newContext({
            baseURL: workspace.origin, viewport, isMobile: true, hasTouch: true, locale: 'zh-CN',
          });
          const record = { name, viewport, href, measurements: [], pageErrors: [] };
          report.cases.push(record);
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          page.on('pageerror', error => record.pageErrors.push(error.message));
          async function check(state) {
            await settle(page);
            await page.evaluate(() => window.scrollTo(10_000, scrollY));
            const horizontalScroll = await page.evaluate(() => scrollX);
            await page.evaluate(() => window.scrollTo(0, scrollY));
            const dimensions = await page.evaluate(geometry);
            dimensions.scrollX = horizontalScroll;
            const screenshot = `${viewport.width}-${name}-${state}.png`;
            record.measurements.push({ state, url: page.url(), ...dimensions, screenshot });
            await page.screenshot({ path: resolve(artifacts, screenshot), animations: 'disabled' });
            console.log(`webkit ${viewport.width} ${name} ${state} ${dimensions.document}/${dimensions.viewport}`);
            assert.equal(dimensions.viewport, viewport.width);
            assert.equal(dimensions.document, viewport.width, `document ${dimensions.document}px exceeds ${viewport.width}px; see ${screenshot} and manifest.json`);
            assert.ok(dimensions.body <= viewport.width, `body ${dimensions.body}px exceeds ${viewport.width}px`);
            assert.equal(dimensions.scrollX, 0, 'the document cannot scroll sideways');
            assert.deepEqual(dimensions.protrudingElements, [], 'writing border boxes stay in the viewport');
            for (const overflow of Object.values(dimensions.overflowX)) {
              assert.ok(!['hidden', 'clip'].includes(overflow), 'the page must fit without root overflow clipping');
            }
          }
          try {
            await page.goto(href);
            await page.locator(name === 'compare' ? '.wr-compare-form' : '.wr-version-bar').waitFor();
            if (name === 'edit') await page.getByRole('textbox', { name: '正文', exact: true }).waitFor();
            await check('initial');

            if (name === 'compare') {
              await page.getByRole('button', { name: '右稿', exact: true }).click();
              assert.ok(await page.locator('[data-side="right"]').isVisible());
              assert.equal(await page.locator('[data-side="left"]').isVisible(), false);
              await check('right-side');
              await page.locator('#wr-right').selectOption(`${fixture.revised.draftId}@${fixture.revised.revision}`);
              await page.getByRole('button', { name: '对照', exact: true }).click();
              await page.waitForURL(url => url.searchParams.get('right') === `${fixture.revised.draftId}@${fixture.revised.revision}`);
              await page.locator('.wr-compare-form').waitFor();
              assert.equal(await page.locator('#wr-right').inputValue(), `${fixture.revised.draftId}@${fixture.revised.revision}`);
              await check('versions-selected');
            } else if (name === 'scene') {
              await page.getByRole('combobox', { name: '切换稿件', exact: true }).selectOption(`${fixture.drafts[1].draftId}@1`);
              await page.waitForURL(url => url.pathname === `/drafts/${fixture.drafts[1].draftId}`);
              await page.locator('#passage-body').waitFor();
              assert.equal(await page.locator('.wr-toolbar-title').innerText(), fixture.drafts[1].title);
              await check('draft-selected');
            } else if (name === 'draft') {
              await page.getByRole('combobox', { name: '切换稿件版本', exact: true }).selectOption(String(fixture.revised.revision));
              await page.waitForURL(url => url.searchParams.get('revision') === String(fixture.revised.revision));
              await page.locator('#passage-body').waitFor();
              assert.equal(await page.locator('#passage-body').textContent(), fixture.bodies.latest);
              await check('version-selected');
            } else {
              const body = page.getByRole('textbox', { name: '正文', exact: true });
              const text = `${await body.inputValue()}\n${'中文长段落与连续英文LongUnbrokenManuscriptTitle'.repeat(12)}`;
              await page.getByRole('textbox', { name: '标题', exact: true }).fill('连续英文LongUnbrokenManuscriptTitle'.repeat(8));
              await body.fill(text);
              await page.getByRole('button', { name: '返回阅读', exact: true }).click();
              await page.locator('#passage-body').waitFor();
              await page.getByRole('button', { name: '编辑', exact: true }).click();
              assert.equal(await body.inputValue(), text, 'switching modes restores the unsaved text');
              await page.evaluate(() => window.scrollTo(0, 0));
              await check('editing-restored');
            }

            await page.locator('.writing-route > details, .wr-compare-actions').evaluateAll(details => {
              for (const element of details) element.open = true;
            });
            const details = page.locator('.writing-route > details, .wr-comparison article:visible .wr-compare-actions');
            await details.first().scrollIntoViewIfNeeded();
            await check('details-expanded');
            if (name !== 'compare') {
              await page.getByRole('button', { name: '更多', exact: true }).click();
              await page.locator('.wr-more-menu').waitFor();
              await check('more-open');
            }
            assert.deepEqual(record.pageErrors, []);
            record.status = 'passed';
          } catch (error) {
            record.status = 'failed';
            record.error = error.message;
            throw error;
          } finally {
            await context.close();
          }
        });
      }
    }
    report.status = report.cases.every(record => record.status === 'passed') ? 'passed' : 'failed';
  } finally {
    if (report.status === 'running') report.status = 'failed';
    report.completedAt = new Date().toISOString();
    await writeFile(resolve(artifacts, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
    await browser?.close();
    await workspace.close();
  }
});
