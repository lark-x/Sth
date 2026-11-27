import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';

const baseline = process.env.STH_LIBRARY_BASELINE === '1';
const output = process.env.STH_LIBRARY_SUMMARY_ARTIFACTS;
const row = (page, title) => page.locator('.library-sheet').filter({ has: page.getByText(title, { exact: true }) });

async function seed(origin) {
  async function invoke(operationId, input) {
    const response = await fetch(`${origin}/api/web/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, stepId: `library-summary:${randomUUID()}`, input }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  const book = await invoke('project.create', { title: '第三声以后' });
  await invoke('project.create', { title: '另一部作品' });
  const chapter = await invoke('chapter.create', { projectId: book.projectId, title: '旧港来信' });
  const scenes = [];
  let candidate;
  let last;
  for (let index = 0; index < 24; index++) {
    const title = ['退潮以后', '灯塔守夜', '没有来信的早晨'][index] ?? `旧港第 ${index + 1} 幕`;
    const scene = await invoke('scene.create', { title, time: '雾起时', place: '旧码头' });
    scenes.push(scene);
    if (index === 2) continue;
    const body = index === 0 ? '海盐结在信封边上。潮水慢慢退下去，她把那封没有地址的信带回了屋。'
      : index === 1 ? '灯塔的玻璃上覆了一层薄雾。守夜人朝窗外望去，第一班渡船还没有开。'
        : index === 23 ? `${'潮声从石阶下涌上来，渔船在远处变成一线灯火。'.repeat(80)}深处标记暮钟。`
          : '堤岸上脚步很轻，灯光顺着水面的波纹一路散开。';
    const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: scene.revision, title: index === 1 ? '守夜人视角' : `${title}初稿`, body });
    if (index === 0 || index === 23) {
      await invoke('scene.adopt', { sceneId: scene.sceneId, expectedRevision: scene.revision, draftId: draft.draftId, draftRevision: draft.revision });
    }
    if (index === 0) {
      await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: draft.revision, body: '采用以后编辑的未采用新版。' });
    }
    if (index === 1) {
      candidate = await invoke('draft.revise', { draftId: draft.draftId, expectedRevision: draft.revision, body: `${body}岸边的灯还亮着。` });
      await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: scene.revision, title: '渡船视角', body: '别的讲法。' });
    }
    if (index === 23) last = scene;
  }
  await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: chapter.revision, sceneIds: scenes.map(scene => scene.sceneId) });
  return { book, chapter, scenes, candidate, last, invoke };
}

async function ready(page) {
  await page.waitForFunction(() => document.querySelector('.library-sheet-scroll')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('.library-sheet'));
}

function track(page) {
  let calls = [];
  let updatedAt = Date.now();
  const pending = new Set();
  page.on('request', request => {
    if (!request.url().endsWith('/api/web/invoke')) return;
    calls.push(request.postDataJSON());
    pending.add(request);
    updatedAt = Date.now();
  });
  const finished = request => {
    if (pending.delete(request)) updatedAt = Date.now();
  };
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  return async () => {
    const deadline = Date.now() + 5_000;
    while (pending.size || Date.now() - updatedAt < 250) {
      assert.ok(Date.now() < deadline, 'library API requests settle within 5 seconds');
      await delay(25);
    }
    const result = Object.fromEntries([...new Set(calls.map(call => call.operationId))].sort()
      .map(operation => [operation, calls.filter(call => call.operationId === operation).length]));
    const total = calls.length;
    calls = [];
    return { total, ...result };
  };
}

test('real library summaries, collection scope and cold request costs', { timeout: 90_000 }, async t => {
  const origin = await startService(t);
  const fixture = await seed(origin);
  const project = `/projects/${fixture.book.projectId}`;
  const chapter = `${project}?chapterId=${fixture.chapter.chapterId}`;
  if (output) await mkdir(output, { recursive: true });
  const costs = {};

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await openBrowser(t, origin, viewport);
    const takeCosts = track(page);
    await page.goto(project);
    await ready(page);
    const cold = await takeCosts();
    assert.equal(await page.locator('.library-sheet').count(), 24);
    assert.match(await row(page, fixture.scenes[0].title).innerText(), /海盐结在信封边上/);
    assert.match(await row(page, fixture.scenes[2].title).innerText(), /雾起时 · 旧码头/);
    if (!baseline) {
      assert.match(await row(page, fixture.scenes[0].title).innerText(), /采用稿 · 退潮以后初稿 · 第 1 版/);
      assert.match(await row(page, fixture.scenes[1].title).innerText(), /候选稿 · 守夜人视角 · 第 2 版/);
      assert.doesNotMatch(await row(page, fixture.scenes[19].title).innerText(), /堤岸上脚步很轻/);
    }
    await assertFitsViewport(page);
    if (output) await page.screenshot({ path: join(output, `library-${viewport.width}.png`), animations: 'disabled' });

    await page.locator('.library-sheet-scroll').evaluate(list => list.scrollTop = list.scrollHeight);
    if (!baseline) await row(page, fixture.scenes[22].title).getByText(/堤岸上脚步很轻/).waitFor();
    const scroll = await takeCosts();

    await page.reload();
    await ready(page);
    await takeCosts();
    const search = page.getByRole('searchbox', { name: '搜索文稿' });
    await search.fill('深处标记暮钟');
    await row(page, fixture.last.title).waitFor();
    await page.locator('.library-sheets-footer > span').first().getByText('1 / 24 幕', { exact: true }).waitFor();
    if (viewport.width === 1280) await page.locator('#passage-body').getByText(/深处标记暮钟/).waitFor();
    const searchCosts = await takeCosts();
    assert.equal(await page.locator('.library-sheet').count(), 1);
    await search.fill('海盐');
    await row(page, fixture.scenes[0].title).waitFor();
    assert.equal(await page.locator('.library-sheet').count(), 1);
    await search.fill('旧港来信');
    await page.waitForFunction(() => document.querySelectorAll('.library-sheet').length === 24);
    costs[viewport.width] = { cold, scroll, search: searchCosts };

    if (!baseline) {
      await page.goto(chapter);
      await ready(page);
      const candidateRow = row(page, fixture.scenes[1].title);
      await candidateRow.getByText(/守夜人视角 · 第 2 版/).waitFor();
      await candidateRow.click();
      await page.waitForURL(url => url.pathname === `/drafts/${fixture.candidate.draftId}` && url.searchParams.get('revision') === '2');
      await page.locator('#passage-body').getByText(fixture.candidate.body, { exact: true }).waitFor();
      await page.goBack();
      await ready(page);
      assert.equal(await page.locator('.library-sheets-heading h2').textContent(), fixture.chapter.title);
    }
    await page.goto('/create');
    await ready(page);
    if (viewport.width === 1280) await page.locator('#passage-body').waitFor();
    assert.equal(await page.locator('.library-sheets-heading h2').textContent(), '全部文稿');
    if (!baseline && viewport.width === 1280) {
      await row(page, fixture.scenes[2].title).getByText('尚无稿件', { exact: true }).waitFor();
    }
    if (output) await page.screenshot({ path: join(output, `all-${viewport.width}.png`), animations: 'disabled' });
    if (!baseline) {
      await page.getByRole('link', { name: '全部文稿', exact: true }).waitFor();
      assert.equal(await page.locator('.manuscript-library [aria-current="page"]').allTextContents().then(text => text.map(value => value.trim()).join()), '全部文稿');
      assert.equal(await page.locator('.library-project-row[data-active]').count(), 0);
      if (viewport.width === 390) {
        await page.getByRole('link', { name: '全部文稿', exact: true }).click();
        await page.locator('.manuscript-frame[data-pane="sheets"]').waitFor();
        assert.equal(new URL(page.url()).pathname, '/create');
        await row(page, fixture.scenes[1].title).getByText(/守夜人视角 · 第 2 版/).waitFor();
        if (output) await page.screenshot({ path: join(output, 'all-390-sheets.png'), animations: 'disabled' });
      }
      await row(page, fixture.scenes[0].title).click();
      await page.waitForURL(url => url.pathname === `/scenes/${fixture.scenes[0].sceneId}`
        && url.searchParams.get('returnTo') === '/create' && url.searchParams.has('revision'));
      await ready(page);
      assert.equal(await page.locator('.library-sheets-heading h2').textContent(), '全部文稿');
      assert.equal(await page.locator('.library-sheet').count(), 24);
      assert.equal(await page.locator('.library-project-row[data-active]').count(), 0);
    }
    await assertFitsViewport(page);
  }
  t.diagnostic(JSON.stringify(costs));
  if (output) await writeFile(join(output, 'requests.json'), JSON.stringify(costs, null, 2) + '\n');
});

test('full-text search waits for off-screen candidates and reports failed reads before retry', { skip: baseline, timeout: 45_000 }, async t => {
  const origin = await startService(t);
  const fixture = await seed(origin);
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  const release = Promise.withResolvers();
  let fail = true;
  await page.route('**/api/web/invoke', async route => {
    const call = route.request().postDataJSON();
    if (!fail || call.operationId !== 'draft.list' || call.input.sceneId !== fixture.scenes[18].sceneId) return route.continue();
    await release.promise;
    return route.fulfill({ status: 503, json: { error: 'unavailable' } });
  });
  try {
    await page.goto(`/projects/${fixture.book.projectId}`);
    await ready(page);
    await page.getByRole('searchbox', { name: '搜索文稿' }).fill('一个完全不存在的句子');
    await page.locator('.library-empty').getByText('正在搜索正文…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '没有匹配的文稿', exact: true }).count(), 0);
    release.resolve();
    await page.getByText('搜索未完成，部分正文无法读取。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '没有匹配的文稿', exact: true }).count(), 0);
    fail = false;
    await page.getByRole('button', { name: '重试摘要' }).click();
    await page.getByRole('heading', { name: '没有匹配的文稿', exact: true }).waitFor();
    await page.getByRole('searchbox', { name: '搜索文稿' }).fill('岸边的灯还亮着');
    const candidateRow = row(page, fixture.scenes[1].title);
    await candidateRow.waitFor();
    assert.equal(await page.locator('.library-sheet').count(), 1);
    const current = await fixture.invoke('draft.revise', {
      draftId: fixture.candidate.draftId, expectedRevision: fixture.candidate.revision, body: '修订后只出现在第三版。',
    });
    assert.equal(current.revision, 3);
    await candidateRow.click();
    await page.waitForURL(url => url.searchParams.get('revision') === '2');
    await page.locator('#passage-body').getByText(fixture.candidate.body, { exact: true }).waitFor();
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
