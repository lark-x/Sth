import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';
import { assertFitsViewport, openBrowser } from '../../tests/browser/harness.mjs';
import { compareLines } from './diff.ts';
import { passageRange } from './reading.ts';

const artifacts = resolve('frontend/.artifacts/writing-reader');
const button = (page, name) => page.getByRole('button', { name, exact: true });
const heading = (page, title) => page.getByRole('heading', { level: 1, name: title, exact: true });
const body = page => page.getByRole('textbox', { name: '正文', exact: true });
async function open(t, origin, path, viewport = { width: 390, height: 844 }) {
  const page = await openBrowser(t, origin, viewport);
  await page.goto(path);
  await page.locator('.wr-reader-toolbar, .wr-comparison').waitFor();
  return page;
}
async function firstScreenMark(page) {
  await page.waitForFunction(() => {
    const rect = document.querySelector('#passage-body mark')?.getBoundingClientRect();
    return rect && rect.top > 52 && rect.bottom < innerHeight;
  });
}
async function more(page, name) {
  await button(page, '更多').click();
  const menu = page.locator('.wr-more-menu');
  const action = menu.getByRole('link', { name, exact: true });
  if (await action.count()) await action.click();
  else await menu.getByRole('button', { name, exact: true }).click();
}
async function snapshot(page, name) {
  await page.screenshot({ path: resolve(artifacts, `${name}.png`), animations: 'disabled' });
}
function characterTop(offset) {
  const element = document.querySelector('#passage-body');
  if (!element) return;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && offset >= node.textContent.length) { offset -= node.textContent.length; node = walker.nextNode(); }
  if (!node) return;
  const range = document.createRange();
  range.setStart(node, offset); range.setEnd(node, offset + 1);
  return range.getBoundingClientRect().top;
}
async function readAt(page, offset) {
  const top = await page.evaluate(characterTop, offset);
  await page.evaluate(top => window.scrollBy(0, top - 180), top);
  await page.waitForFunction(() => [...Object.keys(localStorage)].some(key => key.startsWith('sth:writing:reading:') && JSON.parse(localStorage.getItem(key)).offset > 3000));
}
async function assertReadingPosition(page, offset) {
  await page.waitForFunction(offset => {
    const element = document.querySelector('#passage-body');
    if (!element) return false;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && offset >= node.textContent.length) { offset -= node.textContent.length; node = walker.nextNode(); }
    if (!node) return false;
    const range = document.createRange();
    range.setStart(node, offset); range.setEnd(node, offset + 1);
    const top = range.getBoundingClientRect().top;
    return top > 120 && top < 240;
  }, offset);
}

test('manuscript offsets reject duplicate, partial and out-of-bounds deep links', () => {
  assert.deepEqual(passageRange(new URLSearchParams('start=2&end=5'), 8), { start: 2, end: 5 });
  for (const query of ['start=0', 'start=-1&end=3', 'start=2&end=2', 'start=3&end=2', 'start=1&end=9',
    'start=1&start=2&end=3', 'start=1&end=2&end=3', 'start=0.1&end=3', 'start=x&end=3']) {
    assert.equal(passageRange(new URLSearchParams(query), 8), undefined, query);
  }
});

test('aligned comparison preserves empty, inserted, repeated and long paragraphs', () => {
  for (const [left, right] of [
    ['开头\n旧段\n结尾', '开头\n新段\n插入段\n结尾'],
    ['重复\n\n重复\n结尾', '重复\n重复\n结尾\n'],
    ['', '第一句'], ['相同', '相同'], ['长稿\n'.repeat(5000), '另稿\n'.repeat(5000)],
  ]) {
    const result = compareLines(left, right);
    for (const side of ['left', 'right']) {
      const restored = result.paragraphs.filter(row => row[side]).map(row => row[side].text).join('\n');
      assert.equal(restored, side === 'left' ? left : right);
    }
    for (const row of result.paragraphs) {
      if (row.left && !row.left.changed) assert.equal(row.left.text, row.right?.text);
    }
  }
});

test('manuscript reading and revision through the real shell and isolated API', { timeout: 180_000 }, async t => {
  const workspace = await startManuscriptWorkspace();
  t.after(workspace.close);
  const { origin, invoke } = workspace;
  await mkdir(artifacts, { recursive: true });
  const paragraphs = Array.from({ length: 82 }, (_, i) => `第${i + 1}段。雨从栈桥另一头落下来。林澈把旧信收回衣袋，沿着灯影往前走。她记得这里的每一盏灯，也记得渡船离岸前的声音。${i === 65 ? '🙂她又说：等一下。<script>保留原文</script>' : ''}`);
  const longBody = paragraphs.join('\n\n');
  const start = longBody.indexOf('等一下。');
  const end = start + '等一下。'.length;
  const scene = await invoke('scene.create', { title: '长篇稿件 · 栈桥上的雨夜与尚未拆开的那封信' });
  const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '林澈眼中的雨夜', body: longBody });
  const alternateBody = longBody.replace(paragraphs[26], `${paragraphs[26]}\n船长在这里多说了一句话。`).replace('第66段。', '第66段。船长停下来。');
  const alternate = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '船长眼中的雨夜', body: alternateBody });
  await invoke('scene.adopt', { sceneId: scene.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
  const selectedUrl = `/drafts/${draft.draftId}?revision=1&start=${start}&end=${end}`;

  for (const [name, viewport] of [
    ['compact', { width: 320, height: 640 }], ['phone', { width: 390, height: 844 }],
    ['tablet', { width: 768, height: 1024 }], ['desktop', { width: 1440, height: 900 }],
  ]) {
    await t.test(`${name} exact UTF-16 passage opens in the first screen and returns from context`, async t => {
      const page = await open(t, origin, selectedUrl, viewport);
      await firstScreenMark(page);
      assert.equal(await page.locator('#passage-body').textContent(), longBody);
      assert.equal(await page.locator('#passage-body mark').innerText(), '等一下。');
      assert.equal(await page.locator('#passage-body script').count(), 0);
      const typography = await page.locator('#passage-body').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const toolbarTitle = document.querySelector('.wr-toolbar-title').getBoundingClientRect();
        return { left: rect.left, right: innerWidth - rect.right, width: rect.width, font: parseFloat(getComputedStyle(element).fontSize), titleWidth: toolbarTitle.width };
      });
      if (viewport.width <= 390) {
        assert.ok(typography.left >= 18 && typography.left <= 22, JSON.stringify(typography));
        assert.ok(typography.right >= 18 && typography.right <= 22, JSON.stringify(typography));
      }
      assert.ok(typography.width <= typography.font * 38, JSON.stringify(typography));
      assert.ok(typography.titleWidth >= 28, JSON.stringify(typography));
      const toolbar = page.getByRole('navigation', { name: '读写工具', exact: true });
      assert.equal(await toolbar.locator('.wr-toolbar-title').innerText(), draft.title);
      assert.ok((await toolbar.boundingBox()).height < viewport.height * .12);
      if (viewport.width <= 390) assert.equal(await page.getByRole('button', { name: '返回文稿列表', exact: true }).count(), 1);
      await assertFitsViewport(page);
      await snapshot(page, `${name}-exact-passage`);
      await more(page, '提炼为事件');
      await heading(page, '新建事件').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('start'), String(start));
      await page.goBack();
      await firstScreenMark(page);
      assert.equal(new URL(page.url()).search, new URL(selectedUrl, origin).search);
      await snapshot(page, `${name}-returned-passage`);
    });
  }

  await t.test('un-pinned reading returns to its sentence and an explicit new deep link takes precedence', async t => {
    const page = await open(t, origin, `/drafts/${draft.draftId}`);
    await readAt(page, start);
    const before = await page.evaluate(() => scrollY);
    await more(page, '对照候选稿');
    await heading(page, '对照候选稿').waitFor();
    await page.goBack();
    await page.waitForFunction(before => Math.abs(scrollY - before) < 60, before);
    await page.goto(`/drafts/${draft.draftId}?revision=1&start=0&end=4`);
    await firstScreenMark(page);
    assert.equal(await page.locator('#passage-body mark').innerText(), longBody.slice(0, 4));
  });

  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
    await t.test(`${name} Frame controls preserve the reading sentence after leaving the linked passage`, async t => {
      const page = await open(t, origin, selectedUrl, viewport);
      await firstScreenMark(page);
      const later = longBody.indexOf('第75段。');
      await readAt(page, later);
      if (name === 'phone') {
        await button(page, '返回文稿列表').click();
        await page.locator('.manuscript-frame[data-pane="sheets"]').waitFor();
        assert.equal(new URL(page.url()).search, new URL(selectedUrl, origin).search);
        await page.locator('.manuscript-sheets a[aria-current="page"]').click();
        await page.locator('.manuscript-frame[data-pane="editor"]').waitFor();
      } else {
        await button(page, '专注阅读').click();
        await assertReadingPosition(page, later);
        await button(page, '显示目录').click();
      }
      await assertReadingPosition(page, later);
      await assertFitsViewport(page);
      await snapshot(page, `${name}-frame-reading-restored`);
    });
  }

  await t.test('more menu retains the original return and dismisses without native popovers', async t => {
    const page = await openBrowser(t, origin, { width: 320, height: 640 });
    await page.addInitScript(() => { delete HTMLElement.prototype.popover; });
    const returnTo = `/scenes/${scene.sceneId}?revision=2`;
    await page.goto(`/drafts/${draft.draftId}?returnTo=${encodeURIComponent(returnTo)}`);
    const trigger = button(page, '更多');
    await trigger.click();
    const menu = page.locator('.wr-more-menu');
    assert.equal(await menu.getByRole('link').first().getAttribute('href'), returnTo);
    await menu.getByRole('link').first().focus();
    await page.keyboard.press('Escape');
    assert.equal(await menu.isVisible(), false);
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    await trigger.click();
    await page.locator('.wr-toolbar-title').click();
    assert.equal(await menu.isVisible(), false);
    await trigger.click();
    await menu.getByRole('link').first().click();
    await heading(page, scene.title).waitFor();
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, returnTo);
  });

  await t.test('long inline editing starts at the selected UTF-16 passage and adapts to a narrower viewport', async t => {
    const page = await open(t, origin, selectedUrl);
    await firstScreenMark(page);
    await button(page, '编辑').click();
    await body(page).waitFor();
    const selected = await body(page).evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd }));
    assert.deepEqual(selected, { start, end });
    await snapshot(page, 'phone-long-inline-selection');
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForFunction(() => {
      const input = document.querySelector('textarea[name="body"]');
      return input && input.clientHeight >= input.scrollHeight - 2;
    });
    assert.ok((await page.locator('.wr-toolbar-title').boundingBox()).width >= 28);
    await assertFitsViewport(page);
    await button(page, '阅读').click();
    await firstScreenMark(page);
  });

  await t.test('adoption, historical version switching and IF remain available through more', async t => {
    const sourceScene = await invoke('scene.create', { title: '采用与 IF 的完整路径' });
    const candidate = await invoke('draft.create', { sceneId: sourceScene.sceneId, sceneRevision: 1, title: '留在北岸', body: '她没有登船。' });
    await invoke('draft.revise', { draftId: candidate.draftId, expectedRevision: 1, body: '第二版，她仍留在北岸。' });
    const page = await open(t, origin, `/drafts/${candidate.draftId}?revision=1`);
    await button(page, '稿件与版本').click();
    await page.getByRole('combobox', { name: '切换稿件版本', exact: true }).selectOption('2');
    await page.waitForFunction(() => document.querySelector('#passage-body')?.textContent === '第二版，她仍留在北岸。');
    await button(page, '稿件与版本').click();
    await page.getByRole('combobox', { name: '切换稿件版本', exact: true }).selectOption('1');
    await more(page, '采纳此版本');
    await heading(page, '采纳候选稿').waitFor();
    await button(page, '采纳候选稿').click();
    await heading(page, sourceScene.title).waitFor();
    assert.equal((await invoke('scene.read', { sceneId: sourceScene.sceneId })).adopted.revision, 1);
    await more(page, '建立 IF 分支');
    await heading(page, '建立 IF 分支').waitFor();
    await page.getByRole('textbox', { name: '分歧点', exact: true }).fill('在离岸前转身。');
    await page.getByRole('textbox', { name: '标题', exact: true }).fill('仍在北岸的 IF');
    await button(page, '建立 IF 分支').click();
    await heading(page, '仍在北岸的 IF').waitFor();
    const branch = await invoke('scene.read', { sceneId: new URL(page.url()).pathname.split('/').at(-1) });
    assert.deepEqual(branch.branchFrom.draft, { draftId: candidate.draftId, revision: 1 });
    assert.equal(branch.adopted, undefined);
  });

  await t.test('inline drafts survive switching, reload and a concurrent save, with adoption preserved', async t => {
    const current = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '原位修订练习', body: '原来的正文。' });
    const page = await open(t, origin, `/drafts/${current.draftId}`);
    await button(page, '编辑').click();
    await body(page).fill('我尚未保存的正文。\n\n第二段也要保留。');
    await button(page, '阅读').click();
    assert.equal(await page.locator('#passage-body').innerText(), '原来的正文。');
    await button(page, '编辑').click();
    assert.equal(await body(page).inputValue(), '我尚未保存的正文。\n\n第二段也要保留。');
    await page.reload();
    await body(page).waitFor();
    assert.equal(await body(page).inputValue(), '我尚未保存的正文。\n\n第二段也要保留。');
    await invoke('draft.revise', { draftId: current.draftId, expectedRevision: 1, body: '另一会话抢先保存。' });
    await button(page, '保存修订').click();
    await page.getByRole('alert').filter({ hasText: '内容已有更新' }).waitFor();
    assert.equal(await button(page, '保存修订').isDisabled(), true);
    await snapshot(page, 'phone-inline-conflict');
    await button(page, '读取最新版本').click();
    await page.getByText('另一会话抢先保存。', { exact: true }).waitFor();
    await button(page, '保留我的文字，以此版本继续修订').click();
    await button(page, '保存修订').click();
    await page.locator('#passage-body').waitFor();
    const saved = await invoke('draft.read', { draftId: current.draftId });
    assert.equal(saved.revision, 3);
    assert.equal(saved.body, '我尚未保存的正文。\n\n第二段也要保留。');
    assert.equal(saved.sceneRevision, 1);
    assert.equal((await invoke('scene.read', { sceneId: scene.sceneId })).adopted.draftId, draft.draftId);
    await page.reload();
    await page.locator('#passage-body').waitFor();
    assert.equal(await page.evaluate(id => sessionStorage.getItem(`sth:writing:editor:${id}`), current.draftId), null);
    const footerHeights = await page.locator('.writing-route > details.wr-section, .writing-route > .manuscript-evidence').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assert.ok(footerHeights.every(height => height >= 44 && height <= 46), JSON.stringify(footerHeights));
    await snapshot(page, 'phone-inline-saved');
    await page.setViewportSize({ width: 320, height: 640 });
    await assertFitsViewport(page);
    await snapshot(page, 'compact-inline-saved');
  });

  await t.test('an old revision uses its own buffer and needs an explicit current-version acknowledgement', async t => {
    const current = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '旧版保护', body: '第一版正文。' });
    const page = await open(t, origin, `/drafts/${current.draftId}`);
    await button(page, '编辑').click();
    await body(page).fill('当前稿的本地草稿。');
    await button(page, '阅读').click();
    await invoke('draft.revise', { draftId: current.draftId, expectedRevision: 1, body: '已经发布的第二版正文。' });
    await page.goto(`/drafts/${current.draftId}?revision=1`);
    await button(page, '编辑旧版').click();
    await body(page).waitFor();
    assert.equal(await body(page).inputValue(), '第一版正文。');
    assert.equal(await button(page, '保存修订').isDisabled(), true);
    assert.match(await page.locator('.wr-conflict').innerText(), /第 2 版/);
    await snapshot(page, 'phone-historical-editor');
    await button(page, '保留我的文字，以此版本继续修订').click();
    await body(page).fill('从第一版继续的新修订。');
    await button(page, '保存修订').click();
    await page.locator('#passage-body').waitFor();
    assert.equal(new URL(page.url()).searchParams.has('revision'), false);
    assert.equal((await invoke('draft.read', { draftId: current.draftId })).body, '从第一版继续的新修订。');
    assert.equal(await page.evaluate(id => JSON.parse(sessionStorage.getItem(`sth:writing:editor:${id}`)).body, current.draftId), '当前稿的本地草稿。');
  });

  await t.test('a lost inline-save response recovers the same receipt after current version advances', async t => {
    const current = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '原位回执', body: '保存前正文。' });
    const page = await open(t, origin, `/drafts/${current.draftId}`);
    await button(page, '编辑').click();
    await body(page).fill('已经保存但响应丢失的正文。');
    let writes = 0;
    await page.route('**/api/web/invoke', async route => {
      if (route.request().postDataJSON().operationId !== 'draft.revise') return route.continue();
      writes++;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.fulfill({ status: 503, json: { error: { code: 'response_lost' } } });
    });
    await button(page, '保存修订').click();
    await page.getByRole('alert').filter({ hasText: '保存结果尚未确认' }).waitFor();
    assert.equal(await body(page).getAttribute('readonly'), '');
    await page.reload();
    await button(page, '重试同一次提交').click();
    await page.locator('#passage-body').waitFor();
    assert.equal(await page.locator('#passage-body').innerText(), '已经保存但响应丢失的正文。');
    assert.equal(writes, 1);
    assert.equal((await invoke('draft.read', { draftId: current.draftId })).revision, 2);
    await snapshot(page, 'phone-receipt-recovered');
  });

  await t.test('scene reader exposes the adopted prose and pins its original evidence context', async t => {
    const page = await open(t, origin, `/scenes/${scene.sceneId}`);
    assert.equal(await page.locator('#passage-body').textContent(), longBody);
    await button(page, '本次依据').click();
    await page.getByText(/此稿尚无明确关联的组稿记录/).waitFor();
    assert.doesNotMatch(await page.locator('.manuscript-evidence').innerText(), /版本不匹配/);
    await button(page, '关闭依据').click();
    for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, 0));
      const margins = await page.locator('#passage-body').evaluate(element => {
        const content = element.getBoundingClientRect();
        const editor = element.closest('.ms-editor').getBoundingClientRect();
        return { left: content.left - editor.left, right: editor.right - content.right };
      });
      assert.ok(margins.left >= 18 && margins.right >= 18, JSON.stringify(margins));
      assert.ok(Math.abs(margins.left - margins.right) < 2, JSON.stringify(margins));
      await assertFitsViewport(page);
      await snapshot(page, `${name}-scene-reader`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await button(page, '编辑').click();
    await body(page).fill('场景内保存的新候选。');
    await button(page, '保存修订').click();
    await page.locator('#passage-body').waitFor();
    assert.equal(await page.locator('#passage-body').textContent(), '场景内保存的新候选。');
    const after = await invoke('scene.read', { sceneId: scene.sceneId });
    assert.equal(after.adopted.revision, 1);
    assert.equal(after.adopted.body, longBody);
  });

  await t.test('historical draft and scene source tools open pinned evidence and return focus', async t => {
    const sourceBody = '旧港口值班簿。第三声钟响以后，渡船离岸。';
    const excerpt = '第三声钟响以后';
    const range = { start: sourceBody.indexOf(excerpt), end: sourceBody.indexOf(excerpt) + excerpt.length };
    const source = await invoke('source.create', { kind: 'setting', title: '旧港口值班簿', body: sourceBody });
    const linkedScene = await invoke('scene.create', { title: '旧版来源追踪', sources: [{ sourceId: source.sourceId, revision: 1, excerpt, range }] });
    const linkedDraft = await invoke('draft.create', { sceneId: linkedScene.sceneId, sceneRevision: 1, title: '采用旧值班簿的稿件', body: longBody });
    await invoke('scene.adopt', { sceneId: linkedScene.sceneId, expectedRevision: 1, draftId: linkedDraft.draftId, draftRevision: 1 });
    await invoke('draft.revise', { draftId: linkedDraft.draftId, expectedRevision: 1, body: `新版开头。${longBody}` });
    await invoke('scene.revise', { sceneId: linkedScene.sceneId, expectedRevision: 2, sources: [] });
    await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '新版公告改为第二声钟响，旧值班簿只供追溯。' });
    for (const [name, path] of [
      ['draft', `/drafts/${linkedDraft.draftId}?revision=1&start=${start}&end=${end}`],
      ['scene', `/scenes/${linkedScene.sceneId}?revision=2`],
    ]) {
      const page = await open(t, origin, path, { width: 320, height: 640 });
      if (name === 'draft') await firstScreenMark(page);
      else await readAt(page, start);
      const top = await page.evaluate(() => scrollY);
      await page.evaluate(() => {
        window.__writingEvidenceEvents = [];
        document.querySelector('.ms-editor').addEventListener('sth:open-evidence', event => {
          window.__writingEvidenceEvents.push({
            custom: event instanceof CustomEvent, bubbles: event.bubbles,
            target: event.target.tagName, label: event.target.getAttribute('aria-label'),
            main: event.currentTarget.tagName, revision: new URL(location.href).searchParams.get('revision'),
          });
        });
      });
      const trigger = button(page, '来源与依据');
      await page.waitForFunction(() => document.querySelector('button[aria-label="来源与依据"]')?.getAttribute('aria-controls'));
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      await trigger.locator('path').click();
      const panel = page.getByRole('dialog', { name: '本次依据', exact: true });
      await panel.getByText(/此稿尚无明确关联的组稿记录/).waitFor();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(await trigger.getAttribute('aria-controls'), await panel.getAttribute('id'));
      assert.doesNotMatch(await panel.innerText(), /版本不匹配/);
      await panel.locator('summary').filter({ hasText: '场景关联资料 · 第 1 版' }).click();
      const original = panel.getByRole('link', { name: '场景引用原文 1 · 第 1 版', exact: true });
      assert.equal(await original.getAttribute('href'), `/sources/${source.sourceId}?revision=1&start=${range.start}&end=${range.end}`);
      await snapshot(page, `compact-${name}-historical-source-panel`);
      await button(page, '关闭依据').click();
      await page.waitForFunction(top => Math.abs(scrollY - top) < 4, top);
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Enter');
      await panel.waitFor();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      const events = await page.evaluate(() => window.__writingEvidenceEvents);
      assert.deepEqual(events, Array(2).fill({ custom: true, bubbles: true, target: 'BUTTON', label: '来源与依据', main: 'MAIN', revision: new URL(path, origin).searchParams.get('revision') }));
      assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
      await page.waitForFunction(top => Math.abs(scrollY - top) < 4, top);
      await assertFitsViewport(page);
      await trigger.click();
      await original.click();
      await heading(page, source.title).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('revision'), '1');
      assert.equal(await page.locator('#passage-body').textContent(), sourceBody);
      assert.equal(await page.locator('#passage-body mark').innerText(), excerpt);
      await page.goBack();
      if (name === 'draft') await firstScreenMark(page);
      else await assertReadingPosition(page, start);
    }
  });

  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
    await t.test(`${name} comparison keeps corresponding paragraphs aligned`, async t => {
      const page = await open(t, origin, `/scenes/${scene.sceneId}?action=compare&left=${draft.draftId}@1&right=${alternate.draftId}@1`, viewport);
      const target = 120;
      const row = page.locator(`[data-side="left"] [data-compare-row="${target}"]`);
      await row.waitFor();
      await page.evaluate(target => {
        const row = document.querySelector(`[data-side="left"] [data-compare-row="${target}"]`);
        window.scrollBy(0, row.getBoundingClientRect().top - 180);
      }, target);
      const before = await row.boundingBox();
      if (name === 'phone') {
        await page.getByRole('navigation', { name: '同段切换', exact: true }).getByRole('button', { name: '右稿', exact: true }).click();
        const after = await page.locator(`[data-side="right"] [data-compare-row="${target}"]`).boundingBox();
        assert.ok(Math.abs(before.y - after.y) < 4, `${before.y} -> ${after.y}`);
        assert.equal(await page.getByRole('article', { name: '左稿', exact: true }).count(), 0);
      } else {
        const after = await page.locator(`[data-side="right"] [data-compare-row="${target}"]`).boundingBox();
        assert.ok(Math.abs(before.y - after.y) < 4, `${before.y} -> ${after.y}`);
        await page.locator('[data-side="left"] .wr-compare-actions > summary').click();
        await page.waitForFunction(() => {
          const rows = ['left', 'right'].map(side => document.querySelector(`[data-side="${side}"] [data-compare-row="0"]`).getBoundingClientRect().top);
          return Math.abs(rows[0] - rows[1]) < 4;
        });
        await page.evaluate(target => document.querySelector(`[data-side="left"] [data-compare-row="${target}"]`).scrollIntoView(), target);
      }
      await assertFitsViewport(page);
      await snapshot(page, `${name}-same-paragraph-comparison`);
      if (name === 'phone') {
        await page.locator('.wr-compare-versions > summary').click();
        await page.locator('#wr-left').selectOption(`${alternate.draftId}@1`);
        const comparisonKey = `sth:writing:comparison:${scene.sceneId}:${draft.draftId}@1:${alternate.draftId}@1`;
        await page.evaluate(key => sessionStorage.removeItem(key), comparisonKey);
        await page.evaluate(target => {
          const row = document.querySelector(`[data-side="right"] [data-compare-row="${target}"]`);
          window.scrollBy(0, row.getBoundingClientRect().top - 180);
        }, target);
        await page.waitForFunction(key => JSON.parse(sessionStorage.getItem(key))?.row >= 100, comparisonKey);
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), `sth:writing:comparison:${scene.sceneId}:${alternate.draftId}@1:${alternate.draftId}@1`), null);
        await page.reload();
        await page.waitForFunction(target => {
          const row = document.querySelector(`[data-side="right"] [data-compare-row="${target}"]`);
          const rect = row?.getBoundingClientRect();
          return rect && rect.top > 80 && rect.top < 300;
        }, target);
      }
    });
  }
});
