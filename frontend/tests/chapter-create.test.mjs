import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 800 };
const heading = (page, name) => page.getByRole('heading', { level: 1, name, exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const link = (page, name) => page.getByRole('link', { name, exact: true });
const field = (page, name) => page.getByLabel(new RegExp(`^${name}(?: \\*)?$`));

async function fixture(t) {
  const origin = await startService(t);
  async function invoke(operationId, input) {
    const response = await fetch(`${origin}/api/web/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, input, stepId: `chapter-create:${randomUUID()}` }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  return { origin, invoke };
}

async function capture(page, name) {
  const directory = process.env.STH_CHAPTER_CREATE_ARTIFACTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' });
}

async function openCreation(t, origin, url, viewport = phone) {
  const page = await openBrowser(t, origin, viewport);
  assert.equal((await page.goto(url)).status(), 200);
  if (!url.startsWith('/scenes/new')) {
    await page.locator('.library-sheets-footer').getByRole('link', { name: '新建场景', exact: true }).click();
  }
  await heading(page, '新建场景').waitFor();
  return page;
}

async function submitScene(page, title) {
  await field(page, '标题').fill(title);
  await button(page, '新建场景').click();
}

async function editor(page) {
  await page.waitForURL('**/drafts/new?*', { timeout: 3500 }).catch(async error => {
    const actual = await page.locator('main h1').allTextContents();
    throw new Error(`预期一次保存后进入候选稿编辑器，实际 ${new URL(page.url()).pathname} ${actual.join(' ')}`, { cause: error });
  });
  await field(page, '正文').waitFor();
  return new URL(page.url()).searchParams;
}

test('a chapter scene appends in order and opens the existing draft editor in one save', { timeout: 30_000 }, async t => {
  const { origin, invoke } = await fixture(t);
  const project = await invoke('project.create', { title: '北港纪事' });
  const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '第一章' });
  const first = await invoke('scene.create', { title: '入港' });
  const second = await invoke('scene.create', { title: '收缆' });
  await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [second.sceneId, first.sceneId] });
  const source = `/projects/${project.projectId}?chapterId=${chapter.chapterId}`;
  const page = await openCreation(t, origin, source, desktop);
  await capture(page, 'chapter-form');
  await submitScene(page, '第三声钟响');
  const params = await editor(page);
  const sceneId = params.get('sceneId');
  const scene = await invoke('scene.read', { sceneId });
  assert.equal(params.get('revision'), String(scene.revision));
  assert.equal(new URL(params.get('returnTo'), origin).pathname, `/projects/${project.projectId}`);
  assert.equal(new URL(params.get('returnTo'), origin).searchParams.get('chapterId'), chapter.chapterId);
  assert.equal(new URL(params.get('returnTo'), origin).searchParams.get('selected'), sceneId);
  assert.deepEqual((await invoke('chapter.read', { chapterId: chapter.chapterId })).scenes.map(item => item.sceneId),
    [second.sceneId, first.sceneId, sceneId]);
  await assertFitsViewport(page);
  await capture(page, 'chapter-editor');

  await field(page, '标题').fill('未采用的候选稿');
  await field(page, '正文').fill('第三声钟响，潮水越过旧缆桩。');
  await button(page, '新建候选稿').click();
  await heading(page, '未采用的候选稿').waitFor();
  const draftUrl = page.url();
  await page.reload();
  await heading(page, '未采用的候选稿').waitFor();
  assert.equal(page.url(), draftUrl);
  assert.match(await page.locator('#passage-body').innerText(), /第三声钟响/);
  const reopened = await invoke('scene.read', { sceneId });
  assert.equal(reopened.revision, scene.revision);
  assert.equal(reopened.adoptedDraft, undefined);
  await button(page, '更多').click();
  const back = link(page, `返回${scene.title}`);
  assert.equal(await back.getAttribute('href'), params.get('returnTo'));
  await back.click();
  await page.waitForURL(url => url.searchParams.get('selected') === sceneId);
  await heading(page, scene.title).waitFor();
});

for (const [operationId, committed] of [['scene.create', true], ['chapter.arrange', true], ['scene.create', false]]) {
  test(`${operationId} recovers after reload when the first request ${committed ? 'committed without a response' : 'never reached the server'}`,
    { timeout: 30_000 }, async t => {
      const { origin, invoke } = await fixture(t);
      const project = await invoke('project.create', { title: '回执验收' });
      const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '夜潮' });
      const existing = await invoke('scene.create', { title: '已有场景' });
      await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [existing.sceneId] });
      const source = `/projects/${project.projectId}?chapterId=${chapter.chapterId}`;
      const page = await openCreation(t, origin, source);
      const writes = [];
      const receipts = [];
      await page.route('**/api/web/receipt', async route => {
        receipts.push(route.request().postDataJSON());
        await route.continue();
      });
      await page.route('**/api/web/invoke', async route => {
        const call = route.request().postDataJSON();
        if (['scene.create', 'chapter.arrange'].includes(call.operationId)) writes.push(call);
        if (call.operationId === operationId && writes.filter(item => item.operationId === operationId).length === 1) {
          if (committed) assert.equal((await route.fetch()).status(), 200);
          await route.abort('failed');
        } else await route.continue();
      });
      const title = '失联时提交的一幕';
      await submitScene(page, title);
      await page.getByRole('alert').waitFor();
      const original = writes.find(item => item.operationId === operationId);
      const before = await invoke('scene.list', { title });
      assert.equal(before.items.length, committed ? 1 : 0);
      if (operationId === 'chapter.arrange') {
        await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 3, sceneIds: [before.items[0].sceneId, existing.sceneId] });
      }
      await page.reload();
      const recover = button(page, '重试同一次提交');
      await recover.waitFor();
      assert.equal(await field(page, '标题').isVisible(), false);
      await assertFitsViewport(page);
      if (committed) await capture(page, `lost-${operationId}-recovery`);
      await recover.click();
      const params = await editor(page);
      const sceneId = params.get('sceneId');
      assert.deepEqual(receipts, [{ operationId, stepId: original.stepId }]);
      const attempts = writes.filter(item => item.operationId === operationId);
      assert.deepEqual(attempts, committed ? [original] : [original, original]);
      assert.deepEqual((await invoke('scene.list', { title })).items.map(scene => scene.sceneId), [sceneId]);
      if (committed) assert.equal(sceneId, before.items[0].sceneId);
      const latest = await invoke('chapter.read', { chapterId: chapter.chapterId });
      assert.deepEqual(latest.scenes.map(scene => scene.sceneId), operationId === 'chapter.arrange'
        ? [sceneId, existing.sceneId] : [existing.sceneId, sceneId]);
      assert.equal(latest.revision, operationId === 'chapter.arrange' ? 4 : 3);
    });
}

test('leaving during scene creation never redirects back or starts arrangement in the background', { timeout: 30_000 }, async t => {
  const { origin, invoke } = await fixture(t);
  const project = await invoke('project.create', { title: '离页验收' });
  const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '潮汐' });
  const source = `/projects/${project.projectId}?chapterId=${chapter.chapterId}`;
  const page = await openCreation(t, origin, source, desktop);
  const formUrl = page.url();
  const committed = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  const writes = [];
  await page.route('**/api/web/invoke', async route => {
    const call = route.request().postDataJSON();
    if (['scene.create', 'chapter.arrange'].includes(call.operationId)) writes.push(call);
    if (call.operationId !== 'scene.create') return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  });
  await submitScene(page, '离开前已经提交的场景');
  await committed.promise;
  const region = page.getByRole('region', { name: '场景创建进度' });
  await link(region, '返回').click();
  await page.waitForURL(url => url.pathname === `/projects/${project.projectId}`);
  release.resolve();
  await delivered.promise;
  await page.locator('.library-sheets-footer').getByRole('link', { name: '新建场景', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/projects/${project.projectId}`);
  assert.deepEqual(writes.map(write => write.operationId), ['scene.create']);
  assert.equal((await invoke('chapter.read', { chapterId: chapter.chapterId })).sceneCount, 0);
  await page.goto(formUrl);
  await button(page, '重试同一次提交').click();
  const params = await editor(page);
  assert.deepEqual(writes.map(write => write.operationId), ['scene.create', 'chapter.arrange']);
  assert.equal((await invoke('chapter.read', { chapterId: chapter.chapterId })).scenes[0].sceneId, params.get('sceneId'));
});

test('an empty work asks for a chapter and resumes the same chapter creation after reload', { timeout: 30_000 }, async t => {
  const { origin, invoke } = await fixture(t);
  const project = await invoke('project.create', { title: '首次动笔的作品' });
  const source = `/projects/${project.projectId}?view=overview`;
  const page = await openBrowser(t, origin, phone);
  assert.equal((await page.goto(source)).status(), 200);
  await page.getByRole('region', { name: '开始写作品' }).getByRole('link', { name: '新建场景' }).click();
  await submitScene(page, '雨落在空码头');
  await heading(page, '选择章节').waitFor();
  const choiceUrl = new URL(page.url());
  const sceneId = choiceUrl.searchParams.get('addSceneId');
  assert.ok(sceneId);
  assert.equal((await invoke('scene.read', { sceneId })).placement, undefined);
  assert.deepEqual((await invoke('chapter.list', { projectId: project.projectId })).items, []);
  await assertFitsViewport(page);
  await capture(page, 'empty-work-chapter-choice');

  const chapterWrites = [];
  await page.route('**/api/web/invoke', async route => {
    const call = route.request().postDataJSON();
    if (call.operationId !== 'chapter.create') return route.continue();
    chapterWrites.push(call);
    assert.equal((await route.fetch()).status(), 200);
    await route.abort('failed');
  });
  await link(page, '新建章节').click();
  await field(page, '标题').fill('第一声潮');
  await button(page, '新建章节').click();
  await page.getByRole('alert').waitFor();
  const [chapter] = (await invoke('chapter.list', { projectId: project.projectId })).items;
  assert.equal(chapter.sceneCount, 0);
  await page.reload();
  await button(page, '重试同一次提交').click();
  const params = await editor(page);
  assert.equal(params.get('sceneId'), sceneId);
  assert.equal(params.get('returnTo'), source);
  assert.equal(chapterWrites.length, 1);
  assert.deepEqual((await invoke('chapter.list', { projectId: project.projectId })).items.map(item => item.chapterId), [chapter.chapterId]);
  assert.deepEqual((await invoke('chapter.read', { chapterId: chapter.chapterId })).scenes.map(item => item.sceneId), [sceneId]);
  await capture(page, 'empty-work-editor');
});

test('automatic arrangement appends after every page of a long chapter', { timeout: 30_000 }, async t => {
  const { origin, invoke } = await fixture(t);
  const project = await invoke('project.create', { title: '长章验收' });
  const chapter = await invoke('chapter.create', { projectId: project.projectId, title: '连续的夜晚' });
  const existing = [];
  for (let index = 1; index <= 55; index++) {
    existing.unshift((await invoke('scene.create', { title: `夜晚 ${index}` })).sceneId);
  }
  await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: existing });
  const source = `/projects/${project.projectId}?chapterId=${chapter.chapterId}`;
  const page = await openCreation(t, origin, source);
  await submitScene(page, '最后一夜');
  const sceneId = (await editor(page)).get('sceneId');
  const first = await invoke('chapter.read', { chapterId: chapter.chapterId, limit: 50 });
  const second = await invoke('chapter.read', { chapterId: chapter.chapterId, offset: 50 });
  assert.equal(first.sceneCount, 56);
  assert.deepEqual([...first.scenes, ...second.scenes].map(scene => scene.sceneId), [...existing, sceneId]);
});
