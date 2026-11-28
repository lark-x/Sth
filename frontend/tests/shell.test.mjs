import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';
import { pairPersonalClient } from '../../tests/browser/personal-api.mjs';

const artifacts = new URL('../.artifacts/', import.meta.url);

async function home(page) {
  if (page.viewportSize().width < 640 && await page.locator('.sth-library-toggle').isVisible()) {
    await page.getByRole('button', { name: '打开资料库导航', exact: true }).click();
  } else if (page.viewportSize().width < 640 && await page.locator('.manuscript-frame').count()) {
    await page.locator('.diary-route[aria-busy="false"]').waitFor();
    await page.getByRole('button', { name: '返回文稿列表', exact: true }).click();
    await page.getByRole('button', { name: '资料库', exact: true }).click();
  }
  await page.locator('#library-navigation').getByRole('link', { name: 'Sth 首页', exact: true }).click();
}

async function capture(page, name) {
  if (process.env.STH_BROWSER_ARTIFACTS !== '1') return;
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, artifacts)), fullPage: true, animations: 'disabled' });
}

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
  test(`${name}: Vue home reads real diaries and navigates to pinned and editable records`, { timeout: 40_000 }, async t => {
    const origin = await startService(t);
    const api = await pairPersonalClient(origin);
    const saved = await api.invoke('diary.create', {
      title: '沿河散步', body: '走到桥下时，雨已经停了。想把今天的水声留在这里。', diaryDate: '2026-11-27',
    });
    await api.invoke('diary.create', { title: '给明天留一段', body: '那句话还没有写完，先放在这里，明天接着写。', diaryDate: '2026-11-26' });
    await api.invoke('diary.create', { title: '窗边的小事', body: '下午的光落在杯沿上。', diaryDate: '2026-11-25' });
    const page = await openBrowser(t, origin, viewport);
    const offsite = [];
    page.on('request', request => { if (new URL(request.url()).origin !== origin) offsite.push(request.url()); });
    await page.goto('/');
    await page.getByRole('heading', { name: '记一句', exact: true }).waitFor();
    await page.getByRole('region', { name: '日记接续' }).getByRole('heading', { name: saved.title, exact: true }).waitFor();
    assert.match(await page.locator('#diary-list').innerText(), /今天的水声/);
    assert.equal(await page.locator('#app .sth-app').count(), 1);
    await assertFitsViewport(page);
    await capture(page, name);
    await page.getByRole('link', { name: `继续写 ${saved.title}`, exact: true }).click();
    await page.waitForURL(`${origin}${saved.href}?edit=1`);
    await page.getByRole('textbox', { name: '正文', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '正文', exact: true }).inputValue(), saved.body);
    await page.goto(`${saved.href}?revision=1`);
    await page.getByRole('heading', { name: saved.title, exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('revision'), '1');
    await assertFitsViewport(page);
    await home(page);
    await page.getByRole('heading', { name: '记一句', exact: true }).waitFor();
    await page.getByRole('link', { name: '整理角色', exact: true }).click();
    await page.getByRole('heading', { name: '角色', exact: true }).waitFor();
    if (viewport.width < 640) await page.getByRole('button', { name: '打开资料库导航', exact: true }).click();
    assert.equal(await page.locator('#library-navigation').getByRole('link', { name: '角色', exact: true }).getAttribute('aria-current'), 'page');
    if (viewport.width < 640) await page.getByRole('button', { name: '返回当前页面', exact: true }).click();
    await page.goBack();
    await page.getByRole('heading', { name: '记一句', exact: true }).waitFor();
    await page.getByLabel('此刻想记下什么', { exact: true }).fill('保存下来的一句话。');
    await page.getByRole('button', { name: '记下来', exact: true }).click();
    await page.waitForURL(/\/diaries\/[a-f0-9-]+$/);
    await page.getByRole('heading', { name: '保存下来的一句话。', exact: true }).waitFor();
    const { items } = await api.invoke('diary.list', {});
    assert.equal(items.filter(item => item.body === '保存下来的一句话。').length, 1);
    assert.deepEqual(offsite, [], 'the built UI makes no offsite asset or font requests');
  });
}

test('quick capture preserves its request across a lost response and reload, then replays once', { timeout: 30_000 }, async t => {
  const origin = await startService(t);
  const api = await pairPersonalClient(origin);
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  let accepted;
  await page.route('**/api/web/invoke', async route => {
    const call = route.request().postDataJSON();
    if (call.operationId === 'diary.create' && !accepted) {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      accepted = call;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto('/');
  await page.getByLabel('此刻想记下什么', { exact: true }).fill('这条只能保存一次。');
  await page.getByRole('button', { name: '记下来', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '保存结果暂未确认' }).waitFor();
  await page.reload();
  assert.equal(await page.getByLabel('此刻想记下什么', { exact: true }).inputValue(), '这条只能保存一次。');
  await page.getByRole('button', { name: '核对并重试', exact: true }).click();
  await page.waitForURL(/\/diaries\/[a-f0-9-]+$/);
  const { items } = await api.invoke('diary.list', {});
  assert.equal(items.length, 1);
  assert.equal(items[0].body, accepted.input.body);
});

test('a late quick capture response preserves a newer draft after a successful retry', { timeout: 30_000 }, async t => {
  const origin = await startService(t);
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  let release;
  let first;
  let accepted;
  const held = new Promise(resolve => { release = resolve; });
  const committed = new Promise(resolve => { accepted = resolve; });
  await page.route('**/api/web/invoke', async route => {
    if (route.request().postDataJSON().operationId === 'diary.create' && !first) {
      first = route.request();
      const response = await route.fetch();
      accepted();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await page.goto('/');
    await page.getByLabel('此刻想记下什么', { exact: true }).fill('已保存但响应迟到的第一句。');
    await page.getByRole('button', { name: '记下来', exact: true }).click();
    await committed;
    await page.getByRole('link', { name: '查看资料', exact: true }).click();
    await page.getByRole('heading', { name: '资料', exact: true }).waitFor();
    await home(page);
    await page.getByRole('button', { name: '核对并重试', exact: true }).click();
    await page.waitForURL(/\/diaries\/[a-f0-9-]+$/);
    await home(page);
    await page.getByLabel('此刻想记下什么', { exact: true }).fill('这是接下来要写的第二句。');
    const completed = page.waitForResponse(response => response.request() === first);
    release();
    await (await completed).finished();
    await page.waitForTimeout(100);
    assert.equal(await page.getByLabel('此刻想记下什么', { exact: true }).inputValue(), '这是接下来要写的第二句。');
  } finally { release(); }
});

test('home shows empty and recoverable error states and preserves an unsaved capture', { timeout: 30_000 }, async t => {
  const origin = await startService(t);
  const page = await openBrowser(t, origin, { width: 320, height: 800 });
  await page.goto('/');
  await page.getByText('日记本还是空的', { exact: true }).waitFor();
  await assertFitsViewport(page);
  await capture(page, 'empty-320');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '跳到正文');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
  await page.getByLabel('此刻想记下什么', { exact: true }).fill('还没有保存的想法');
  await page.getByRole('link', { name: '查看资料', exact: true }).click();
  await page.getByRole('heading', { name: '资料', exact: true }).waitFor();
  await page.goBack();
  assert.equal(await page.getByLabel('此刻想记下什么', { exact: true }).inputValue(), '还没有保存的想法');
  await page.route('**/api/web/invoke', async route => {
    if (route.request().postDataJSON().operationId === 'diary.list') await route.fulfill({ status: 503, json: { error: 'unavailable' } });
    else await route.continue();
  });
  await page.reload();
  await page.getByRole('button', { name: '重新读取', exact: true }).waitFor();
  await capture(page, 'error-320');
  await page.unroute('**/api/web/invoke');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.getByText('日记本还是空的', { exact: true }).waitFor();
  await assertFitsViewport(page);
});

test('phone keyboard navigation reaches the visible library and sheet list', async t => {
  const origin = await startService(t);
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开资料库导航', exact: true }).click();
  await page.getByRole('link', { name: '全部文稿', exact: true }).click();
  for (const pane of ['.manuscript-library', '.manuscript-sheets']) {
    await page.locator(pane).waitFor({ state: 'visible' });
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(pane).evaluate(element => element === document.activeElement), true);
    assert.equal(new URL(page.url()).hash, '');
    if (pane === '.manuscript-library') await page.getByRole('link', { name: '日记', exact: true }).click();
  }
});

test('shell dispatches exact migration routes and keeps unknown subroutes on the legacy fallback', { timeout: 30_000 }, async t => {
  const origin = await startService(t);
  const page = await openBrowser(t, origin, { width: 1280, height: 900 });
  for (const path of ['/create', '/projects']) {
    await page.goto(path);
    await page.locator('.manuscript-frame').waitFor();
    assert.equal(await page.getByRole('link', { name: '全部文稿', exact: true }).getAttribute('aria-current'), 'page');
    await assertFitsViewport(page);
  }
  for (const path of ['/workspace']) {
    await page.goto(path);
    await page.locator('.creative-entry').waitFor();
    assert.equal(await page.locator('#library-navigation [aria-current="page"]').count(), 0, 'auxiliary pages do not highlight a manuscript collection');
    assert.equal(await page.locator('#library-navigation').getByRole('link', { name: '全部文稿', exact: true }).getAttribute('href'), '/projects');
  }
  for (const path of ['/settings', '/settings/connections']) {
    await page.goto(path);
    await page.getByRole('heading', { name: '连接设置', exact: true }).waitFor();
    assert.equal(await page.locator('.legacy-route').count(), 0);
  }
  await page.goto('/author-context');
  await page.locator('.author-context').waitFor();
  assert.equal(await page.locator('#library-navigation [aria-current="page"]').count(), 0, 'auxiliary pages do not highlight a manuscript collection');
    assert.equal(await page.locator('#library-navigation').getByRole('link', { name: '全部文稿', exact: true }).getAttribute('href'), '/projects');
  for (const path of ['/sources', '/sources/new']) {
    await page.goto(path);
    await page.locator('.sources-domain').waitFor();
    assert.equal(await page.locator('#library-navigation').getByRole('link', { name: '资料', exact: true }).getAttribute('aria-current'), path.split('?')[0] === '/sources' ? 'page' : null);
  }
  for (const path of ['/research', '/judgments', '/sources/id/unknown', '/sources?action=unsupported']) {
    await page.goto(path);
    await page.locator('.legacy-route').waitFor();
    assert.equal(await page.locator('.sources-domain').count(), 0);
    assert.equal(await page.locator('#library-navigation').getByRole('link', { name: '资料', exact: true }).getAttribute('aria-current'), path.split('?')[0] === '/sources' ? 'page' : null);
  }
  for (const path of ['/characters', '/characters/new']) {
    await page.goto(path);
    await page.locator('.characters-route').waitFor();
    assert.equal(await page.locator('#library-navigation').getByRole('link', { name: '角色', exact: true }).getAttribute('aria-current'), path === '/characters' ? 'page' : null);
  }
  for (const path of ['/jobs', '/tasks']) {
    await page.goto(path);
    await page.locator('.tasks-domain').waitFor();
    assert.equal(await page.locator('#library-navigation').getByRole('link', { name: '任务', exact: true }).getAttribute('aria-current'), 'page');
  }
  for (const path of ['/characters/id/history', '/characters/id?action=unknown', '/jobs/new', '/media', '/generations']) {
    await page.goto(path);
    await page.locator('.legacy-route').waitFor();
  }
  for (const path of ['/drafts/new', '/scenes/id?revision=1', '/scenes/id?action=compare', '/scenes/id?action=branch', '/drafts/id?action=revise', '/drafts/id?action=adopt']) {
    await page.goto(path);
    await page.locator('.writing-route').waitFor();
    await page.locator('.manuscript-frame').waitFor();
    await page.getByRole('navigation', { name: '文稿资料库', exact: true }).waitFor();
  }
  for (const path of ['/scenes/id?narrativeId=story', '/scenes/id?action=revise', '/scenes/id?action=adopt', '/drafts/id?action=adopt-entry', '/scenes/id/unknown']) {
    await page.goto(path);
    await page.locator('.legacy-route').waitFor();
  }
  for (const path of ['/settings/unknown', '/settings/connections/nested', '/author-context/nested', '/create/unknown', '/workspace/unknown']) {
    await page.goto(path);
    await page.locator('.legacy-route').waitFor();
    await page.getByRole('heading', { name: '找不到页面', exact: true }).waitFor();
  }
});
