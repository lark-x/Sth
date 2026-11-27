import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';

const artifacts = resolve('frontend/.artifacts/writing-reader/reading-persistence');
const readingPrefix = 'sth:writing:reading:';

function sentenceTop(offset) {
  const body = document.querySelector('#passage-body');
  if (!body) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (offset < node.textContent.length) {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      return range.getBoundingClientRect().top;
    }
    offset -= node.textContent.length;
  }
}

async function ready(page) {
  await page.locator('#passage-body').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function readAt(page, offset, key) {
  const top = await page.evaluate(sentenceTop, offset);
  await page.evaluate(top => window.scrollBy(0, top - 180), top);
  await page.waitForFunction(({ key, offset }) => {
    const position = JSON.parse(localStorage.getItem(key));
    return position && Math.abs(position.offset - offset) < 250;
  }, { key, offset });
}

async function assertSentence(page, offset) {
  const top = await page.evaluate(sentenceTop, offset);
  assert.ok(top > 120 && top < 240, `the reading sentence is at ${top}px`);
}

test('reading coordinates persist across closed tabs with explicit links and draft isolation', { timeout: 180_000 }, async t => {
  await mkdir(artifacts, { recursive: true });
  const workspace = await startManuscriptWorkspace();
  t.after(workspace.close);
  const { invoke, origin } = workspace;
  const text = Array.from({ length: 90 }, (_, index) => `第${index + 1}段。雨从栈桥另一头落下来。林澈把旧信收回衣袋，沿着灯影往前走。她记得这里的每一盏灯，也记得渡船离岸前的声音。`).join('\n\n');
  const offset = text.indexOf('第66段');
  const earlier = text.indexOf('第36段');
  const scene = await invoke('scene.create', { title: '关闭标签后继续阅读的场景' });
  const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '关闭标签后继续阅读的稿件', body: text });
  await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: `${text}\n\n第二版的结尾。` });
  const adopted = await invoke('scene.adopt', { sceneId: scene.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
  const other = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '另一份独立稿件', body: text });
  for (const type of [chromium, webkit]) {
    const browser = await type.launch();
    t.after(() => browser.close());
    const engine = type.name();
    async function newContext(t) {
      const context = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
      t.after(() => context.close());
      return context;
    }

    for (const [kind, href, key] of [
      ['draft', `/drafts/${draft.draftId}`, `${readingPrefix}draft:${draft.draftId}@2`],
      ['scene', `/scenes/${scene.sceneId}`, `${readingPrefix}scene:${scene.sceneId}@${adopted.revision}:${draft.draftId}@1`],
    ]) {
      await t.test(`${engine} ${kind} closes its tab and resumes through 最近写过 in a new page`, async t => {
        const context = await newContext(t);
        const page = await context.newPage();
        await page.goto(href);
        await ready(page);
        await readAt(page, offset, key);
        const position = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
        assert.deepEqual(Object.keys(position).sort(), ['offset', 'top']);
        await page.close();

        const reopened = await context.newPage();
        await reopened.goto('/workspace?tab=recent');
        assert.equal(await reopened.evaluate(key => sessionStorage.getItem(key), key), null, 'a newly created tab has no inherited reading session');
        await reopened.locator(`a.library-sheet[href="${href}"]`).click();
        await ready(reopened);
        await assertSentence(reopened, offset);
        assert.equal(await reopened.evaluate(key => sessionStorage.getItem(key), key), null);
        await reopened.screenshot({ path: resolve(artifacts, `${engine}-${kind}-reopened.png`), animations: 'disabled' });
      });
    }

    await t.test(`${engine} versions and manuscripts retain independent positions while explicit passages win`, async t => {
      const context = await newContext(t);
      let page = await context.newPage();
      const href = `/drafts/${draft.draftId}`;
      const latestKey = `${readingPrefix}draft:${draft.draftId}@2`;
      const oldKey = `${readingPrefix}draft:${draft.draftId}@1`;
      await page.goto(href);
      await ready(page);
      await readAt(page, offset, latestKey);
      await page.goto(`${href}?revision=1`);
      await ready(page);
      assert.equal(await page.evaluate(() => scrollY), 0, 'a different revision starts independently');
      await readAt(page, earlier, oldKey);
      await page.close();

      page = await context.newPage();
      await page.goto(`${href}?revision=1`);
      await ready(page);
      await assertSentence(page, earlier);
      await page.goto(href);
      await ready(page);
      await assertSentence(page, offset);
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByRole('textbox', { name: '正文', exact: true }).fill('仅属于这个标签页的未保存草稿。');
      await page.close();

      page = await context.newPage();
      await page.goto(href);
      await ready(page);
      assert.equal(await page.getByRole('textbox', { name: '正文', exact: true }).count(), 0);
      assert.equal(await page.locator('#passage-body').textContent(), `${text}\n\n第二版的结尾。`);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => /^sth:writing:(editor|mode|pending):/.test(key))), false);
      await assertSentence(page, offset);
      await page.goto(`/drafts/${other.draftId}`);
      await ready(page);
      assert.equal(await page.evaluate(() => scrollY), 0, 'a different manuscript starts independently');
      await page.close();

      page = await context.newPage();
      await page.goto(`${href}?revision=1&start=0&end=4`);
      await ready(page);
      const mark = await page.locator('#passage-body mark').boundingBox();
      assert.ok(mark.y >= 52 && mark.y + mark.height < 844, JSON.stringify(mark));
      assert.equal(await page.locator('#passage-body mark').textContent(), text.slice(0, 4));
      await page.screenshot({ path: resolve(artifacts, `${engine}-explicit-passage.png`), animations: 'disabled' });
    });

    await t.test(`${engine} reading tolerates malformed and unavailable persistent storage`, async t => {
      const context = await newContext(t);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(key => localStorage.setItem(key, '{invalid'), `${readingPrefix}draft:${draft.draftId}@2`);
      await page.goto(`/drafts/${draft.draftId}`);
      await ready(page);
      assert.equal(await page.evaluate(() => scrollY), 0);
      await page.addInitScript(prefix => {
        for (const name of ['getItem', 'setItem']) {
          const method = Storage.prototype[name];
          Storage.prototype[name] = function (key, ...args) {
            if (key.startsWith(prefix)) throw new DOMException('Storage unavailable', 'SecurityError');
            return method.call(this, key, ...args);
          };
        }
      }, readingPrefix);
      await page.goto(`/drafts/${draft.draftId}?revision=1&start=${offset}&end=${offset + 4}`);
      await ready(page);
      const mark = await page.locator('#passage-body mark').boundingBox();
      assert.ok(mark.y >= 52 && mark.y + mark.height < 844, JSON.stringify(mark));
      await page.evaluate(() => window.scrollBy(0, 300));
      await page.waitForTimeout(200);
      assert.deepEqual(errors, []);
    });
  }
});
