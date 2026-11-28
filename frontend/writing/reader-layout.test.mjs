import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace, viewports, writeJson } from '../../scripts/manuscript-fixture.mjs';

const output = resolve('frontend/.artifacts/reader-layout/verified');
const button = (page, name) => page.getByRole('button', { name, exact: true });
const body = page => page.locator('#passage-body');

async function assertVersionState(page, expected) {
  const state = page.locator('.wr-version-state');
  await state.waitFor();
  assert.equal(await state.isVisible(), true);
  const labels = state.locator(':scope > span');
  assert.deepEqual((await labels.allTextContents()).map(value => value.trim()), expected);
  for (let index = 0; index < expected.length; index++)
    assert.equal(await labels.nth(index).isVisible(), true, expected[index]);
}

async function closeVersions(page) {
  await page.keyboard.press('Escape');
  await page.locator('.wr-versions-menu').waitFor({ state: 'hidden' });
}

async function retryLayout(retry) {
  return retry.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const toolbar = document.querySelector('.wr-reader-toolbar').getBoundingClientRect();
    const radius = getComputedStyle(element).borderRadius;
    const corner = Math.max(2, Math.ceil(parseFloat(radius)) + 1);
    // Sample the painted edges, not the transparent corners of a rounded button.
    const points = [
      [rect.left + corner, rect.top + 2], [rect.right - corner, rect.top + 2],
      [rect.right - 2, rect.top + corner], [rect.right - 2, rect.bottom - corner],
      [rect.right - corner, rect.bottom - 2], [rect.left + corner, rect.bottom - 2],
      [rect.left + 2, rect.bottom - corner], [rect.left + 2, rect.top + corner],
      [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
    ];
    return { focused: document.activeElement === element, top: rect.top, bottom: rect.bottom, toolbarBottom: toolbar.bottom,
      unobscured: points.every(([x, y]) => element.contains(document.elementFromPoint(x, y))), viewport: innerHeight,
      radius, hitPoints: points.map(([x, y]) => ({ x, y, tag: document.elementFromPoint(x, y)?.tagName,
        className: document.elementFromPoint(x, y)?.className })) };
  });
}

test('restored uncertain saves expose the retry action without losing ordinary draft cursors', { timeout: 120_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const directory = resolve(process.env.STH_RECEIPT_ARTIFACTS ?? 'frontend/.artifacts/receipt-focus');
  await mkdir(directory, { recursive: true });
  for (const [engine, width, height] of [[chromium, 390, 844], [webkit, 390, 844], [webkit, 320, 640], [chromium, 1280, 900]]) {
    await t.test(`${engine.name()} ${width}`, async t => {
      const browser = await engine.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ baseURL: workspace.origin, viewport: { width, height } });
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      t.after(() => assert.deepEqual(errors, []));
      const scene = await workspace.invoke('scene.create', { title: '回执恢复位置' });
      const draft = await workspace.invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '一次保存的回执', body: '保存前的正文。' });
      await page.goto(`/drafts/${draft.draftId}`);
      await body(page).waitFor();
      await button(page, '编辑').click();
      const editor = page.getByRole('textbox', { name: '正文', exact: true });
      const prose = '港口的灯在风中摇晃。作者继续写这一幕，保留正文末尾的光标。\n\n'.repeat(18);
      await editor.fill(prose);
      await editor.evaluate(element => { element.setSelectionRange(element.value.length, element.value.length); element.dispatchEvent(new Event('select')); });
      await page.reload();
      await page.waitForFunction(length => {
        const field = document.querySelector('textarea[name="body"]');
        return field === document.activeElement && field.selectionStart === length;
      }, prose.length);
      assert.equal(await editor.inputValue(), prose, 'ordinary reload restores the unsaved prose');
      const writes = [], receipts = [];
      await page.route('**/api/web/receipt', async route => { receipts.push(route.request().postDataJSON()); await route.continue(); });
      await page.route('**/api/web/invoke', async route => {
        const call = route.request().postDataJSON();
        if (call.operationId !== 'draft.revise') return route.continue();
        writes.push(call);
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.fulfill({ status: 503, json: { code: 'response_lost' } });
      });
      await button(page, '保存修订').click();
      await page.getByRole('alert').filter({ hasText: '保存结果尚未确认' }).waitFor();
      await page.reload();
      const retry = button(page, '重试同一次提交');
      await ready(page, retry);
      const layout = await retryLayout(retry);
      const stem = `${engine.name()}-${width}`;
      await writeJson(resolve(directory, `${stem}.json`), layout);
      await page.screenshot({ path: resolve(directory, `${stem}-reopened.png`), animations: 'disabled' });
      assert.ok(layout.top >= layout.toolbarBottom && layout.bottom <= layout.viewport && layout.unobscured, `retry is fully visible: ${JSON.stringify(layout)}`);
      assert.equal(layout.focused, true, 'pending receipt recovery prioritizes the retry action');
      assert.equal(await editor.inputValue(), prose);
      assert.equal(await editor.getAttribute('readonly'), '');
      await retry.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const cover = document.createElement('div');
        cover.id = 'receipt-test-cover';
        Object.assign(cover.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
          width: `${rect.width}px`, height: '3px', zIndex: '2147483647' });
        document.body.append(cover);
      });
      assert.equal((await retryLayout(retry)).unobscured, false, 'even a 3px edge obstruction must fail the hit test');
      await page.locator('#receipt-test-cover').evaluate(element => element.remove());
      await retry.click();
      await body(page).waitFor();
      assert.equal(await body(page).textContent(), prose);
      const saved = await workspace.invoke('draft.read', { draftId: draft.draftId });
      assert.equal(saved.body, prose);
      assert.equal(saved.revision, 2);
      assert.equal(writes.length, 1, 'receipt recovery must not write another revision');
      assert.deepEqual(receipts, [{ operationId: 'draft.revise', stepId: writes[0].stepId }]);
      await page.screenshot({ path: resolve(directory, `${stem}-recovered.png`), animations: 'disabled' });
    });
  }
});

async function ready(page, locator) {
  await locator.waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function typography(locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { font: style.fontFamily, size: style.fontSize, leading: style.lineHeight, measure: style.maxInlineSize };
  });
}

test('the compact reader preserves manuscript identity across layout, edit and evidence', { timeout: 180_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  await mkdir(output, { recursive: true });
  const results = [];
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const viewport of viewports.filter(viewport => engine === chromium || viewport.width < 640)) {
        await t.test(`${engine.name()} ${viewport.width}`, async t => {
          const mobile = viewport.width < 640;
          const context = await browser.newContext({ baseURL: workspace.origin, viewport, locale: 'zh-CN', isMobile: mobile, hasTouch: mobile });
          t.after(() => context.close());
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          const stem = `${engine.name()}-${viewport.width}`;
          const shot = name => page.screenshot({ path: resolve(output, `${stem}-${name}.png`), animations: 'disabled' });
          const picker = button(page, '稿件与版本');
          const revision = page.locator('[aria-label="切换稿件版本"]');
          const status = page.locator('.wr-toolbar-meta');

          await page.goto(fixture.links.oldDraft);
          await ready(page, body(page));
          const path = page.getByRole('navigation', { name: '文稿位置', exact: true });
          if (mobile) {
            assert.equal(await path.isVisible(), false);
          } else {
            await path.getByText(fixture.chapters[1].title, { exact: true }).waitFor();
            await path.getByText(fixture.project.title, { exact: true }).waitFor();
          }
          assert.equal(await page.getByRole('heading', { level: 1, name: fixture.drafts[0].title, exact: true }).count(), 1);
          assert.equal(await picker.isVisible(), true);
          assert.equal(await picker.innerText(), '第 1 版 · 历史');
          assert.equal(await picker.getAttribute('aria-describedby'), await status.getAttribute('id'));
          assert.match(await status.textContent(), /第 1 版\s*采用稿\s*旧版 · 最新第 2 版/);
          const toolbarLayout = await page.locator('.wr-reader-toolbar').evaluate(element => {
            const centers = ['.ms-view-controls', '.wr-toolbar-identity', '.wr-toolbar-actions'].map(selector => {
              const rect = element.querySelector(selector).getBoundingClientRect();
              return rect.top + rect.height / 2;
            });
            return { height: element.getBoundingClientRect().height, rowSpread: Math.max(...centers) - Math.min(...centers) };
          });
          assert.ok(toolbarLayout.rowSpread <= 1 && toolbarLayout.height <= 64, `single toolbar row: ${JSON.stringify(toolbarLayout)}`);
          assert.equal(await revision.inputValue(), '1');
          assert.equal(await revision.isVisible(), false);
          const firstLine = await body(page).evaluate(element => {
            const range = document.createRange();
            const text = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.length);
            range.setStart(text, 0);
            range.setEnd(text, 1);
            return range.getBoundingClientRect().top;
          });
          assert.equal(await page.evaluate(() => scrollY), 0);
          if (mobile) assert.ok(firstLine < 205, `first line at ${firstLine}px`);
          const readerType = await typography(body(page));
          assert.equal(readerType.size, '18px');
          assert.ok(Math.abs(parseFloat(readerType.leading) - 32.4) < 0.01, readerType.leading);
          assert.equal(readerType.measure, '648px');
          assert.doesNotMatch(readerType.font, /SimSun|Songti|Serif CJK/);
          let glyphs;
          if (engine === chromium) {
            const session = await context.newCDPSession(page);
            await session.send('DOM.enable');
            await session.send('CSS.enable');
            const { root } = await session.send('DOM.getDocument');
            const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#passage-body' });
            glyphs = (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
            await session.detach();
          }
          await shot('read-start');

          if (mobile) await picker.tap();
          else {
            await picker.press('Enter');
            await page.keyboard.press('Tab');
            assert.equal(await page.getByRole('combobox', { name: '切换稿件', exact: true }).evaluate(element => element === document.activeElement), true);
          }
          await revision.waitFor();
          assert.equal(await page.locator('.wr-version-title').textContent(), fixture.drafts[0].title);
          await assertVersionState(page, ['正在查看 · 第 1 版', '采用稿', '最新修订 · 第 2 版']);
          assert.equal(await revision.locator('option[value="1"]').innerText(), '第 1 版 · 正在查看 · 章节采用');
          if (mobile) {
            assert.equal(await page.locator('.wr-reader-path').isVisible(), false);
            assert.equal(await page.locator('.wr-version-path').isVisible(), true);
            assert.deepEqual(await page.locator('.wr-version-path a').allTextContents(), [fixture.project.title, fixture.chapters[1].title]);
            assert.equal(await page.locator('.wr-version-path > span:last-child').textContent(), fixture.scene.title);
          }
          await shot('versions-open');
          await revision.selectOption('2');
          await page.waitForURL(fixture.links.newDraft);
          await ready(page, body(page));
          assert.match(await status.textContent(), /第 2 版\s*候选稿\s*最新修订/);
          assert.equal(await picker.innerText(), '第 2 版');
          await picker.click();
          await assertVersionState(page, ['正在查看 · 第 2 版', '候选稿', '最新修订']);
          await closeVersions(page);

          await page.goto(fixture.links.oldPassage);
          const mark = body(page).locator('mark');
          await ready(page, mark);
          assert.equal(await mark.textContent(), fixture.target.excerpt);
          const contextBounds = await mark.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            const toolbar = document.querySelector('.wr-reader-toolbar').getBoundingClientRect();
            const range = document.createRange();
            const previous = element.previousSibling;
            const following = element.nextSibling;
            range.setStart(previous, previous.textContent.trimEnd().length - 2);
            range.setEnd(previous, previous.textContent.trimEnd().length - 1);
            const before = range.getBoundingClientRect();
            const offset = following.textContent.length - following.textContent.trimStart().length;
            range.setStart(following, offset);
            range.setEnd(following, offset + 1);
            const after = range.getBoundingClientRect();
            return { toolbar: toolbar.bottom, mark: bounds.top, before: before.bottom, after: after.bottom };
          });
          assert.ok(contextBounds.mark > contextBounds.toolbar && contextBounds.before > contextBounds.toolbar && contextBounds.after < viewport.height, JSON.stringify(contextBounds));
          await shot('passage');
          const evidence = button(page, '来源与依据');
          const scrollBefore = await page.evaluate(() => scrollY);
          await evidence.press('Enter');
          const panel = page.locator('.evidence-panel:visible');
          await panel.locator('.evidence-content').waitFor();
          assert.equal(await evidence.getAttribute('aria-expanded'), 'true');
          assert.equal(await evidence.getAttribute('aria-controls'), await panel.getAttribute('id'));
          await shot('evidence-open');
          await panel.press('Escape');
          assert.equal(await evidence.getAttribute('aria-expanded'), 'false');
          assert.equal(await evidence.evaluate(element => document.activeElement === element), true);
          assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) <= 1);
          assert.equal(await page.locator('[inert]:not(.evidence-panel)').count(), 0);
          assert.equal(await page.locator('.evidence-panel').getAttribute('aria-hidden'), 'true');
          await page.locator('.evidence-panel').waitFor({ state: 'hidden' });
          assert.equal(await panel.count(), 0);

          await page.goto(fixture.links.compare);
          const left = page.getByRole('article', { name: '左稿', exact: true });
          const right = page.locator('[data-side="right"]');
          await ready(page, left);
          assert.match(await left.locator('header').innerText(), /第 1 版[\s\S]*采用稿[\s\S]*旧版/);
          assert.deepEqual(await typography(left.locator('[data-compare-row="0"]')), readerType);
          assert.equal(await right.isVisible(), viewport.width > 768);
          await shot('compare-left');
          if (viewport.width <= 768) {
            await button(page, '右稿').click();
            assert.equal(await left.count(), 0);
            assert.match(await right.locator('header').innerText(), /船长的讲法[\s\S]*候选稿/);
            await shot('compare-right');
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width);
          assert.deepEqual(errors, []);
          results.push({ browser: engine.name(), viewport, firstLine, typography: readerType, glyphs, contextBounds });
        });
      }
    } finally {
      await browser.close();
    }
  }

  await t.test('editing old version 1 from the menu preserves its text and adoption', async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ baseURL: workspace.origin, viewport: { width: 390, height: 844 } });
    await page.goto(fixture.links.latestDraft);
    await ready(page, body(page));
    const readerType = await typography(body(page));
    await button(page, '稿件与版本').press('Enter');
    await page.getByRole('combobox', { name: '切换稿件版本', exact: true }).selectOption('1');
    await button(page, '编辑旧版').click();
    const editor = page.getByRole('textbox', { name: '正文', exact: true });
    await editor.waitFor();
    assert.deepEqual(await typography(editor), readerType);
    assert.equal(await editor.inputValue(), fixture.bodies.old);
    assert.equal(await button(page, '保存修订').isDisabled(), true);
    await page.screenshot({ path: resolve(output, 'chromium-390-historical-edit.png'), animations: 'disabled' });
    await button(page, '保留我的文字，以此版本继续修订').click();
    const revised = `${fixture.bodies.old}\n\n这一行只写进第三版。`;
    await editor.fill(revised);
    await button(page, '保存修订').click();
    await page.waitForURL(fixture.links.latestDraft);
    await body(page).waitFor();
    const draftId = fixture.drafts[0].draftId;
    const current = await workspace.invoke('draft.read', { draftId });
    assert.equal(current.revision, 3);
    assert.equal(current.body, revised);
    const scene = await workspace.invoke('scene.read', { sceneId: fixture.scene.sceneId });
    assert.equal(scene.adopted.draftId, draftId);
    assert.equal(scene.adopted.revision, 1);
    await button(page, '稿件与版本').click();
    await page.getByRole('combobox', { name: '切换稿件版本', exact: true }).selectOption('1');
    await body(page).waitFor();
    assert.equal(await body(page).textContent(), fixture.bodies.old);
    assert.equal((await workspace.invoke('draft.read', { draftId, revision: 1 })).body, fixture.bodies.old);
    assert.match(await page.locator('.wr-toolbar-meta').textContent(), /第 1 版\s*采用稿\s*旧版 · 最新第 3 版/);
    await button(page, '稿件与版本').click();
    await assertVersionState(page, ['正在查看 · 第 1 版', '采用稿', '最新修订 · 第 3 版']);
    await closeVersions(page);
  });
  const servedBundle = await workspace.inspectServedBundle();
  assert.equal(servedBundle.sha256, workspace.capturedBuild.bundle.sha256);
  await writeJson(resolve(output, 'manifest.json'), { fixture: fixture.contentSha256, build: workspace.capturedBuild, servedBundle, results });
});

test('scene adoption labels follow the selected scene revision', { timeout: 45_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const { origin, invoke } = workspace;
  const scene = await invoke('scene.create', { title: '雨夜渡口' });
  const { sceneId } = scene;
  const revised = await invoke('scene.revise', { sceneId, expectedRevision: scene.revision, place: '北岸' });
  const first = await invoke('draft.create', { sceneId, sceneRevision: revised.revision, title: '甲稿', body: '她留在栈桥上。' });
  const second = await invoke('draft.create', { sceneId, sceneRevision: revised.revision, title: '乙稿', body: '她登上了渡船。' });
  const historical = await invoke('scene.adopt', { sceneId, expectedRevision: revised.revision, draftId: first.draftId, draftRevision: first.revision });
  const current = await invoke('scene.adopt', { sceneId, expectedRevision: historical.revision, draftId: second.draftId, draftRevision: second.revision });

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ baseURL: origin, viewport: { width: 1280, height: 800 } });
  const toolbar = page.locator('.wr-toolbar-meta');
  const region = page.locator('#manuscript');
  const heading = page.locator('.wr-compare-heading');
  const left = page.getByRole('article', { name: '左稿', exact: true });
  const right = page.getByRole('article', { name: '右稿', exact: true });
  async function compareFromScene() {
    await button(page, '更多').click();
    await page.getByRole('link', { name: '对照候选稿', exact: true }).click();
    await left.waitFor();
    assert.match(await left.getByRole('heading').innerText(), /甲稿/);
    assert.match(await right.getByRole('heading').innerText(), /乙稿/);
    return {
      sceneRevision: new URL(page.url()).searchParams.get('revision'),
      scope: await heading.locator('p').allTextContents(),
      left: await left.locator('.wr-compare-meta span').first().innerText(),
      right: await right.locator('.wr-compare-meta span').first().innerText(),
    };
  }

  await page.goto(`/scenes/${sceneId}`);
  await body(page).waitFor();
  assert.equal(await body(page).textContent(), second.body);
  assert.equal(await region.getAttribute('aria-label'), '当前采用稿');
  assert.equal(await toolbar.getByText('采用稿', { exact: true }).count(), 1);
  assert.equal(await button(page, '稿件与版本').innerText(), '第 1 版 · 采用');
  await button(page, '稿件与版本').click();
  await assertVersionState(page, ['正在查看 · 第 1 版', '采用稿', '最新修订']);
  await closeVersions(page);
  const currentComparison = await compareFromScene();

  await heading.getByRole('link', { name: `返回${scene.title}`, exact: true }).click();
  await button(page, '稿件与版本').click();
  await page.getByRole('combobox', { name: '切换场景版本', exact: true }).selectOption(String(historical.revision));
  await page.waitForURL(url => url.searchParams.get('revision') === String(historical.revision));
  await body(page).waitFor();
  assert.equal(await body(page).textContent(), first.body);
  const historicalLabel = `场景第 ${historical.revision} 版采用`;
  const historicalRegion = await region.getAttribute('aria-label');
  assert.equal(await toolbar.getByText(historicalLabel, { exact: true }).count(), 1);
  assert.equal(await button(page, '稿件与版本').innerText(), '第 1 版 · 历史');
  await button(page, '稿件与版本').click();
  await assertVersionState(page, ['正在查看 · 第 1 版', historicalLabel, '最新修订']);
  const historicalToolbar = await page.locator('.wr-version-state').getByText(historicalLabel, { exact: true }).isVisible();
  await closeVersions(page);
  const historicalComparison = await compareFromScene();

  await left.getByRole('link', { name: `${first.title} · 第 ${first.revision} 版`, exact: true }).click();
  await body(page).waitFor();
  assert.equal(await toolbar.getByText('候选稿', { exact: true }).count(), 1);
  await button(page, '稿件与版本').click();
  await assertVersionState(page, ['正在查看 · 第 1 版', '候选稿', '最新修订']);
  await closeVersions(page);
  assert.deepEqual({ currentComparison, historicalRegion, historicalToolbar, historicalComparison }, {
    currentComparison: { sceneRevision: null, scope: [`场景第 ${current.revision} 版 · 当前采用状态`], left: '候选稿', right: '采用稿' },
    historicalRegion: historicalLabel,
    historicalToolbar: true,
    historicalComparison: {
      sceneRevision: String(historical.revision), scope: [`场景第 ${historical.revision} 版 · 采用状态`],
      left: historicalLabel, right: `场景第 ${historical.revision} 版未采用`,
    },
  });
});
