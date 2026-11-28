import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';
import { diagnoseRoute } from './route-diagnostics.mjs';

const artifacts = resolve('frontend/.artifacts/unified-ui/navigation-after-candidate');
const viewports = [
  [chromium, 'chromium-1280', { width: 1280, height: 800 }, false],
  [chromium, 'chromium-390', { width: 390, height: 844 }, true],
  [webkit, 'webkit-320', { width: 320, height: 640 }, true],
];

function pathOf(url) {
  const value = new URL(url);
  return value.pathname + value.search + value.hash;
}

function withReturn(path, returnTo, origin) {
  const url = new URL(path, origin);
  url.searchParams.set('returnTo', returnTo);
  return pathOf(url.href);
}

async function waitForReader(page, body) {
  await page.locator('#main').waitFor({ state: 'visible' });
  await page.locator('#passage-body').waitFor({ state: 'visible' });
  await page.waitForFunction(expected => document.querySelector('#passage-body')?.textContent === expected, body);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function waitForRoute(page, pathname) {
  await page.waitForURL(url => new URL(url).pathname === pathname);
  await page.locator('.manuscript-library').waitFor({ state: 'attached' });
  await page.locator('#main').waitFor({ state: 'visible' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function navigationSnapshot(page) {
  return page.locator('.manuscript-library').evaluate(element => {
    if (!element.dataset.unifiedNavigationInstance) {
      element.dataset.unifiedNavigationInstance = crypto.randomUUID();
    }
    const brand = element.querySelector('.library-brand');
    const style = brand && getComputedStyle(brand);
    const box = element.getBoundingClientRect();
    return {
      instance: element.dataset.unifiedNavigationInstance,
      visible: element.checkVisibility(),
      width: box.width,
      brand: brand ? {
        family: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        lineHeight: style.lineHeight,
      } : null,
      taskTop: element.querySelector('.library-footer a[href="/jobs"]')?.getBoundingClientRect().top,
      settingsTop: element.querySelector('.library-footer a[href="/settings"]')?.getBoundingClientRect().top,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
    };
  });
}

async function assertNoHorizontalOverflow(page) {
  const width = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert.ok(width.content <= width.viewport + 1,
    `horizontal overflow at ${width.viewport}px, content is ${width.content}px`);
}

async function assertNavigationContract(page, fixture, baseline, { mobileOpen = false } = {}) {
  const nav = page.locator('.manuscript-library');
  assert.equal(await nav.getAttribute('id'), 'library-navigation', 'the shared library keeps the navigation landmark id');
  assert.equal(await nav.getAttribute('aria-label'), '资料库', 'the shared navigation landmark keeps its label');
  if (mobileOpen) await nav.waitFor({ state: 'visible' });
  else await nav.waitFor();
  const current = await navigationSnapshot(page);
  assert.equal(current.instance, baseline.instance, 'the library sidebar keeps its DOM instance');
  assert.ok(current.brand, 'the shared library brand remains mounted');
  assert.deepEqual(current.brand, baseline.brand, 'the library brand typography stays shared');
  assert.ok(Math.abs(current.taskTop - baseline.taskTop) <= 1, 'the task entry stays at the same position within subpixel rounding');
  assert.ok(Math.abs(current.settingsTop - baseline.settingsTop) <= 1, 'the settings entry stays at the same position within subpixel rounding');
  assert.equal(await nav.getByRole('link', { name: 'Sth 首页', exact: true }).getAttribute('href'), '/',
    'the library brand always links to the home page');
  if (mobileOpen || current.visible) assert.equal(current.width, baseline.width, 'the library sidebar width stays shared');

  const links = await nav.locator('a').evaluateAll(elements => elements.map(element => element.textContent.trim()));
  const required = ['最近写过', '日记', '全部文稿', '角色', '资料', '任务', '设置'];
  let previous = -1;
  for (const label of required) {
    const index = links.findIndex((text, position) => position > previous && text === label);
    assert.ok(index > previous, `shared navigation is missing or reorders ${label}: ${links.join(' / ')}`);
    previous = index;
  }

  const tree = nav.getByRole('navigation', { name: '作品与章节' });
  await tree.getByText(fixture.project.title, { exact: true }).waitFor();
  await tree.getByText(fixture.chapters[1].title, { exact: true }).waitFor();
  const projectToggle = nav.getByRole('button', { name: new RegExp(fixture.project.title) });
  assert.equal(await projectToggle.getAttribute('aria-expanded'), 'true', 'the expanded project tree survives auxiliary navigation');

  const create = nav.locator('.library-create');
  assert.equal(await create.count(), 1, 'the library create control is present');
  assert.equal((await create.innerText()).trim(), '新建');
  const beforeCreate = links.join('|');
  await create.click();
  assert.equal((await nav.locator('a').allTextContents()).map(text => text.trim()).join('|'), beforeCreate,
    'opening 新建 does not alter the navigation links');
  await page.keyboard.press('Escape');
  await assertNoHorizontalOverflow(page);
}

async function openAuxiliaryNavigation(page) {
  const button = page.getByRole('button', { name: '打开资料库导航', exact: true });
  await button.waitFor({ state: 'visible' });
  const before = await page.evaluate(() => ({ href: location.href, length: history.length, scrollY: window.scrollY }));
  await button.click();
  await page.locator('.manuscript-library').waitFor({ state: 'visible' });
  assert.equal(page.url(), before.href, 'opening the auxiliary mobile sidebar keeps the URL');
  assert.equal(await page.evaluate(() => history.length), before.length, 'opening the auxiliary mobile sidebar is temporary state');
  return before;
}

async function ensureAuxiliaryNavigation(page) {
  if (!(await page.locator('.manuscript-library').isVisible())) return openAuxiliaryNavigation(page);
}

async function closeAuxiliaryNavigation(page, expectedUrl, before) {
  const close = page.getByRole('button', { name: '返回当前页面', exact: true });
  await close.waitFor({ state: 'visible' });
  await close.click();
  await page.locator('.manuscript-library').waitFor({ state: 'hidden' });
  assert.equal(pathOf(page.url()), expectedUrl, 'closing the mobile sidebar stays on the current auxiliary page');
  if (before) {
    const restored = await page.evaluate(() => ({
      scrollY: window.scrollY,
      active: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim(),
    }));
    assert.equal(restored.scrollY, before.scrollY, 'closing the mobile sidebar restores window scroll');
    assert.equal(restored.active, '打开资料库导航', 'closing the mobile sidebar restores the toolbar focus');
  }
}

async function clickAuxiliaryLink(page, label, pathname, mobile) {
  if (mobile && !(await page.locator('.manuscript-library').isVisible())) await openAuxiliaryNavigation(page);
  const link = page.locator('.manuscript-library').getByRole('link', { name: label, exact: true });
  const href = await link.getAttribute('href');
  assert.ok(href, `${label} has a destination`);
  const expected = pathOf(new URL(href, page.url()).href);
  await diagnoseRoute(page, async () => {
    await link.click();
    await waitForRoute(page, pathname);
    if (pathname === '/characters') await page.locator('.characters-route').waitFor();
    if (pathname === '/sources') await page.locator('.sources-domain').waitFor();
    if (pathname === '/settings') await page.getByRole('heading', { name: '连接设置', exact: true }).waitFor();
  });
  assert.equal(new URL(page.url()).pathname, pathname, `${label} lands on ${pathname}`);
  assert.equal(pathOf(page.url()), expected, `${label} preserves its exact path and query`);
  return expected;
}

async function assertAuxiliaryFrame(page) {
  assert.equal(await page.locator('.manuscript-frame > #main').count(), 1, 'auxiliary pages retain the frame main DOM');
  assert.equal(await page.locator('.manuscript-frame > .manuscript-sheets').isVisible(), false,
    'auxiliary pages hide the manuscript list column');
  assert.equal(await page.locator('.manuscript-frame > #main').isVisible(), true,
    'auxiliary page content remains available in the main region');
}

async function openReaderLibrary(page) {
  await page.getByRole('button', { name: '返回文稿列表', exact: true }).click();
  await page.locator('.manuscript-sheets').waitFor({ state: 'visible' });
  await page.locator('.ms-sheets-bar').getByRole('button', { name: '资料库', exact: true }).click();
  await page.locator('.manuscript-library').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.manuscript-frame')?.dataset.pane === 'library');
}

async function focusAndScrollReader(page) {
  return page.evaluate(() => {
    const mark = document.querySelector('#passage-body mark');
    if (!mark) throw new Error('the selected old passage is missing');
    mark.setAttribute('tabindex', '-1');
    window.scrollBy({ top: mark.getBoundingClientRect().top - Math.min(220, innerHeight / 3), behavior: 'instant' });
    mark.focus({ preventScroll: true });
    const rect = mark.getBoundingClientRect();
    return { scrollY: window.scrollY, active: mark.textContent, visible: rect.top >= 0 && rect.bottom <= innerHeight };
  });
}

async function assertReturnedReader(page, fixture, originalUrl, position) {
  await waitForReader(page, fixture.bodies.old);
  assert.equal(pathOf(page.url()), originalUrl, 'browser Back returns to the exact old-draft URL');
  assert.equal(new URL(page.url()).searchParams.get('revision'), '1', 'the selected old revision remains pinned');
  assert.equal(await page.locator('#passage-body').textContent(), fixture.bodies.old, 'the old draft body remains unchanged');
  const returned = await page.evaluate(() => ({
    scrollY: window.scrollY,
    active: document.activeElement?.textContent,
    mark: document.querySelector('#passage-body mark')?.textContent,
  }));
  assert.equal(returned.active, position.active, 'the reading focus returns to the selected passage');
  assert.equal(returned.mark, position.active, 'the selected passage remains marked');
  assert.ok(position.visible, 'the saved passage was visible before leaving the reader');
  assert.ok((await page.locator('#passage-body mark').boundingBox()).y >= 0, 'the selected passage is visible after returning');
  assert.ok(Math.abs(returned.scrollY - position.scrollY) <= 2,
    `window scroll returns to ${position.scrollY}px, got ${returned.scrollY}px`);
}

async function assertNoManuscriptListReads(operations) {
  const listReads = operations.filter(operation => /^(?:manuscript\.recent|scene\.list|draft\.list|diary\.list)$/.test(operation));
  assert.deepEqual(listReads, [], `auxiliary navigation triggered manuscript list reads: ${listReads.join(', ')}`);
}

test('one library navigation survives manuscript to auxiliary pages and browser Back', { timeout: 240_000 }, async t => {
  await mkdir(artifacts, { recursive: true });
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  const manifest = {
    status: 'after-candidate',
    note: 'Generated from the isolated snapshot build used by this test run.',
    build: workspace.capturedBuild,
    screenshots: [],
    cases: viewports.map(([, name, viewport]) => ({ name, viewport, status: 'pending' })),
  };
  await mkdir(artifacts, { recursive: true });
  t.after(() => writeFile(resolve(artifacts, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  const chapterHref = `/projects/${fixture.project.projectId}?chapterId=${fixture.chapters[1].chapterId}&selected=${fixture.scene.sceneId}`;
  const originalUrl = withReturn(fixture.links.oldPassage, chapterHref, workspace.origin);

  for (const [engine, name, viewport, mobile] of viewports) {
    await t.test(name, async subtest => {
      const browser = await engine.launch();
      subtest.after(() => browser.close());
      const context = await browser.newContext({
        baseURL: workspace.origin,
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
        locale: 'zh-CN',
      });
      subtest.after(() => context.close());
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      page.setDefaultNavigationTimeout(15_000);
      const browserErrors = [];
      const operations = [];
      const treeOperations = [];
      page.on('pageerror', error => browserErrors.push(error.message));
      page.on('request', request => {
        if (!request.url().endsWith('/api/web/invoke')) return;
        try {
          const operation = request.postDataJSON().operationId;
          operations.push(operation);
          if (operation === 'project.list' || operation === 'chapter.list') treeOperations.push(operation);
        } catch { /* The browser request has no JSON body. */ }
      });

      await page.goto(originalUrl);
      await waitForReader(page, fixture.bodies.old);
      const position = await focusAndScrollReader(page);
      const readerScreenshot = `${name}-reader-after-candidate.png`;
      await page.screenshot({ path: resolve(artifacts, readerScreenshot), animations: 'disabled' });
      manifest.screenshots.push(readerScreenshot);

      if (mobile) {
        await openReaderLibrary(page);
      } else {
        await page.locator('.manuscript-library').waitFor({ state: 'visible' });
      }
      const baseline = await navigationSnapshot(page);
      await assertNavigationContract(page, fixture, baseline, { mobileOpen: mobile });
      const libraryScreenshot = `${name}-library-after-candidate.png`;
      await page.screenshot({ path: resolve(artifacts, libraryScreenshot), animations: 'disabled' });
      manifest.screenshots.push(libraryScreenshot);
      const historyBeforeAuxiliary = await page.evaluate(() => history.length);
      operations.length = 0;
      treeOperations.length = 0;

      const roleHref = await clickAuxiliaryLink(page, '角色', '/characters', mobile);
      await assertAuxiliaryFrame(page);
      const roleNavigation = mobile ? await ensureAuxiliaryNavigation(page) : undefined;
      await assertNavigationContract(page, fixture, baseline, { mobileOpen: mobile });
      const roleScreenshot = `${name}-characters-after-candidate.png`;
      await page.screenshot({ path: resolve(artifacts, roleScreenshot), animations: 'disabled' });
      manifest.screenshots.push(roleScreenshot);
      await assertNoManuscriptListReads(operations);

      if (mobile) {
        const samePageHistory = await page.evaluate(() => history.length);
        await page.locator('.manuscript-library').getByRole('link', { name: '角色', exact: true }).click();
        assert.equal(pathOf(page.url()), roleHref, 'the current auxiliary link stays on the same URL');
        assert.equal(await page.evaluate(() => history.length), samePageHistory, 'same-page navigation does not push history');
        await page.locator('.manuscript-library').waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '打开资料库导航',
          'same-page navigation closes the temporary sidebar and restores toolbar focus');
        assert.equal(await page.evaluate(() => window.scrollY), roleNavigation.scrollY,
          'same-page navigation restores the window scroll');
      }

      const sourceHref = await clickAuxiliaryLink(page, '资料', '/sources', mobile);
      await assertAuxiliaryFrame(page);
      const sourceNavigation = mobile ? await ensureAuxiliaryNavigation(page) : undefined;
      await assertNavigationContract(page, fixture, baseline, { mobileOpen: mobile });
      const sourceScreenshot = `${name}-sources-after-candidate.png`;
      await page.screenshot({ path: resolve(artifacts, sourceScreenshot), animations: 'disabled' });
      manifest.screenshots.push(sourceScreenshot);
      await assertNoManuscriptListReads(operations);

      const settingsHref = await clickAuxiliaryLink(page, '设置', '/settings', mobile);
      await assertAuxiliaryFrame(page);
      const settingsNavigation = mobile ? await ensureAuxiliaryNavigation(page) : undefined;
      await assertNavigationContract(page, fixture, baseline, { mobileOpen: mobile });
      const settingsScreenshot = `${name}-settings-after-candidate.png`;
      await page.screenshot({ path: resolve(artifacts, settingsScreenshot), animations: 'disabled' });
      manifest.screenshots.push(settingsScreenshot);
      await assertNoManuscriptListReads(operations);
      assert.equal(settingsHref, '/settings', 'the global settings destination remains exact');
      assert.ok(historyBeforeAuxiliary < await page.evaluate(() => history.length), 'auxiliary links use browser history');
      assert.equal(treeOperations.filter(operation => operation === 'project.list').length, 2,
        'only the character and source project selectors read projects; the mounted library reuses its tree');
      assert.ok(treeOperations.filter(operation => operation === 'chapter.list').length <= 1,
        'the chapter tree is requested at most once while visiting auxiliary pages');

      if (mobile) await closeAuxiliaryNavigation(page, settingsHref, settingsNavigation);
      await page.goBack();
      await waitForRoute(page, '/sources');
      await page.goBack();
      await waitForRoute(page, '/characters');
      await page.goBack();
      if (mobile) {
        await page.waitForFunction(() => document.querySelector('.manuscript-frame')?.dataset.pane === 'library');
        await page.goBack();
        await page.waitForFunction(() => document.querySelector('.manuscript-frame')?.dataset.pane === 'sheets');
        await page.goBack();
        await page.waitForFunction(() => document.querySelector('.manuscript-frame')?.dataset.pane === 'editor');
      }
      await waitForReader(page, fixture.bodies.old);
      await assertReturnedReader(page, fixture, originalUrl, position);
      await assertNoHorizontalOverflow(page);
      const returnedScreenshot = `${name}-reader-return-after-candidate.png`;
      await page.screenshot({ path: resolve(artifacts, returnedScreenshot), animations: 'disabled' });
      manifest.screenshots.push(returnedScreenshot);
      assert.deepEqual(browserErrors, [], 'the unified navigation flow has no uncaught browser errors');
      manifest.cases.find(item => item.name === name).status = 'passed';
    });
  }
});
