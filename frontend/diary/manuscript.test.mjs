import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';
import { pairPersonalClient } from '../../tests/browser/personal-api.mjs';

const field = (page, name) => page.getByLabel(new RegExp(`^${name}(?: \\*)?$`));
const ready = page => page.locator('.diary-route[aria-busy="false"]').waitFor();

async function capture(page, name) {
  const folder = process.env.STH_DIARY_VUE_ARTIFACTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`), animations: 'disabled' });
}

test('diary manuscript keeps body visible and returns from evidence to the editor selection', { timeout: 45_000 }, async t => {
  const origin = await startService(t);
  const api = await pairPersonalClient(origin);
  const diary = await api.invoke('diary.create', {
    title: '走过河湾，再写一段', diaryDate: '2026-11-27',
    body: Array.from({ length: 22 }, (_, index) => `第${index + 1}段。天色慢慢亮了，我又听见河边的水声。\n今天想把没有说完的话写下来。`).join('\n\n'),
  });
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${diary.href}?edit=1`);
    await ready(page);
    const body = field(page, '正文');
    const box = await body.boundingBox();
    assert.ok(box.y + 100 < height, `正文在 ${width}px 首屏可编辑`);
    const toolbar = await page.locator('.diary-toolbar').boundingBox();
    assert.ok(toolbar.height <= height * .12, '日记工具保持单行紧凑');
    assert.equal(await page.locator('.diary-toolbar .ms-view-controls').count(), 1, '日记顶栏使用共享导航');
    assert.equal(await page.locator('.ms-editor > .ms-view-tools').isVisible(), false, '外层工具栏由共享控件接管');
    assert.equal(await page.locator('.diary-toolbar .diary-back').count(), 0, '共享导航没有并排的旧返回入口');
    assert.equal(await page.locator('.diary-route .diary-row').count(), 0, '正文内没有重复日记目录');
    await assertFitsViewport(page);
    await capture(page, `manuscript-${width}-editor`);
    if (width < 640) {
      const unfinished = `${diary.body}\n\n还想接着写这一段。`;
      await body.fill(unfinished);
      await page.getByRole('button', { name: '返回文稿列表', exact: true }).click();
      await page.locator('.manuscript-frame[data-pane="sheets"]').waitFor();
      assert.equal(await page.locator('.diary-toolbar').isVisible(), false);
      await page.locator('.manuscript-sheets .library-sheet[aria-current="page"]').click();
      await page.locator('.manuscript-frame[data-pane="editor"]').waitFor();
      assert.equal(await body.inputValue(), unfinished, '通过共享列表往返后保留未保存草稿');
    }

    await body.evaluate(element => {
      element.focus({ preventScroll: true });
      element.setSelectionRange(31, 38);
      window.scrollTo({ top: 220, behavior: 'instant' });
    });
    const scroll = await page.evaluate(() => scrollY);
    await page.getByRole('button', { name: '依据与修订', exact: true }).click();
    await page.locator('#diary-supplement > details[open]').first().waitFor();
    await page.getByRole('button', { name: '回到正文', exact: true }).click();
    const position = await body.evaluate(element => ({
      active: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd, top: scrollY,
    }));
    assert.equal(position.active, true);
    assert.equal(position.start, 31);
    assert.equal(position.end, 38);
    assert.ok(Math.abs(position.top - scroll) <= 2, '返回原来正在写作的段落');
    await page.goto(diary.href);
    await ready(page);
    const prose = page.locator('.diary-prose');
    assert.equal(await prose.innerText(), diary.body);
    assert.ok((await prose.boundingBox()).y + 100 < height, `正文在 ${width}px 首屏可阅读`);
    assert.equal(await page.locator('.ms-editor > .ms-view-tools').isVisible(), false);
    assert.equal(await page.getByRole('navigation', { name: '日记导航', exact: true })
      .getByRole('link', { name: '返回日记列表', exact: true }).getAttribute('href'), '/diaries', '保留旧列表路由');
    await assertFitsViewport(page);
    await capture(page, `manuscript-${width}-reading`);
  }
});

test('collapsed diary evidence retains exact source revisions, backlinks and safe historical reading', { timeout: 30_000 }, async t => {
  const origin = await startService(t);
  const api = await pairPersonalClient(origin);
  const source = await api.invoke('source.create', { kind: 'setting', title: '港口公告', body: '🌧️渡船晚上十点离港。' });
  const excerpt = '晚上十点';
  const range = { start: source.body.indexOf(excerpt), end: source.body.indexOf(excerpt) + excerpt.length };
  const diary = await api.invoke('diary.create', {
    title: '末班渡船', body: '我还记得那晚港口的灯光。', diaryDate: '2026-11-27',
    sourcePins: [{ sourceId: source.sourceId, revision: 1, excerpt, range }],
  });
  const witness = await api.invoke('character.create', { name: '守灯人', entries: [{ label: '夜航记录', blocks: [{
    type: 'reference', kind: 'diary', id: diary.noteId, revision: 1, excerpt: diary.body,
  }] }] });
  await api.invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '渡船晚上九点离港。' });
  const page = await openBrowser(t, origin, { width: 320, height: 740 });
  await page.goto(`${diary.href}?revision=1&edit=1`);
  await ready(page);
  await assertFitsViewport(page);
  const toolbar = await page.locator('.diary-toolbar').boundingBox();
  const currentLink = await page.getByRole('link', { name: '查看当前版本', exact: true }).boundingBox();
  assert.ok(currentLink.y >= toolbar.y && currentLink.y + currentLink.height <= toolbar.y + toolbar.height,
    '固定修订的较长操作文案在窄屏仍保持单行工具栏');
  await capture(page, 'manuscript-320-pinned');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('article').getByText(diary.body, { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存修改', exact: true }).count(), 0);
  assert.equal(await page.locator('.diary-evidence').isVisible(), false);
  await page.getByRole('button', { name: '依据与修订', exact: true }).click();
  const original = page.getByRole('link', { name: '查看资料原文 · 第 1 版', exact: true });
  assert.equal(await original.getAttribute('href'), `/sources/${source.sourceId}?revision=1&start=${range.start}&end=${range.end}`);
  assert.equal(await page.getByRole('link', { name: '守灯人 · 第 1 版 · 夜航记录', exact: true }).getAttribute('href'), `/characters/${witness.characterId}?revision=1`);
  await capture(page, 'manuscript-evidence-phone');
  await page.getByRole('button', { name: '回到正文', exact: true }).click();
  assert.equal(await page.locator('.diary-evidence').isVisible(), false);

  await page.goto(`${diary.href}?edit=1`);
  await ready(page);
  assert.equal(await field(page, '资料版本').inputValue(), '1');
  await page.getByRole('button', { name: '移除资料引用 1', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.waitForURL(`${origin}${diary.href}`);
  await ready(page);
  assert.equal((await api.invoke('diary.read', { noteId: diary.noteId })).sourcePins, undefined);
  await page.getByRole('button', { name: '依据与修订', exact: true }).click();
  await page.getByRole('link', { name: '阅读第 1 版', exact: true }).click();
  await ready(page);
  assert.equal(new URL(page.url()).searchParams.get('revision'), '1');
  assert.equal(await page.getByRole('link', { name: '编辑', exact: true }).count(), 0);
  assert.equal((await api.invoke('diary.read', { noteId: diary.noteId })).revision, 2);
});

test('home resumes a specific edited candidate and an edited diary with an older diary date', { timeout: 30_000 }, async t => {
  const origin = await startService(t);
  const api = await pairPersonalClient(origin);
  const older = await api.invoke('diary.create', { title: '回到很早的一天', body: '这句话还没有写完。', diaryDate: '2000-01-01' });
  for (let index = 1; index <= 6; index++) await api.invoke('diary.create', {
    title: `这个月的日记 ${index}`, body: '近日写下的一句话。', diaryDate: `2026-11-${String(index).padStart(2, '0')}`,
  });
  const scene = await api.invoke('scene.create', { title: '桥下的第三声' });
  const draft = await api.invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '从她的视角讲起', body: '她停下来，听见桥下第三声水响。' });
  const page = await openBrowser(t, origin, { width: 1440, height: 1000 });
  await page.goto(`${older.href}?edit=1`);
  await ready(page);
  await field(page, '正文').fill('现在把这句话接着写完。');
  await page.getByRole('link', { name: '返回日记', exact: true }).click();
  await ready(page);
  await page.getByRole('link', { name: 'Sth 首页', exact: true }).click();
  await page.getByRole('link', { name: `继续编辑日记 ${older.title}`, exact: true }).click();
  await ready(page);
  assert.equal(await field(page, '正文').inputValue(), '现在把这句话接着写完。', '首页接续恢复尚未保存的日记草稿');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.waitForURL(`${origin}${older.href}`);
  await page.goto(draft.href);
  await page.getByRole('heading', { level: 1, name: draft.title, exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await field(page, '正文').fill('她停下来，听见第三声水响，终于回过头来。');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await page.locator('#passage-body').getByText('她停下来，听见第三声水响，终于回过头来。', { exact: true }).waitFor();
  await page.goto('/');
  await page.getByRole('heading', { name: '记一句', exact: true }).waitFor();
  const recent = page.getByRole('region', { name: '最近编辑', exact: true });
  const links = recent.locator('.sth-manuscript-link');
  assert.equal(await links.first().getAttribute('href'), draft.href);
  assert.match(await links.first().innerText(), /候选稿/);
  assert.equal(await recent.getByRole('link', { name: `继续编辑日记 ${older.title}`, exact: true }).getAttribute('href'), `${older.href}?edit=1`);
  assert.equal(await page.locator('#diary-list').getByRole('heading', { name: older.title, exact: true }).count(), 0,
    '最近编辑来自编辑记录，日记日期列表仍按日期展示');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertFitsViewport(page);
    await capture(page, `manuscript-home-${width}`);
  }
  await recent.getByRole('link', { name: `继续编辑候选稿 ${draft.title}`, exact: true }).click();
  await page.waitForURL(`${origin}${draft.href}`);
  await page.getByRole('heading', { level: 1, name: draft.title, exact: true }).waitFor();
});
