import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { connectionsDDL } from '../../src/connections.ts';
import { operationsDDL } from '../../src/core/index.ts';
import { startGenerationWorker } from '../../src/generation/index.ts';
import { startJobsWorker } from '../../src/jobs/index.ts';
import { createApp } from '../../src/server.ts';
import { workspaceDDL } from '../../src/workspace.ts';
import { assertFitsViewport, openBrowser, screenshot, startService } from './harness.mjs';

const desktop = { width: 1280, height: 900 };
const narrow = { width: 390, height: 844 };
const timeout = 60_000;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ4sAAAAASUVORK5CYII=', 'base64');

async function launch(t, viewport, { generation, media } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; ${operationsDDL} ${workspaceDDL} ${connectionsDDL}`);
  const server = createApp(db, { mediaProvider: media });
  const workers = [];
  server.listen(0, '127.0.0.1');
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.stop()));
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  await once(server, 'listening');
  if (generation) workers.push(startGenerationWorker(db, { provider: generation, pollIntervalMs: 15 }));
  if (media) workers.push(startJobsWorker(db, { provider: media, pollIntervalMs: 15 }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await openBrowser(t, origin, viewport);
  async function invoke(operationId, input) {
    const response = await fetch(`${origin}/api/web/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, input, stepId: `workspace-test:${randomUUID()}` }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result;
  }
  return { page, origin, invoke };
}

const heading = (page, name) => page.getByRole('heading', { level: 1, name, exact: true });
const clickLink = (page, name) => page.getByRole('link', { name, exact: true }).click();
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const control = (page, name) => page.getByLabel(new RegExp(`^${RegExp.escape(name)}(?: \\*)?$`));
const fill = (page, name, text) => control(page, name).fill(text);
const choose = (page, name, label) => control(page, name).selectOption({ label });
const idAt = page => new URL(page.url()).pathname.split('/').at(-1);

async function goto(page, href, title) {
  assert.equal((await page.goto(href)).status(), 200);
  await heading(page, title).waitFor().catch(async error => {
    throw new Error(`Expected ${title} at ${href}. Page content: ${await page.locator('main').innerText()}`, { cause: error });
  });
}

async function waitFor(check) {
  const deadline = Date.now() + 6000;
  do {
    const value = await check();
    if (value) return value;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail('timed out waiting for worker state');
}

test('workspace phase 1: create and search sources, revise, and follow exact diary backlinks', { timeout }, async t => {
  const { page, invoke } = await launch(t, narrow);
  await goto(page, '/sources', '资料');
  await clickLink(page, '新建资料');
  await choose(page, '类型', '设定');
  await fill(page, '标题', '北港渡船');
  await fill(page, '正文', '北港末班渡船是晚上十点。');
  await fill(page, '出处', '港口公告牌');
  await click(page, '新建资料');
  await heading(page, '北港渡船').waitFor();
  const sourceId = idAt(page);
  assert.equal((await invoke('source.read', { sourceId })).origin, '港口公告牌');

  await goto(page, '/diaries/new', '写日记');
  await fill(page, '标题', '最后一班船');
  await fill(page, '正文', '我在钟响前登船。');
  await page.locator('summary').filter({ hasText: /^资料引用/ }).click();
  await click(page, '添加资料引用');
  await choose(page, '资料', '北港渡船 · 第 1 版');
  const citationPreview = page.getByRole('link', { name: '查看所选版本原文', exact: true });
  assert.equal(await citationPreview.getAttribute('href'), `/sources/${sourceId}?revision=1`);
  await fill(page, '引用原文', '晚上十点');
  await click(page, '保存日记');
  await heading(page, '最后一班船').waitFor();
  const noteId = idAt(page);
  const diary = await invoke('diary.read', { noteId });
  assert.equal(diary.sourcePins[0].revision, 1);

  await clickLink(page, '查看资料原文 · 第 1 版');
  await heading(page, '北港渡船').waitFor();
  assert.match(page.url(), /\/sources\/[^?]+\?revision=1$/);
  await clickLink(page, '修订资料');
  await fill(page, '正文', '北港末班渡船是晚上九点。');
  await click(page, '保存修订');
  await page.getByText('北港末班渡船是晚上九点。', { exact: true }).waitFor();
  assert.equal((await invoke('source.read', { sourceId })).revision, 2);
  await clickLink(page, '第 1 版');
  await page.getByText('北港末班渡船是晚上十点。', { exact: true }).waitFor();
  await assertFitsViewport(page);
  await screenshot(page, 'narrow', 'workspace-source-history');
  await clickLink(page, '日记 · 最后一班船 · 第 1 版');
  await heading(page, '最后一班船').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('revision'), '1');

  await goto(page, '/sources', '资料');
  await fill(page, '关键词', '晚上九点');
  await page.getByLabel('关键词').press('Enter');
  await page.getByRole('link', { name: /北港渡船/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('q'), '晚上九点');
});

test('workspace phase 2: compare and adopt exact drafts, arrange a chapter, and branch the scene', { timeout }, async t => {
  const { page, invoke } = await launch(t, desktop);
  const { projectId } = await invoke('project.create', { title: '港口手记' });
  const nextScene = await invoke('scene.create', { title: '清晨返航' });
  await goto(page, '/scenes', '场景');
  await clickLink(page, '新建场景');
  await fill(page, '标题', '北港夜航');
  await fill(page, '地点', '北港');
  await click(page, '新建场景');
  await heading(page, '北港夜航').waitFor();
  const sceneId = idAt(page);
  for (const [title, body] of [['远景', '风吹过百盏港灯。'], ['近景', '船票在她手里打湿了。']]) {
    await clickLink(page, '新建候选稿');
    await fill(page, '标题', title);
    await fill(page, '正文', body);
    await click(page, '新建候选稿');
    await heading(page, title).waitFor();
    await goto(page, `/scenes/${sceneId}`, '北港夜航');
  }
  await clickLink(page, '对照候选稿');
  await page.getByRole('article').getByText('风吹过百盏港灯。').waitFor();
  await page.getByRole('article').getByText('船票在她手里打湿了。').waitFor();
  await assertFitsViewport(page);
  await screenshot(page, 'desktop', 'workspace-draft-comparison');
  await clickLink(page, '采纳右稿');
  await click(page, '采纳候选稿');
  await heading(page, '北港夜航').waitFor();
  const scene = await invoke('scene.read', { sceneId });
  assert.equal(scene.adopted.title, '近景');
  await goto(page, `/drafts/${scene.adopted.draftId}?revision=1`, '近景');
  await page.getByText('船票在她手里打湿了。', { exact: true }).waitFor();

  await goto(page, '/chapters', '章节');
  await clickLink(page, '新建章节');
  await choose(page, '项目', '港口手记');
  await fill(page, '标题', '第一章');
  await click(page, '新建章节');
  await heading(page, '第一章').waitFor();
  const chapterId = idAt(page);
  await clickLink(page, '编排章节');
  await click(page, '添加场景');
  await choose(page, '场景', '北港夜航');
  await click(page, '添加场景');
  await control(page, '场景').nth(1).selectOption({ label: nextScene.title });
  await page.getByRole('button', { name: '上移', exact: true }).nth(1).click();
  await click(page, '编排章节');
  await page.getByRole('link', { name: /北港夜航/ }).waitFor();
  const chapter = await invoke('chapter.read', { chapterId });
  assert.equal(chapter.projectId, projectId);
  assert.deepEqual(chapter.scenes.map(scene => scene.sceneId), [nextScene.sceneId, sceneId]);
  assert.equal(chapter.scenes[1].adopted.draftId, scene.adopted.draftId);

  await goto(page, `/scenes/${sceneId}?revision=2`, '北港夜航');
  await clickLink(page, '建立 IF 分支');
  await fill(page, '分歧点', '她没有上船。');
  await fill(page, '标题', '错过末班船');
  await click(page, '建立 IF 分支');
  await heading(page, '错过末班船').waitFor();
  const branch = await invoke('scene.read', { sceneId: idAt(page) });
  assert.deepEqual(branch.branchFrom, { sceneId, revision: 2, divergence: '她没有上船。', draft: { draftId: scene.adopted.draftId, revision: 1 } });
});

test('workspace phase 3: edit a reusable template and read pinned and delegated structured output', { timeout }, async t => {
  const generation = { prepare: () => ({ execute: async () => ({ content: '{"ending":"夜更深了。"}',
    reportedModel: 'fixture-reported', responseId: 'fixture-1', finishReason: 'stop' }) }) };
  const { page, invoke } = await launch(t, narrow, { generation });
  const source = await invoke('source.create', { kind: 'setting', title: '海雾', body: '海雾在凌晨降下。' });
  await goto(page, '/templates', '内容模板');
  await clickLink(page, '新建模板');
  await fill(page, '标题', '夜航分镜');
  await choose(page, '类型', '分镜');
  await fill(page, '字段标识', 'ending');
  await fill(page, '显示名称', '结尾');
  await click(page, '新建模板');
  await heading(page, '夜航分镜').waitFor();
  const templateId = idAt(page);
  await page.getByText('结尾', { exact: true }).waitFor();

  await goto(page, '/generations', '生成记录');
  await clickLink(page, '准备写作');
  await fill(page, '标题', '北港分镜草案');
  await fill(page, '创作要求', '从码头的视角收尾。');
  await choose(page, '内容模板', '夜航分镜 · 第 1 版');
  await click(page, '添加参考资料');
  await choose(page, '类型', '资料');
  await choose(page, '记录编号', '海雾 · 第 1 版');
  await fill(page, '引用原文', '海雾在凌晨降下。');
  await click(page, '准备写作');
  await heading(page, '北港分镜草案').waitFor();
  const generationId = idAt(page);
  const prepared = await invoke('generations.get', { generationId });
  assert.equal(prepared.composition.references[0].id, source.sourceId);
  assert.equal(prepared.composition.references[0].revision, 1);
  await clickLink(page, '保存结构化稿件');
  await fill(page, '结尾', '港灯在浪尖熄灭。');
  await click(page, '保存结构化稿件');
  await page.getByRole('link', { name: '北港分镜草案', exact: true }).click();
  await page.getByText('港灯在浪尖熄灭。', { exact: true }).waitFor();
  await goto(page, `/generations/${generationId}/result`, '北港分镜草案');

  await goto(page, `/templates/${templateId}`, '夜航分镜');
  await clickLink(page, '修订内容模板');
  await fill(page, '显示名称', '末尾分镜');
  await click(page, '保存修订');
  await page.getByText('末尾分镜', { exact: true }).waitFor();
  await clickLink(page, '第 1 版');
  await page.getByText('结尾', { exact: true }).waitFor();

  await goto(page, '/generation-plans', '生成方案');
  await clickLink(page, '新建生成方案');
  await fill(page, '标题', '分镜对照方案');
  await fill(page, '供应商', 'fixture');
  await fill(page, '模型', 'fixture-requested');
  await click(page, '新建生成方案');
  await heading(page, '分镜对照方案').waitFor();
  const planId = idAt(page);
  await goto(page, `/generation-plans/${planId}?revision=1`, '分镜对照方案');
  await goto(page, `/generations/${generationId}`, '北港分镜草案');
  await clickLink(page, '用指定方案生成对照稿');
  await choose(page, '生成方案', '分镜对照方案 · 第 1 版');
  await click(page, '用指定方案生成对照稿');
  await page.waitForURL(url => /^\/generations\/[^/]+$/.test(url.pathname) && url.pathname !== `/generations/${generationId}`);
  const delegatedId = idAt(page);
  const stored = await waitFor(async () => {
    const record = await invoke('generations.get', { generationId: delegatedId });
    return record.status === 'succeeded' && record;
  });
  assert.equal(stored.composition.template.revision, 1);
  assert.equal(stored.execution.reportedModel, 'fixture-reported');
  await click(page, '刷新状态');
  await page.getByText('fixture-reported', { exact: true }).waitFor();
  await clickLink(page, '提示词组成');
  await page.getByText('已发送', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/generations/${delegatedId}/prompt`);
  await page.getByRole('link', { name: '分镜对照方案 · 第 1 版', exact: true }).waitFor();
  await clickLink(page, '生成记录');
  await page.getByText('fixture-reported', { exact: true }).waitFor();
  await assertFitsViewport(page);
  await screenshot(page, 'narrow', 'workspace-generation-record');

  await goto(page, '/generations', '生成记录');
  await clickLink(page, '文本批量任务');
  await clickLink(page, '新建文本批量任务');
  await fill(page, '标题', '北港批量对照');
  await choose(page, '生成方案', '分镜对照方案 · 第 1 版');
  await choose(page, '生成记录', '北港分镜草案');
  await click(page, '新建文本批量任务');
  await heading(page, '北港批量对照').waitFor();
  const batchId = idAt(page);
  const batch = await waitFor(async () => {
    const record = await invoke('generation.batches.get', { batchId });
    return record.status === 'succeeded' && record;
  });
  assert.equal(batch.plan.planId, planId);
  assert.equal(batch.items[0].generation.sourceGenerationId, generationId);
  await click(page, '刷新状态');
  await page.getByRole('heading', { name: '尝试历史' }).waitFor();
  await assertFitsViewport(page);

  await goto(page, '/writing-requirements', '写作要求');
  await clickLink(page, '新建写作要求');
  await fill(page, '标题', '观察手记');
  await fill(page, '叙述视角', '第一人称');
  await click(page, '新建写作要求');
  await heading(page, '观察手记').waitFor();
  const requirementId = idAt(page);
  await clickLink(page, '修订写作要求');
  await fill(page, '叙述视角', '第三人称');
  await click(page, '保存修订');
  await page.getByText('第三人称', { exact: true }).waitFor();
  await goto(page, `/writing-requirements/${requirementId}?revision=1`, '观察手记');
  await page.getByText('第一人称', { exact: true }).waitFor();
});

test('workspace phase 4: select compositions, retry a failed job item, reconcile uncertainty, and open the saved image', { timeout }, async t => {
  const submissions = new Map();
  const media = { name: 'fixture', key: 'workspace-fixture', parameters: { width: 1, height: 1 },
    async submit({ prompt, requestId }) {
      const count = (submissions.get(prompt) ?? 0) + 1;
      submissions.set(prompt, count);
      if (prompt === '失败后重试' && count === 1) return { state: 'failed', message: 'fixture rejection' };
      if (prompt === '需要核对') return { state: 'unknown', message: 'fixture lost receipt' };
      return { state: 'submitted', providerJobId: requestId };
    },
    async lookup({ requestId }) { return { state: 'succeeded', providerJobId: requestId, bytes: png }; },
  };
  const { page, invoke, origin } = await launch(t, narrow, { media });
  const { projectId } = await invoke('project.create', { title: '北港画册' });
  const { chapterId, revision } = await invoke('chapter.create', { projectId, title: '夜航' });
  const scene = await invoke('scene.create', { title: '渡船甲板' });
  await invoke('chapter.arrange', { chapterId, expectedRevision: revision, sceneIds: [scene.sceneId] });
  const selected = [];
  for (const prompt of ['失败后重试', '需要核对']) {
    await goto(page, `/scenes/${scene.sceneId}`, '渡船甲板');
    await clickLink(page, '新建构图');
    await fill(page, '标题', prompt);
    await fill(page, '画面描述', prompt);
    await click(page, '新建构图');
    await heading(page, '渡船甲板 · 构图').waitFor();
    await click(page, `选用 ${prompt}`);
    await page.getByText('· 已选用', { exact: true }).waitFor();
    selected.push(idAt(page));
  }
  await clickLink(page, '用此构图新建任务');
  await fill(page, '标题', '北港出图');
  await click(page, '添加任务项');
  await control(page, '任务项').nth(1).selectOption(selected[0]);
  await click(page, '启动任务');
  await heading(page, '北港出图').waitFor();
  const jobId = idAt(page);
  await waitFor(async () => {
    const job = await invoke('jobs.read', { jobId });
    return job.progress.failed === 1 && job.progress.unknown === 1;
  });
  await click(page, '刷新状态');
  await click(page, '重试 失败后重试');
  await page.getByRole('button', { name: '核对 需要核对', exact: true }).waitFor();
  await click(page, '核对 需要核对');
  const stored = await waitFor(async () => {
    const job = await invoke('jobs.read', { jobId });
    return job.progress.succeeded === 2 && job;
  });
  assert.equal(submissions.get('失败后重试'), 2);
  assert.equal(submissions.get('需要核对'), 1);
  await click(page, '刷新状态');
  await page.getByRole('link', { name: '查看生成图片', exact: true }).first().click();
  await heading(page, stored.items[0].title).waitFor();
  const mediaId = stored.items[0].mediaId;
  const metadata = await invoke('media.read', { mediaId });
  const image = page.getByRole('img', { name: metadata.title });
  await image.waitFor();
  await waitFor(() => image.evaluate(img => img.naturalWidth === 1));
  const binary = await fetch(new URL(await image.getAttribute('src'), origin));
  assert.equal(binary.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), png);
  await assertFitsViewport(page);
  await screenshot(page, 'narrow', 'workspace-media-preview');
  await clickLink(page, '查看场景 · 第 1 版');
  await heading(page, '渡船甲板').waitFor();
  assert.match(page.url(), /revision=1$/);
  await goto(page, '/media', '媒体');
  await page.getByRole('link', { name: /需要核对/ }).waitFor();
  await clickLink(page.getByRole('navigation', { name: '任务视图' }), '全部任务');
  await page.getByText('图片供应商 · 可用 · fixture', { exact: true }).waitFor();
  const activity = (await invoke('tasks.list', {})).items.find(item => item.id === jobId);
  assert.equal(activity.kind, 'media');
  assert.equal(activity.status, 'succeeded');
  await clickLink(page, activity.title);
  await page.getByRole('progressbar', { name: '已结束任务项' }).waitFor();
  assert.equal(new URL(page.url()).pathname, activity.href);
});

test('research: disambiguate a repeated excerpt and keep historical evidence through diary, judgment and character', { timeout }, async t => {
  const { page, invoke } = await launch(t, narrow);
  const body = '🚢 第一张：末班十点。\n第二张：末班十点。';
  const excerpt = '末班十点';
  const start = body.lastIndexOf(excerpt);
  const range = { start, end: start + excerpt.length };
  const source = await invoke('source.create', { title: '北港通告', kind: 'excerpt', body, origin: '码头公告牌' });
  const character = await invoke('character.create', { name: '守船人' });
  await goto(page, '/sources', '资料');
  await fill(page, '关键词', excerpt);
  await click(page, '搜索');
  await clickLink(page, '北港通告');
  await clickLink(page, '定位第 2 处');
  assert.equal(await page.locator('#passage-body mark').textContent(), excerpt);
  const exact = new URL(page.url());
  assert.equal(exact.searchParams.get('start'), String(start));
  await click(page, '用作判断依据');
  await fill(page, '标题', '夜航时刻');
  await fill(page, '判断', '此通告适用于旧航线。');
  await fill(page, '适用范围', '北港旧航线');
  await click(page, '新建判断');
  await heading(page, '夜航时刻').waitFor();
  const judgmentId = idAt(page);
  assert.deepEqual((await invoke('judgment.read', { judgmentId })).evidence[0].pin.range, range);
  await clickLink(page, '原文 · 第 1 版');
  await click(page, '引用到日记');
  await fill(page, '标题', '北港日记');
  await fill(page, '正文', '我赶上了船。');
  await click(page, '保存日记');
  await heading(page, '北港日记').waitFor();
  const noteId = idAt(page);
  await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '末班九点。' });
  await page.reload();
  await clickLink(page, '查看资料原文 · 第 1 版');
  assert.equal(await page.locator('#passage-body mark').textContent(), excerpt);
  assert.deepEqual((await invoke('diary.read', { noteId })).sourcePins[0].range, range);
  await page.getByRole('link', { name: '判断 · 夜航时刻 · 第 1 版' }).waitFor();

  const scene = await invoke('scene.create', { title: '船边' });
  const draftText = '他喊：等一下。\n他又喊：等一下。';
  const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '两次喊话', body: draftText });
  const draftStart = draftText.lastIndexOf('等一下。');
  const draftHref = `/drafts/${draft.draftId}?revision=1&start=${draftStart}&end=${draftText.length}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    await goto(page, draftHref, '两次喊话');
    await click(page, '采纳为角色条目');
    await choose(page, '采纳到角色', '守船人');
    await fill(page, '条目名称', '第二次喊话');
    await choose(page, '同时引用判断', '夜航时刻 · 第 1 版');
    await page.getByText('此通告适用于旧航线。', { exact: true }).waitFor();
    if (attempt === 0) await invoke('character.revise', { characterId: character.characterId, expectedRevision: 1, persona: '正在修订的角色设定。' });
    await click(page, '采纳条目');
    await heading(page, '守船人').waitFor();
  }
  const card = await invoke('character.read', { characterId: character.characterId });
  assert.equal(card.entries.length, 1);
  assert.equal(card.persona, '正在修订的角色设定。');
  assert.deepEqual(card.entries[0].blocks[0].range, { start: draftStart, end: draftText.length });
  assert.equal(card.entries[0].blocks[1].id, judgmentId);
  await clickLink(page, '候选稿 · 第 1 版');
  await heading(page, '两次喊话').waitFor();
  assert.equal(await page.locator('#passage-body mark').textContent(), '等一下。');
  await assertFitsViewport(page);
  await screenshot(page, 'narrow', 'exact-passage');
});

test('story: record partial event order, save a limited telling and resume its IF after reload', { timeout }, async t => {
  const { page, invoke } = await launch(t, desktop);
  const scene = await invoke('scene.create', { title: '码头分歧' });
  const character = await invoke('character.create', { name: '温妮莎' });
  const source = await invoke('source.create', { kind: 'setting', title: '港口原文', body: '船已启程。密令藏在舱底。' });
  const evidence = [{ kind: 'source', sourceId: source.sourceId, revision: 1, excerpt: '船已启程。', range: { start: 0, end: 5 } }];
  const visible = await invoke('event.save', { title: '船离岸', summary: '船已经离岸。', evidence });
  const hidden = await invoke('event.save', { title: '秘密命令', summary: '密令内容仅船长知晓。', evidence });
  await goto(page, `/events/${visible.eventId}`, '船离岸');
  await clickLink(page, '记录事件先后');
  await choose(page, '后发生', '秘密命令 · 第 1 版');
  await click(page, '记录事件先后');
  await page.getByRole('listitem').filter({ hasText: '船离岸 先于 秘密命令' }).waitFor();
  await goto(page, `/scenes/${scene.sceneId}`, '码头分歧');
  await clickLink(page, '新建讲述');
  await fill(page, '标题', '岸上目击');
  await choose(page, '类型', '角色');
  await choose(page, '角色', '温妮莎 · 第 1 版');
  await click(page, '添加讲述顺序');
  await control(page, '事件').nth(0).selectOption(visible.eventId);
  await click(page, '添加讲述顺序');
  await control(page, '事件').nth(1).selectOption(hidden.eventId);
  await click(page, '添加视角已知事件');
  await control(page, '事件').nth(2).selectOption(visible.eventId);
  await click(page, '新建讲述');
  await heading(page, '岸上目击').waitFor();
  const narrativeId = idAt(page);
  const narrative = await invoke('narrative.read', { narrativeId });
  assert.equal(narrative.viewpoint.characterId, character.characterId);
  assert.deepEqual(narrative.eventOrder.map(item => item.eventId), [visible.eventId, hidden.eventId]);
  await goto(page, narrative.href, '岸上目击');
  await clickLink(page, '用此讲述准备写作');
  await fill(page, '创作要求', '用岸上看到的动作写一段。');
  await control(page, '内容模板').selectOption('short-story');
  await click(page, '准备写作');
  await heading(page, '岸上目击').waitFor();
  const generationId = idAt(page);
  await clickLink(page, '提示词组成');
  await page.locator('.prompt-text').first().waitFor();
  assert.match(await page.locator('.prompt-text').allTextContents().then(text => text.join('\n')), /船已经离岸/);
  assert.doesNotMatch(await page.locator('.prompt-text').allTextContents().then(text => text.join('\n')), /密令内容仅船长知晓/);
  assert.equal(new URL(page.url()).pathname, `/generations/${generationId}/prompt`);
  await fill(page, '查找消息文字', '船已经离岸');
  await click(page, '查找');
  await page.locator('#prompt-origin').getByRole('link', { name: '打开事件 · 第 1 版' }).click();
  await heading(page, '船离岸').waitFor();
  await page.locator('#event-summary-body mark').getByText('船已经离岸。', { exact: true }).waitFor();
  await clickLink(page, '资料 · 第 1 版');
  await page.locator('#passage-body mark').getByText('船已启程。', { exact: true }).waitFor();
  await clickLink(page, '查看影响');
  await choose(page, '资源类型', '讲述');
  await click(page, '筛选');
  await page.getByRole('main').getByRole('link', { name: '岸上目击', exact: true }).click();
  await heading(page, '岸上目击').waitFor();
  await goto(page, `/narratives/${narrativeId}?revision=1`, '岸上目击');
  await clickLink(page, '从此讲述建立 IF');
  await fill(page, '分支名称', '没搭上船');
  await fill(page, '分歧点', '她来迟一步。');
  await click(page, '从此讲述建立 IF');
  await heading(page, '没搭上船').waitFor();
  const branchId = idAt(page);
  await clickLink(page, '新建接续场景');
  await fill(page, '标题', '沿岸追船');
  await click(page, '新建场景');
  await heading(page, '沿岸追船').waitFor();
  const continuationId = idAt(page);
  const continuation = await invoke('narrative.save', { title: '沿岸接续讲述', sceneId: continuationId, sceneRevision: 1,
    viewpoint: { kind: 'character', characterId: character.characterId, revision: 1 }, eventOrder: [], knownEvents: [] });
  await clickLink(page, '查看 IF 接续');
  await page.getByRole('listitem').filter({ hasText: '沿岸追船' }).getByRole('link', { name: '设为接续位置' }).click();
  await fill(page, '接续笔记', '从岸上继续。');
  await click(page, '添加讲述');
  await choose(page, '讲述', '沿岸接续讲述 · 第 1 版');
  await click(page, '添加分支角色状态');
  await choose(page, '角色', '温妮莎 · 第 1 版');
  await fill(page, '此分支中的状态', '仍在岸上。');
  await click(page, '保存接续位置');
  await heading(page, '没搭上船').waitFor();
  const branch = await invoke('branch.read', { branchId });
  assert.equal(branch.checkpoint.sceneId, continuationId);
  assert.equal(branch.checkpoint.characterStates[0].state, '仍在岸上。');
  await page.reload();
  await page.getByText('从岸上继续。', { exact: true }).waitFor();
  await clickLink(page, '从此接续点准备写作');
  await fill(page, '创作要求', '接着刚才的分歧写。');
  await control(page, '内容模板').selectOption('short-story');
  await click(page, '准备写作');
  await heading(page, '沿岸接续讲述').waitFor();
  const resumed = await invoke('generations.get', { generationId: idAt(page) });
  assert.equal(resumed.composition.story.checkpoint.revision, branch.revision);
  assert.equal(resumed.composition.story.checkpoint.characterState.state, '仍在岸上。');
  await invoke('branch.save', { branchId, expectedRevision: branch.revision, sceneId: continuationId, sceneRevision: 1,
    narrative: { narrativeId: continuation.narrativeId, revision: continuation.revision },
    characterStates: [{ characterId: character.characterId, revision: 1, state: '已经追上船。' }] });
  await clickLink(page, '提示词组成');
  await fill(page, '查找消息文字', '仍在岸上');
  await click(page, '查找');
  await page.locator('#prompt-origin').getByRole('link', { name: `打开IF 分支 · 第 ${branch.revision} 版` }).click();
  await page.locator('#checkpoint-state-body mark').getByText('仍在岸上。', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('revision'), String(branch.revision));
  await goto(page, branch.href, '没搭上船');
  await page.getByRole('heading', { name: '接续位置', exact: true }).locator('..').getByRole('link', { name: '沿岸追船' }).click();
  await heading(page, '沿岸追船').waitFor();
  await clickLink(page, '查看 IF 接续');
  await clickLink(page, '查看原讲述');
  await heading(page, '岸上目击').waitFor();
  await assertFitsViewport(page);
  await screenshot(page, 'desktop', 'story-telling');
});

test('tasks: consume ordered cross-kind activity and keep pagination across reload', { timeout }, async t => {
  const { page, invoke } = await launch(t, narrow);
  const setup = await invoke('generations.prepare', { title: '任务测试', brief: '写作', templateId: 'short-story' });
  const plan = await invoke('generation.plans.create', { title: '后台方案', executor: 'openai-compatible', provider: 'fixture', model: 'fixture', parameters: {} });
  const input = { generationId: setup.generationId, planId: plan.planId };
  for (let index = 0; index < 21; index++) await invoke('generations.start', input);
  await invoke('generation.batches.create', { title: '批量任务', planId: plan.planId, generationIds: [setup.generationId] });
  const expected = await invoke('tasks.list', { limit: 20, offset: 0 });
  await goto(page, '/jobs', '任务');
  const links = page.locator('.task-row h2 a');
  await links.first().waitFor();
  assert.deepEqual(await links.evaluateAll(items => items.map(item => item.getAttribute('href'))), expected.items.map(item => item.href));
  await clickLink(page, '下一页');
  await page.waitForURL(`**/jobs?offset=${expected.nextOffset}`);
  await page.reload();
  await links.first().waitFor();
  assert.equal(await links.count(), 2);
  await links.first().click();
  await clickLink(page, '提示词组成');
  await heading(page, '提示词组成').waitFor();
  await goto(page, '/tasks', '任务');
  await links.first().waitFor();
  await assertFitsViewport(page);
  await screenshot(page, 'narrow', 'task-activity');
});

test('external research: choose a repeated passage and reopen the archive after provider shutdown', { timeout }, async t => {
  const text = '第一版时刻表。末班十点。\n第二版时刻表。末班十点。';
  const excerpt = '末班十点。';
  const upstream = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const read = url.searchParams.has('pageids');
    const pages = (read ? [Number(url.searchParams.get('pageids'))] : [77, 78]).map(pageid => ({
      pageid, title: pageid === 77 ? '渡船时刻原件' : '渡船修订说明', index: pageid, lastrevid: 902,
      canonicalurl: `https://example.test/wiki/${pageid}`, extract: read ? text : '北港航班记录',
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ query: { pages } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.listening && new Promise(resolve => upstream.close(resolve)));
  const service = await startService(t, {
    STH_RESEARCH_AKASHA_URL: '', STH_RESEARCH_MEDIAWIKI_URL: `http://127.0.0.1:${upstream.address().port}/api.php`,
    STH_RESEARCH_MEDIAWIKI_ID: 'browser-fixture', STH_RESEARCH_MEDIAWIKI_LABEL: '测试资料库',
  });
  const page = await openBrowser(t, service, narrow);
  await goto(page, '/sources', '资料');
  await clickLink(page, '外部检索');
  await fill(page, '检索词', '渡船');
  await click(page, '搜索外部资料');
  await click(page, '读取原文 · 渡船时刻原件');
  await page.locator('.passage-body').waitFor();
  const researchJob = new URL(page.url()).pathname;
  await goto(page, '/jobs', '任务');
  const researchTask = page.locator('.task-row').filter({ has: page.locator(`a[href="${researchJob}"]`) });
  await researchTask.getByText(/资料 · 已完成/).waitFor();
  await researchTask.getByRole('link').click();
  const original = page.locator('.passage-body');
  await original.waitFor();
  await original.evaluate((node, selection) => {
    const start = node.textContent.lastIndexOf(selection);
    const range = new Range();
    range.setStart(node.firstChild, start);
    range.setEnd(node.firstChild, start + selection.length);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }, excerpt);
  await click(page, '选用这段原文');
  await click(page, '归档所选原文');
  await heading(page, '渡船时刻原件').waitFor();
  const archive = page.url();
  await new Promise(resolve => upstream.close(resolve));
  await page.reload();
  assert.equal(page.url(), archive);
  await page.locator('#passage-body').getByText(excerpt, { exact: true }).waitFor();
  await page.getByText('https://example.test/wiki/77 · revision 902', { exact: true }).waitFor();
  await assertFitsViewport(page);
  await screenshot(page, 'narrow', 'external-archive');
});

test('source impact: page and filter historical version links', { timeout }, async t => {
  const { page, invoke } = await launch(t, narrow);
  const source = await invoke('source.create', { title: '来源影响', kind: 'excerpt', body: '泊船。' });
  const pin = { sourceId: source.sourceId, revision: 1, excerpt: '泊船。', range: { start: 0, end: 3 } };
  for (let index = 0; index < 21; index++) await invoke('diary.create', { title: `记录 ${index}`, body: '已泊船。', diaryDate: '2026-11-24', sourcePins: [pin] });
  await goto(page, source.href, '来源影响');
  await clickLink(page, '查看影响');
  await choose(page, '资源类型', '日记');
  await choose(page, '版本范围', '当前版本');
  await click(page, '筛选');
  await page.waitForURL(/kind=diary/);
  await clickLink(page, '下一页');
  await page.waitForURL(/offset=20/);
  await page.reload();
  await heading(page, '资料影响').waitFor();
  assert.match(page.url(), /currentOnly=1/);
  const links = page.locator('main h2 a');
  assert.equal(await links.count(), 1);
  await assertFitsViewport(page);
  await screenshot(page, 'narrow', 'source-impact');
  await links.first().click();
  await page.waitForURL(/\/diaries\/.*revision=1/);
  await page.getByText('已泊船。', { exact: true }).waitFor();
});

test('a lost write response recovers the original source through its receipt', { timeout }, async t => {
  const { page, invoke } = await launch(t, desktop);
  await goto(page, '/sources/new', '新建资料');
  let first;
  let invokes = 0;
  await page.route('**/api/web/invoke', async route => {
    const call = route.request().postDataJSON();
    if (call.operationId !== 'source.create') return route.continue();
    invokes++;
    if (first) return route.continue();
    first = call;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort();
  });
  await choose(page, '类型', '设定');
  await fill(page, '标题', '仅存一份');
  await fill(page, '正文', '原文仍在。');
  await click(page, '新建资料');
  await page.getByRole('alert').getByText(/重试同一次提交/).waitFor();
  const receipt = page.waitForRequest('**/api/web/receipt');
  await click(page, '重试同一次提交');
  assert.deepEqual((await receipt).postDataJSON(), { operationId: first.operationId, stepId: first.stepId });
  await heading(page, '仅存一份').waitFor();
  assert.equal(invokes, 1);
  assert.equal((await invoke('source.search', { query: '仅存一份' })).items.length, 1);
});
