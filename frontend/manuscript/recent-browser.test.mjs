import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';
import { pairPersonalClient } from '../../tests/browser/personal-api.mjs';

const storageKey = 'sth:manuscripts:recent:v1';
const shelf = page => page.locator('.manuscript-sheets');
const rows = page => shelf(page).locator('.library-sheet');
const home = page => page.getByRole('region', { name: '最近编辑', exact: true });
async function capture(page, name) {
  const directory = process.env.STH_RECENT_ARTIFACTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' });
}
async function ready(page) {
  await page.locator('.library-sheet-scroll[aria-busy="false"]').waitFor();
}
async function homeReady(page) {
  await page.waitForFunction(() => {
    const section = document.querySelector('[aria-labelledby="recent-manuscripts-title"]');
    return section && !section.textContent.includes('正在读取最近编辑的文稿');
  });
}

test('fresh browsers and home share assistant-written manuscripts without recording collection previews', { timeout: 40_000 }, async t => {
  const origin = await startService(t);
  const api = await pairPersonalClient(origin);
  const page = await openBrowser(t, origin, { width: 1440, height: 1000 });
  await page.goto('/workspace?tab=recent');
  await ready(page);
  await shelf(page).getByRole('heading', { name: '从下一次动笔开始', exact: true }).waitFor();
  await page.goto('/');
  await homeReady(page);
  assert.match(await home(page).innerText(), /写下或打开/);

  const diary = await api.invoke('diary.create', { title: '助手写下的旧日日记', body: '很早的一天，也可以现在继续写。', diaryDate: '2000-01-01' });
  const scene = await api.invoke('scene.create', { title: '助手创建的场景' });
  const draft = await api.invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '助手写下的候选稿', body: '第一声钟响，渡船靠了岸。' });
  const before = await api.invoke('manuscript.recent', {});
  await page.reload();
  await homeReady(page);
  const hrefs = await home(page).locator('.sth-manuscript-link').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
  assert.deepEqual(hrefs, [draft.href, diary.href], 'home collapses the scene and its candidate consistently');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null);
  await page.goto('/workspace?tab=recent');
  await ready(page);
  assert.deepEqual(await rows(page).evaluateAll(elements => elements.map(element => element.getAttribute('href'))), hrefs);
  await capture(page, 'recent-library-remote');
  await page.getByRole('heading', { level: 1, name: draft.title, exact: true }).waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null, 'automatic first-manuscript preview stays out of local history');
  assert.deepEqual((await api.invoke('manuscript.recent', {})).items, before.items);

  await api.invoke('diary.revise', { noteId: diary.noteId, expectedRevision: 1, title: diary.title, diaryDate: diary.diaryDate, body: '另一个助手刚刚补写。' });
  await page.getByRole('button', { name: '刷新资料库和文稿', exact: true }).click();
  await ready(page);
  assert.equal(await rows(page).first().getAttribute('href'), diary.href);
  assert.match(await rows(page).first().innerText(), /另一个助手刚刚补写/);
  await page.goto('/');
  await homeReady(page);
  assert.equal(await home(page).locator('.sth-manuscript-link').first().getAttribute('href'), diary.href);
  assert.equal(await page.locator('#diary-list').getByRole('heading', { name: diary.title, exact: true }).count(), 1);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertFitsViewport(page);
    await capture(page, `recent-home-remote-${width}`);
  }
  await page.goto(draft.href);
  await page.getByRole('heading', { level: 1, name: draft.title, exact: true }).waitFor();
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || '[]').some(item => item.kind === 'draft'), storageKey);
  await page.evaluate(key => {
    const items = JSON.parse(localStorage.getItem(key));
    for (const item of items) item.updatedAt -= 1000;
    localStorage.setItem(key, JSON.stringify(items));
  }, storageKey);
  await api.invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, title: '助手重新命名的候选稿', body: '第二声钟响，渡船又靠了岸。' });
  await page.goto('/');
  await homeReady(page);
  await home(page).getByRole('link', { name: '继续编辑候选稿 助手重新命名的候选稿', exact: true }).waitFor();
  await page.goto('/workspace?tab=recent');
  await ready(page);
  assert.match(await rows(page).first().innerText(), /助手重新命名的候选稿/);
});

test('local exact versions survive newer assistant revisions and shared recent errors recover', { timeout: 40_000 }, async t => {
  const origin = await startService(t);
  const api = await pairPersonalClient(origin);
  const scene = await api.invoke('scene.create', { title: '灯塔的钟声' });
  const draft = await api.invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '第一声', body: '旧灯塔的第一声钟响。' });
  const diary = await api.invoke('diary.create', { title: '最后一班船', diaryDate: '2026-11-27', body: '天黑以前靠岸。' });
  const page = await openBrowser(t, origin, { width: 1440, height: 1000 });
  const exact = `${draft.href}?revision=1&start=0&end=2#passage-body`;
  await page.goto(exact);
  await page.getByRole('heading', { level: 1, name: draft.title, exact: true }).waitFor();
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || '[]').some(item => item.kind === 'draft'), storageKey);
  await api.invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, title: '第二声', body: '助手写下了第二声钟响。' });
  await page.goto('/');
  await homeReady(page);
  assert.equal(await home(page).locator('.sth-manuscript-link').first().getAttribute('href'), exact);
  await page.goto('/workspace?tab=recent');
  await ready(page);
  assert.equal(await rows(page).first().getAttribute('href'), exact);
  assert.match(await rows(page).first().innerText(), /旧灯塔的第一声钟响/);
  const stored = await page.evaluate(key => localStorage.getItem(key), storageKey);
  let fail = true;
  await page.route('**/api/web/invoke', route => route.request().postDataJSON().operationId === 'manuscript.recent' && fail
    ? route.fulfill({ status: 503, json: { code: 'unavailable' } }) : route.continue());
  await page.goto('/');
  await homeReady(page);
  assert.equal(await home(page).locator('.sth-manuscript-link').first().getAttribute('href'), exact);
  await home(page).getByText('跨设备的近期记录暂时无法读取，当前显示本机记录。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), stored);
  await page.goto('/workspace?tab=recent');
  await ready(page);
  assert.equal(await rows(page).first().getAttribute('href'), exact);
  await shelf(page).getByText('部分摘要暂时无法读取，仍可打开文稿。', { exact: true }).waitFor();
  await page.goto('/');
  await homeReady(page);
  fail = false;
  await home(page).getByRole('button', { name: '重新读取最近编辑', exact: true }).click();
  await home(page).getByRole('link', { name: `继续编辑日记 ${diary.title}`, exact: true }).waitFor();
  await page.evaluate(key => localStorage.removeItem(key), storageKey);
  fail = true;
  await page.reload();
  await homeReady(page);
  await home(page).getByRole('alert').waitFor();
  assert.equal(await home(page).locator('.sth-manuscript-link').count(), 0);
  fail = false;
  await home(page).getByRole('button', { name: '重新读取最近编辑', exact: true }).click();
  await home(page).getByRole('link', { name: '继续编辑候选稿 第二声', exact: true }).waitFor();
});
