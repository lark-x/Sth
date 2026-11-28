import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace, writeJson } from '../../scripts/manuscript-fixture.mjs';
import { assertFitsViewport } from '../../tests/browser/harness.mjs';

const artifacts = resolve('frontend/.artifacts/home-diary');
const recentKey = 'sth:manuscripts:recent:v1';
const button = (page, name) => page.getByRole('button', { name, exact: true });
const navigation = page => page.locator('#library-navigation');
const quick = page => page.getByLabel('此刻想记下什么', { exact: true });
const diaryReady = page => page.locator('.diary-route[aria-busy="false"]').waitFor();

async function settled(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function homeReady(page) {
  await page.locator('.sth-manuscript-link').first().waitFor();
  await settled(page);
}

async function navigationClosed(page) {
  await page.waitForFunction(() => document.querySelector('.manuscript-frame')?.getAttribute('data-pane') !== 'library' &&
    document.querySelector('.sth-library-toggle')?.getAttribute('aria-expanded') === 'false');
}

async function capture(page, name) {
  await assertFitsViewport(page);
  await page.screenshot({ path: resolve(artifacts, `${name}.png`), animations: 'disabled' });
}

test('home, global navigation and diary share a compact responsive writing shell', { timeout: 180_000 }, async t => {
  await mkdir(artifacts, { recursive: true });
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  const cases = [];

  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    t.after(() => browser.close());
    const dimensions = engine === chromium ? [[1280, 800], [768, 1024], [390, 844], [320, 640]] : [[390, 844]];
    for (const [width, height] of dimensions) {
      await t.test(`${engine.name()} ${width}x${height} first viewport, navigation and diary draft`, async t => {
        const context = await browser.newContext({ baseURL: workspace.origin, viewport: { width, height }, locale: 'zh-CN' });
        t.after(() => context.close());
        const page = await context.newPage();
        page.setDefaultTimeout(8_000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
        await page.addInitScript(({ key, draft, diary }) => localStorage.setItem(key, JSON.stringify([
          { kind: 'draft', id: draft.draftId, sceneId: draft.sceneId, title: draft.title,
            href: `/drafts/${draft.draftId}?revision=1`, updatedAt: Date.now() + 1000 },
          { kind: 'diary', id: diary.noteId, title: diary.title,
            href: `/diaries/${diary.noteId}?edit=1`, updatedAt: Date.now() + 500 },
        ])), { key: recentKey, draft: fixture.drafts[0], diary: fixture.diary });
        const homeReads = [];
        page.on('request', request => {
          if (request.url().endsWith('/api/web/invoke') && new URL(page.url()).pathname === '/') {
            homeReads.push(request.postDataJSON().operationId);
          }
        });
        await page.goto('/');
        await homeReady(page);
        assert.ok(!homeReads.some(operation => /^(draft|scene|diary)\.read$/.test(operation)), 'home adds no per-manuscript body reads');
        const prefix = `${engine.name()}-${width}`;
        const first = page.locator('.sth-manuscript-link').first();
        assert.equal(await first.locator('h3').innerText(), fixture.drafts[0].title);
        assert.match(await first.innerText(), /第 1 版/);
        const firstBox = await first.boundingBox();
        const inputBox = await quick(page).boundingBox();
        const saveBox = await button(page, '记下来').boundingBox();
        assert.ok(inputBox.y >= 0 && inputBox.y + inputBox.height < height, 'quick input fits in the first viewport');
        assert.ok(saveBox.y + saveBox.height < height, 'quick save fits in the first viewport');
        assert.ok(firstBox.y + firstBox.height < height, `first recent manuscript fits at ${firstBox.y + firstBox.height}px`);
        if (width < 640) {
          assert.equal((await page.locator('.sth-mobile-toolbar').boundingBox()).height, 60);
          assert.equal(await page.locator('.manuscript-library').isVisible(), false);
          const toggle = await button(page, '打开资料库导航').boundingBox();
          assert.ok(toggle.width >= 44 && toggle.height >= 44);
        } else {
          assert.equal((await page.locator('.manuscript-library').boundingBox()).width, 224);
          assert.equal(await page.locator('.sth-mobile-toolbar').isVisible(), true);
          assert.equal(await page.locator('.sth-library-toggle').isVisible(), false);
        }
        await capture(page, `${prefix}-home`);
        const unfinished = '先留在首页，等回来的时候继续写。';
        await quick(page).fill(unfinished);

        if (width < 640) {
          const historyLength = await page.evaluate(() => history.length);
          await button(page, '打开资料库导航').click();
          assert.equal(await page.locator('.sth-library-toggle').getAttribute('aria-expanded'), 'true');
          assert.equal(await page.locator('.manuscript-frame').getAttribute('data-pane'), 'library');
          assert.equal(await navigation(page).evaluate(element => element.tagName), 'ASIDE');
          assert.equal(await page.getByRole('dialog').count(), 0, 'the shared library is not a dialog');
          assert.equal(await navigation(page).getAttribute('inert'), null);
          assert.equal(await page.evaluate(() => history.length), historyLength, 'opening the auxiliary pane does not push history');
          assert.equal(await button(page, '返回当前页面').evaluate(element => element === document.activeElement), true);
          assert.deepEqual(await navigation(page).locator('.library-brand, .library-primary > .library-link, .library-resources > .library-link, .library-footer > .library-link').evaluateAll(elements =>
            elements.map(element => element.textContent.trim()).filter(Boolean)),
          ['Sth', '最近写过', '日记', '全部文稿', '角色', '资料', '任务', '设置']);
          await capture(page, `${prefix}-navigation`);
          await page.keyboard.press('Escape');
          await navigationClosed(page);
          assert.equal(await page.locator('.sth-library-toggle').getAttribute('aria-expanded'), 'false');
          assert.equal(await button(page, '打开资料库导航').evaluate(element => element === document.activeElement), true);
          assert.equal(await quick(page).inputValue(), unfinished);
          await button(page, '打开资料库导航').click();
          await button(page, '返回当前页面').click();
          await navigationClosed(page);
          assert.equal(await button(page, '打开资料库导航').evaluate(element => element === document.activeElement), true);

          await page.evaluate(() => scrollTo(0, 280));
          const top = await page.evaluate(() => scrollY);
          assert.ok(top > 0);
          await button(page, '打开资料库导航').evaluate(element => element.focus({ preventScroll: true }));
          await page.keyboard.press('Enter');
          await navigation(page).waitFor();
          await page.mouse.move(width / 2, 250);
          await page.mouse.wheel(0, 450);
          await page.waitForTimeout(250);
          await page.keyboard.press('Escape');
          await navigationClosed(page);
          assert.equal(await page.evaluate(() => scrollY), top, 'closing navigation restores the exact home scroll');
          assert.equal(await button(page, '打开资料库导航').evaluate(element => element === document.activeElement), true);
          assert.equal(await quick(page).inputValue(), unfinished);
          await page.evaluate(() => scrollTo(0, 0));

          for (const [name, path] of [['日记', '/diaries'], ['全部文稿', '/projects'], ['角色', '/characters'], ['资料', '/sources'], ['任务', '/jobs'], ['设置', '/settings']]) {
            await button(page, '打开资料库导航').click();
            await navigation(page).getByRole('link', { name, exact: true }).click();
            await page.waitForURL(workspace.origin + path);
            assert.equal(await page.locator('dialog:modal').count(), 0, 'navigation is not modal');
            if (['角色', '资料', '任务', '设置'].includes(name)) {
              await button(page, '打开资料库导航').click();
              assert.equal(await navigation(page).getByRole('link', { name, exact: true }).getAttribute('aria-current'), 'page');
              await button(page, '返回当前页面').click();
              await navigationClosed(page);
            }
            await page.goBack();
            await homeReady(page);
            assert.equal(await quick(page).inputValue(), unfinished, 'global route round trip retains the quick draft');
          }
          await button(page, '打开资料库导航').click();
          await page.setViewportSize({ width: 768, height: 1024 });
          await page.waitForFunction(() => document.querySelector('.manuscript-frame')?.getAttribute('data-pane') !== 'library');
          assert.equal(await page.locator('.manuscript-library').isVisible(), true);
          await page.setViewportSize({ width, height });
        }

        await first.click();
        await page.locator('#passage-body').waitFor();
        assert.equal(new URL(page.url()).searchParams.get('revision'), '1');
        assert.equal(await page.locator('.sth-mobile-toolbar').count(), 0, 'manuscript has its dedicated toolbar');
        await page.goBack();
        await homeReady(page);
        assert.equal(await quick(page).inputValue(), unfinished);
        await page.goto(fixture.links.diary);
        await diaryReady(page);
        await settled(page);
        assert.equal(await page.locator('.sth-mobile-toolbar').count(), 0, 'diary has its dedicated toolbar');
        assert.equal(await page.locator('.diary-toolbar-revision').innerText(), '第 2 版');
        assert.equal(await page.locator('#diary-supplement > details[open]').count(), 0);
        const reading = await page.locator('.diary-prose').evaluate(element => {
          const style = getComputedStyle(element);
          return { family: style.fontFamily, size: style.fontSize, leading: style.lineHeight };
        });
        assert.equal(reading.size, '18px');
        assert.ok(Math.abs(parseFloat(reading.leading) - 32.4) < .01, '18px body uses 1.8 line height');
        await capture(page, `${prefix}-diary-read`);
        await page.getByRole('link', { name: '编辑', exact: true }).click();
        await diaryReady(page);
        assert.equal(await page.locator('#diary-supplement > details[open]').count(), 0, 'existing citations stay collapsed until requested');
        const editor = page.getByRole('textbox', { name: '正文', exact: true });
        const writing = await editor.evaluate(element => {
          const style = getComputedStyle(element);
          return { family: style.fontFamily, size: style.fontSize, leading: style.lineHeight };
        });
        assert.deepEqual(writing, reading, 'reading and editing use identical body typography');
        const text = `${fixture.diary.body}\n\n还要记得这阵雨。`;
        await editor.fill(text);
        await page.reload();
        await diaryReady(page);
        assert.equal(await editor.inputValue(), text, 'refresh retains the diary draft');
        await capture(page, `${prefix}-diary-edit`);
        await editor.evaluate(element => {
          element.focus({ preventScroll: true });
          element.setSelectionRange(6, 15);
          scrollTo(0, 100);
        });
        const editorTop = await page.evaluate(() => scrollY);
        await button(page, '依据与修订').click();
        await page.locator('#diary-supplement > details[open]').first().waitFor();
        await button(page, '回到正文').click();
        assert.deepEqual(await editor.evaluate(element => ({
          focused: element === document.activeElement, start: element.selectionStart, end: element.selectionEnd, top: scrollY,
        })), { focused: true, start: 6, end: 15, top: editorTop });
        assert.equal(await editor.inputValue(), text);
        cases.push({ engine: engine.name(), width, height, firstRecentBottom: firstBox.y + firstBox.height, body: reading, passed: true });
      });
    }
  }
  await t.test('home reuses only exact diary revisions and keeps candidate metadata without extra reads', async t => {
    const first = await workspace.invoke('diary.create', { title: '桥边的决定', diaryDate: '2026-11-28',
      body: '第一版里，我还留在桥边，想把今天没说完的话留给明天。' });
    const candidates = [];
    for (const title of ['北岸', '南岸']) {
      const scene = await workspace.invoke('scene.create', { title });
      candidates.push(await workspace.invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1,
        title: '桥边的决定', body: `${title}的正文只在打开稿件后读取。` }));
    }
    const current = await workspace.invoke('diary.revise', { noteId: first.noteId, expectedRevision: 1,
      title: first.title, diaryDate: first.diaryDate,
      body: '第二版里，我终于走过桥，沿着河边慢慢回家。\n窗前的灯仍然亮着，想起今天听见的水声，我把这段记下来，等明天再读。' });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ baseURL: workspace.origin, viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(8_000);
    const calls = [];
    page.on('request', request => {
      if (request.url().endsWith('/api/web/invoke')) calls.push(request.postDataJSON().operationId);
    });
    await page.goto('/');
    await homeReady(page);
    const diaryLink = page.locator(`.sth-manuscript-link[href="${first.href}"]`);
    await diaryLink.locator('.sth-manuscript-excerpt').waitFor();
    assert.match(await diaryLink.innerText(), /第 2 版/);
    assert.match(await diaryLink.locator('.sth-manuscript-excerpt').innerText(), /终于走过桥/);
    for (const draft of candidates) {
      const link = page.locator(`.sth-manuscript-link[href="${draft.href}"]`);
      assert.equal(await link.locator('h3').innerText(), draft.title);
      assert.match(await link.innerText(), /第 1 版/);
      assert.equal(await link.locator('.sth-manuscript-excerpt').count(), 0);
      assert.ok(!(await link.innerText()).includes(draft.sceneId), 'technical scene ids never become display copy');
    }
    for (const [width, height] of [[390, 844], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await settled(page);
      const box = await diaryLink.boundingBox();
      assert.ok(box.y + box.height < height, 'the first diary, including its excerpt, fits in the viewport');
      const text = await diaryLink.locator('.sth-manuscript-excerpt').evaluate(element => ({
        height: element.getBoundingClientRect().height, leading: parseFloat(getComputedStyle(element).lineHeight),
      }));
      assert.ok(text.height <= text.leading * 2 + 1, 'the diary excerpt occupies at most two lines');
      await capture(page, `chromium-${width}-home-diary-summary`);
    }
    await page.evaluate(({ key, diary }) => localStorage.setItem(key, JSON.stringify([
      { kind: 'diary', id: diary.noteId, title: diary.title, href: `${diary.href}?revision=1`, updatedAt: Date.now() + 1000 },
    ])), { key: recentKey, diary: first });
    await page.reload();
    await homeReady(page);
    const pinned = page.locator(`.sth-manuscript-link[href="${first.href}?revision=1"]`);
    assert.match(await pinned.innerText(), /第 1 版/);
    assert.equal(await pinned.locator('.sth-manuscript-excerpt').count(), 0, 'a pinned old diary never borrows the latest body');
    await page.route('**/api/web/invoke', route => route.request().postDataJSON().operationId === 'diary.list'
      ? route.fulfill({ status: 200, json: { result: { items: [first] } } }) : route.continue());
    await page.reload();
    await homeReady(page);
    await pinned.locator('.sth-manuscript-excerpt').waitFor();
    assert.match(await pinned.locator('.sth-manuscript-excerpt').innerText(), /还留在桥边/,
      'the explicit href revision takes priority over the current recent record');
    await page.evaluate(key => localStorage.removeItem(key), recentKey);
    await page.reload();
    await homeReady(page);
    assert.match(await diaryLink.innerText(), /第 2 版/);
    assert.equal(await diaryLink.locator('.sth-manuscript-excerpt').count(), 0, 'mismatched list revision remains without an excerpt');
    assert.ok(calls.every(operation => ['chapter.list', 'diary.list', 'manuscript.recent', 'project.list'].includes(operation)),
      `home uses only shared tree and existing list operations: ${calls.join(', ')}`);
    for (const operation of ['chapter.list', 'diary.list', 'manuscript.recent', 'project.list']) {
      assert.ok(calls.includes(operation), `home reads ${operation}`);
    }
    assert.ok(!calls.some(operation => /^(draft|scene)\.list$/.test(operation)),
      `home never requests manuscript body lists: ${calls.join(', ')}`);
    assert.equal(current.revision, 2);
    cases.push({ name: 'exact-diary-excerpts', width: [390, 320], passed: true });
  });
  await writeJson(resolve(artifacts, 'manifest.json'), { build: workspace.capturedBuild,
    servedBundle: await workspace.inspectServedBundle(), fixture: { contentSha256: fixture.contentSha256, isolated: workspace.isolated }, cases });
});
