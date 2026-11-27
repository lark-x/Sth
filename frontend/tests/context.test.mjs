import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';
import { pairPersonalClient } from '../../tests/browser/personal-api.mjs';

// Serve current source with a temporary Vite cache. This suite never builds frontend/dist.
async function fixture(t) {
  const backend = await startService(t);
  const api = await pairPersonalClient(backend);
  const cache = await mkdtemp(join(tmpdir(), 'sth-context-vite-'));
  const vite = await createServer({
    configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
    cacheDir: cache, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, proxy: { '/api': {
      target: backend, changeOrigin: true,
      configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', backend)); },
    } } },
  });
  t.after(async () => { await vite.close(); await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await vite.listen();
  return { origin: `http://127.0.0.1:${vite.httpServer.address().port}`, api };
}

const contextPath = (projectId, revision, extra = {}) => '/author-context?' + new URLSearchParams({ projectId,
  ...(revision === undefined ? {} : { revision: String(revision) }), ...extra });
const form = page => page.getByRole('form', { name: '按此版准备写作' });
const link = (page, name) => page.getByRole('link', { name, exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
function callsFrom(page) {
  const calls = [];
  page.on('request', request => { if (request.url().endsWith('/api/web/invoke')) calls.push(request.postDataJSON()); });
  return calls;
}
async function fillWriting(page, title = '北港续篇', brief = '写她在钟声响起时的选择。') {
  await page.getByLabel('稿件标题（必填）').fill(title);
  await page.getByLabel('写作要求（必填）').fill(brief);
  await page.getByLabel('内容模板（必填）').selectOption('short-story');
}
async function confirm(api, proposal) {
  return api.invoke('decision.confirm', { decisionId: proposal.decisionId, expectedRevision: proposal.revision,
    proposalRevision: proposal.revision, authorConfirmed: true, confirmedBy: '作者阿南' });
}
async function capture(page, name) {
  if (!process.env.STH_CONTEXT_ARTIFACTS) return;
  await mkdir(process.env.STH_CONTEXT_ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(process.env.STH_CONTEXT_ARTIFACTS, `${name}.png`), fullPage: true, animations: 'disabled' });
}

test('an author confirms a proposal on mobile and a fresh connection can recover the earlier context', async t => {
  const { origin } = await fixture(t);
  const proposer = await pairPersonalClient(origin);
  const { projectId } = await proposer.invoke('project.create', { title: '灯塔上的约定' });
  const proposal = await proposer.invoke('decision.propose', { projectId, title: '渡口的时间', body: '收船时钟响两次。' });
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  await page.goto(`/author-context?projectId=${projectId}`);
  const old = await page.getByRole('link', { name: '固定此版本' }).getAttribute('href');
  await page.getByLabel('作者署名').fill('阿南');
  await page.getByRole('button', { name: '确认这一版' }).click();
  await page.getByText(/阿南 · /).waitFor();
  await assertFitsViewport(page);
  const reader = await pairPersonalClient(origin);
  const latest = await reader.invoke('story.context', { projectId });
  assert.equal(latest.confirmedDecisions.items[0].decisionId, proposal.decisionId);
  assert.equal(latest.confirmedDecisions.items[0].confirmation.confirmedBy, '阿南');
  assert.equal(latest.pendingDecisions.items.length, 0);
  await page.goto(old);
  await page.getByRole('link', { name: '返回最新版' }).waitFor();
  await page.getByRole('heading', { name: proposal.title }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认这一版' }).count(), 0);
  const earlier = await reader.invoke('story.context', { projectId, contextRevision: proposal.contextRevision });
  assert.equal(earlier.pendingDecisions.items[0].revision, proposal.revision);
  assert.deepEqual(earlier.confirmedDecisions.items, []);
});

test('an explicit author action pins a mixed historical context through two rejudgments to readable prompt and source pages', { timeout: 60_000 }, async t => {
  const { origin, api } = await fixture(t);
  const { projectId } = await api.invoke('project.create', { title: '港口的决定' });
  const source = await api.invoke('source.create', { title: '港口旧公告', kind: 'excerpt', body: '钟响两次，渡船离港。' });
  const proposal = await api.invoke('decision.propose', { projectId, title: '渡船时刻', body: '确认的旧版，钟响两次离港。',
    basis: { sources: [{ sourceId: source.sourceId, revision: 1, excerpt: '钟响两次', range: { start: 0, end: 4 } }] } });
  const approved = await confirm(api, proposal);
  let pending = await api.invoke('decision.propose', { projectId, decisionId: proposal.decisionId, expectedRevision: 2,
    title: '渡船时刻', body: '未确定提案，或许响三次。' });
  const question = await api.invoke('question.save', { projectId, title: '谁在岸边', body: '身份仍待作者裁决。' });
  const revision = question.contextRevision;
  const page = await openBrowser(t, origin, { width: 1280, height: 900 });
  const calls = callsFrom(page);
  await page.goto(`/projects/${projectId}`);
  await link(page, '创作决定').click();
  await page.getByRole('region', { name: '作者已确认', exact: true }).getByText(approved.body).waitFor();
  await page.getByRole('region', { name: '待确认提案', exact: true }).getByText(pending.body).waitFor();
  await link(page, '固定此版本').click();
  await link(page, '返回最新版').waitFor();
  for (const body of ['第一次改判，响三次。', '第二次改判，响四次。']) {
    const changed = await confirm(api, pending);
    pending = await api.invoke('decision.propose', { projectId, decisionId: proposal.decisionId, expectedRevision: changed.revision,
      title: '渡船时刻', body });
  }
  await api.invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '新版公告，钟响四次。' });
  assert.equal(calls.filter(call => call.operationId === 'templates.list' || call.operationId === 'generations.prepare').length, 0);
  await link(page, '按此版准备写作').click();
  assert.equal(new URL(page.url()).searchParams.get('revision'), String(revision));
  assert.equal(new URL(page.url()).searchParams.get('prepare'), '1');
  await form(page).waitFor();
  await fillWriting(page, '钟声中的旧选择', '保持这版决定，待决身份继续留白。');
  assert.equal(calls.filter(call => call.operationId === 'generations.prepare').length, 0);
  await capture(page, 'desktop-writing-form');
  await button(page, '准备写作').click();
  await link(page, '查看提示词与出处').waitFor();
  const prepareCalls = calls.filter(call => call.operationId === 'generations.prepare');
  assert.equal(prepareCalls.length, 1);
  assert.deepEqual(prepareCalls[0].input.authorContext, { projectId, branchId: null, contextRevision: revision });
  assert.equal(prepareCalls[0].input.templateRevision, 1);
  const href = await link(page, '查看提示词与出处').getAttribute('href');
  const generationId = href.split('/')[2];
  const saved = await api.invoke('generations.get', { generationId });
  assert.equal(saved.mode, 'current-chat');
  assert.equal(saved.status, 'prepared');
  assert.equal(saved.composition.authorContext.confirmedDecisions[0].revision, 2);
  assert.equal(saved.composition.authorContext.pendingDecisions[0].revision, 3);
  assert.equal(saved.composition.authorContext.openQuestions[0].questionId, question.questionId);
  await link(page, '查看本版决定与依据').click();
  await page.getByRole('region', { name: '作者已确认', exact: true }).getByRole('button', { name: '查看依据', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '条目依据' });
  await detail.getByText(/确认提案第 1 版/).waitFor();
  const sourceHref = await detail.getByRole('link', { name: '原文 · 第 1 版' }).getAttribute('href');
  assert.equal(new URL(sourceHref, origin).searchParams.get('revision'), '1');
  await detail.getByRole('link', { name: '原文 · 第 1 版' }).click();
  await page.getByText('钟响两次，渡船离港。', { exact: true }).waitFor();
  await page.goto(href);
  await page.getByRole('heading', { name: '提示词组成', exact: true }).waitFor();
  await page.getByLabel('查找消息文字', { exact: true }).fill(approved.body);
  await button(page, '查找').click();
  await page.locator('#prompt-origin').getByText('/authorContext/confirmedDecisions/0/body', { exact: true }).waitFor();
  const text = await page.locator('.prompt-text').allTextContents();
  assert.ok(text.some(value => value.includes('unconfirmed planning material')));
  assert.ok(text.some(value => value.includes('未确定提案，或许响三次。')));
  assert.ok(!text.some(value => value.includes('第二次改判')));
  assert.equal(calls.filter(call => call.operationId === 'generations.start').length, 0);
  await assertFitsViewport(page);
});

test('an IF preparation pins its branch and pending author state without automatically starting a provider', async t => {
  const { origin, api } = await fixture(t);
  const { projectId } = await api.invoke('project.create', { title: '分支作品' });
  const main = await api.invoke('scene.create', { title: '港口主线' });
  const fork = await api.invoke('scene.branch', { sceneId: main.sceneId, revision: 1, divergence: '留在北岸。' });
  await confirm(api, await api.invoke('decision.propose', { projectId, title: '主线决定', body: 'MAINLINE_ONLY' }));
  await api.invoke('decision.propose', { projectId, branchId: fork.sceneId, title: 'IF 提案', body: '仍待确认的分支方案。' });
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  const calls = callsFrom(page);
  await page.goto(contextPath(projectId, undefined, { branchId: fork.sceneId }));
  await link(page, '按此版准备写作').click();
  await fillWriting(page);
  await button(page, '准备写作').click();
  const href = await link(page, '查看提示词与出处').getAttribute('href');
  const record = await api.invoke('generations.get', { generationId: href.split('/')[2] });
  assert.deepEqual(record.composition.authorContext.branchId, fork.sceneId);
  assert.equal(record.composition.authorContext.pendingDecisions.length, 1);
  assert.deepEqual(record.composition.authorContext.confirmedDecisions, []);
  assert.ok(!JSON.stringify(record).includes('MAINLINE_ONLY'));
  assert.equal(calls.filter(call => call.operationId === 'generations.start').length, 0);
  await capture(page, 'phone-prepared');
  await assertFitsViewport(page);
});

test('a lost successful response survives reload and an explicit receipt retry recovers the same prepared draft', async t => {
  const { origin, api } = await fixture(t);
  const { projectId } = await api.invoke('project.create', { title: '重试作品' });
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  const calls = callsFrom(page);
  let original;
  await page.route('**/api/web/invoke', async route => {
    if (route.request().postDataJSON().operationId !== 'generations.prepare') return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    original = (await response.json()).result;
    await route.abort('failed');
  });
  await page.goto(contextPath(projectId));
  await link(page, '按此版准备写作').click();
  await fillWriting(page, '结果待确认的稿件', '请保留本次要求。');
  await button(page, '准备写作').evaluate(element => { element.click(); element.click(); });
  await page.getByRole('alert').getByText(/准备结果尚未确认/).waitFor();
  assert.equal(calls.filter(call => call.operationId === 'generations.prepare').length, 1);
  assert.equal(await page.getByLabel('稿件标题（必填）').isDisabled(), true);
  await page.reload();
  await button(page, '重试本次准备').waitFor();
  assert.equal(await page.getByLabel('稿件标题（必填）').inputValue(), '结果待确认的稿件');
  assert.equal(await page.getByLabel('写作要求（必填）').inputValue(), '请保留本次要求。');
  const receiptRequest = page.waitForRequest('**/api/web/receipt');
  await button(page, '重试本次准备').click();
  assert.equal((await receiptRequest).postDataJSON().stepId, calls.find(call => call.operationId === 'generations.prepare').stepId);
  assert.equal(await link(page, '查看提示词与出处').getAttribute('href'), `/generations/${original.generationId}/prompt`);
  assert.equal(calls.filter(call => call.operationId === 'generations.prepare').length, 1);
  assert.equal((await api.invoke('generations.list', { projectId })).items.length, 1);
  await page.reload();
  await link(page, '查看提示词与出处').waitFor();
  assert.equal(await button(page, '准备写作').count(), 0);
  assert.equal((await api.invoke('generations.list', { projectId })).items.length, 1);
});

test('an uncertain failure before commit retries the identical input and a definitive failure permits a corrected new step', async t => {
  const { origin, api } = await fixture(t);
  const { projectId } = await api.invoke('project.create', { title: '失败恢复作品' });
  const page = await openBrowser(t, origin, { width: 320, height: 800 });
  const calls = callsFrom(page);
  let responseStatus = 500;
  await page.route('**/api/web/invoke', async route => {
    if (route.request().postDataJSON().operationId !== 'generations.prepare' || !responseStatus) return route.continue();
    const status = responseStatus;
    responseStatus = 0;
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code: status === 500 ? 'temporary_failure' : 'generation_author_context_too_large' }) });
  });
  await page.goto(contextPath(projectId, 0, { prepare: '1' }));
  await fillWriting(page);
  await button(page, '准备写作').click();
  await button(page, '重试本次准备').waitFor();
  await button(page, '重试本次准备').click();
  await link(page, '查看提示词与出处').waitFor();
  const same = calls.filter(call => call.operationId === 'generations.prepare');
  assert.equal(same.length, 2);
  assert.deepEqual(same[0], same[1]);
  await button(page, '再准备一份').click();
  responseStatus = 400;
  await button(page, '准备写作').click();
  await page.getByRole('alert').getByText(/超过组稿容量/).waitFor();
  assert.equal(await page.getByLabel('稿件标题（必填）').isEnabled(), true);
  await page.getByLabel('稿件标题（必填）').fill('修正后的要求');
  await assertFitsViewport(page);
  await capture(page, 'compact-preparation-error');
  await button(page, '准备写作').click();
  await link(page, '查看提示词与出处').waitFor();
  const changed = calls.filter(call => call.operationId === 'generations.prepare');
  assert.equal(changed.length, 4);
  assert.notEqual(changed[2].stepId, changed[3].stepId);
  assert.equal(changed[3].input.title, '修正后的要求');
  assert.equal((await api.invoke('generations.list', { projectId })).items.length, 2);
});

test('template errors, empty state, pagination and exact selected revision retain the author form', { timeout: 60_000 }, async t => {
  const { origin, api } = await fixture(t);
  const { projectId } = await api.invoke('project.create', { title: '模板作品' });
  for (let index = 0; index < 54; index++) await api.invoke('templates.create', { title: `自定义模板 ${index}`, kind: 'custom',
    fields: [{ key: 'body', label: '正文', type: 'text' }] });
  const page = await openBrowser(t, origin, { width: 320, height: 800 });
  let state = 'failure';
  await page.route('**/api/web/invoke', route => {
    if (route.request().postDataJSON().operationId !== 'templates.list' || state === 'normal') return route.continue();
    return route.fulfill({ status: state === 'failure' ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(state === 'failure' ? { code: 'temporary_failure' } : { result: { items: [] } }) });
  });
  await page.goto(contextPath(projectId, 0, { prepare: '1' }));
  await page.getByLabel('稿件标题（必填）').fill('保持输入的标题');
  await page.getByLabel('写作要求（必填）').fill('保持输入的要求。');
  await page.getByText(/模板读取失败/).waitFor();
  state = 'empty';
  await button(page, '重新读取模板').click();
  await page.getByText(/暂无可用模板/).waitFor();
  assert.equal(await button(page, '准备写作').isDisabled(), true);
  state = 'normal';
  await button(page, '重新读取模板').click();
  await button(page, '读取更多模板').waitFor();
  const second = await api.invoke('templates.list', { limit: 50, offset: 50 });
  const target = second.items.find(item => !['diary', 'short-story', 'screenplay', 'shot-list'].includes(item.templateId));
  assert.ok(target);
  await button(page, '读取更多模板').click();
  await page.getByLabel('内容模板（必填）').selectOption(target.templateId);
  const definition = await api.invoke('templates.get', { templateId: target.templateId });
  await api.invoke('templates.update', { templateId: target.templateId, expectedRevision: target.revision,
    title: definition.title, kind: definition.kind, fields: [{ key: 'changed', label: '后来新增字段', type: 'text' }] });
  assert.equal(await page.getByLabel('稿件标题（必填）').inputValue(), '保持输入的标题');
  await button(page, '准备写作').click();
  const href = await link(page, '查看提示词与出处').getAttribute('href');
  const saved = await api.invoke('generations.get', { generationId: href.split('/')[2] });
  assert.equal(saved.composition.template.revision, target.revision);
  assert.equal(saved.composition.template.fields[0].key, 'body');
  await assertFitsViewport(page);
});

test('empty and whitespace author input stays local, and a draft cannot leak into another work or fixed context version', async t => {
  const { origin, api } = await fixture(t);
  const { projectId } = await api.invoke('project.create', { title: '表单作品' });
  const other = await api.invoke('project.create', { title: '其它作品' });
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  const calls = callsFrom(page);
  await page.goto(contextPath(projectId, 0, { prepare: '1' }));
  await page.getByLabel('内容模板（必填）').selectOption('short-story');
  await button(page, '准备写作').click();
  assert.equal(calls.filter(call => call.operationId === 'generations.prepare').length, 0);
  await page.getByLabel('稿件标题（必填）').fill('   ');
  await page.getByLabel('写作要求（必填）').fill('   ');
  await button(page, '准备写作').click();
  await page.getByText('请填写稿件标题。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('稿件标题（必填）').getAttribute('aria-invalid'), 'true');
  await page.getByLabel('稿件标题（必填）').fill('留在本作品的输入');
  await button(page, '准备写作').click();
  await page.getByText('请填写写作要求。', { exact: true }).waitFor();
  assert.equal(calls.filter(call => call.operationId === 'generations.prepare').length, 0);
  await page.getByLabel('写作要求（必填）').fill('留在本版本的要求');
  await page.reload();
  assert.equal(await page.getByLabel('稿件标题（必填）').inputValue(), '留在本作品的输入');
  await api.invoke('question.save', { projectId, title: '新问题', body: '另一个上下文版本。' });
  await page.goto(contextPath(projectId, 1, { prepare: '1' }));
  assert.equal(await page.getByLabel('稿件标题（必填）').inputValue(), '');
  await page.goto(contextPath(other.projectId, 0, { prepare: '1' }));
  assert.equal(await page.getByLabel('写作要求（必填）').inputValue(), '');
  await page.getByLabel('内容模板（必填）').selectOption('short-story');
});

test('a pinned character telling and historical checkpoint retain the backend secrecy policy in the prepared prompt', async t => {
  const { origin, api } = await fixture(t);
  const { projectId } = await api.invoke('project.create', { title: '受限视角作品' });
  const scene = await api.invoke('scene.create', { title: '渡口' });
  const fork = await api.invoke('scene.branch', { sceneId: scene.sceneId, revision: 1, divergence: 'SECRET_DIVERGENCE' });
  const character = await api.invoke('character.create', { name: '林', persona: 'SECRET_PERSONA' });
  const other = await api.invoke('character.create', { name: '另一人' });
  const narrative = await api.invoke('narrative.save', { sceneId: fork.sceneId, sceneRevision: 1, title: '林的讲法',
    viewpoint: { kind: 'character', characterId: character.characterId, revision: 1 }, eventOrder: [], knownEvents: [] });
  const continuation = { branchId: fork.sceneId, sceneId: fork.sceneId, sceneRevision: 1,
    narrative: { narrativeId: narrative.narrativeId, revision: narrative.revision } };
  const checkpoint = await api.invoke('branch.save', { ...continuation, expectedRevision: 1, note: 'SECRET_CHECKPOINT_NOTE',
    characterStates: [{ characterId: character.characterId, revision: 1, state: '她拿着旧船票。' },
      { characterId: other.characterId, revision: 1, state: 'SECRET_OTHER_CHARACTER' }] });
  const confirmed = await confirm(api, await api.invoke('decision.propose', { projectId, branchId: fork.sceneId,
    title: 'SECRET_CONFIRMED_TITLE', body: 'SECRET_CONFIRMED_BODY' }));
  const pending = await api.invoke('decision.propose', { projectId, branchId: fork.sceneId,
    title: 'SECRET_PENDING_TITLE', body: 'SECRET_PENDING_BODY' });
  const path = contextPath(projectId, pending.contextRevision, { branchId: fork.sceneId, narrativeId: narrative.narrativeId,
    narrativeRevision: String(narrative.revision), checkpointRevision: String(checkpoint.revision) });
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  const calls = callsFrom(page);
  await page.goto(path);
  await link(page, '按此版准备写作').click();
  await fillWriting(page);
  await api.invoke('branch.save', { ...continuation, expectedRevision: checkpoint.revision, characterStates: [
    { characterId: character.characterId, revision: 1, state: '后来的不同状态。' }] });
  await button(page, '准备写作').click();
  const href = await link(page, '查看提示词与出处').getAttribute('href');
  const generation = await api.invoke('generations.get', { generationId: href.split('/')[2] });
  const input = calls.find(call => call.operationId === 'generations.prepare').input;
  assert.deepEqual(input.story, { narrativeId: narrative.narrativeId, revision: 1, branchId: fork.sceneId, checkpointRevision: checkpoint.revision });
  assert.equal(generation.composition.authorContext.policy, 'withheld-for-character-viewpoint');
  assert.deepEqual(generation.composition.authorContext.confirmedDecisions, []);
  assert.deepEqual(generation.composition.authorContext.pendingDecisions, []);
  assert.equal(generation.composition.story.checkpoint.characterState.state, '她拿着旧船票。');
  const trace = await api.invoke('generations.prompt', { generationId: generation.generationId });
  assert.doesNotMatch(JSON.stringify([generation, trace]), /SECRET_|后来的不同状态/);
  assert.ok(!JSON.stringify(trace).includes(confirmed.decisionId));
  assert.ok(!JSON.stringify(trace).includes(pending.decisionId));
  await link(page, '查看提示词与出处').click();
  await page.getByRole('heading', { name: '提示词组成', exact: true }).waitFor();
  const text = (await page.locator('.prompt-text').allTextContents()).join('\n');
  assert.match(text, /withheld for this character viewpoint/);
  assert.match(text, /她拿着旧船票/);
  assert.doesNotMatch(text, /SECRET_|后来的不同状态/);
  assert.equal(calls.filter(call => call.operationId === 'generations.start').length, 0);
  await page.goto(contextPath(projectId, pending.contextRevision, { branchId: fork.sceneId, prepare: '1', narrativeId: narrative.narrativeId }));
  await page.getByRole('alert').getByText(/讲法版本链接不完整/).waitFor();
  assert.equal(await form(page).count(), 0);
});

test('historical answer buttons read the exact confirmation and an older basis response cannot replace the latest selection', async t => {
  const { origin, api } = await fixture(t);
  const { projectId } = await api.invoke('project.create', { title: '历史依据作品' });
  const approved = await confirm(api, await api.invoke('decision.propose', { projectId, title: '旧判', body: '原先确认留在北岸。' }));
  const question = await api.invoke('question.save', { projectId, title: '去向问题', body: '需要选择目的地。' });
  const resolved = await api.invoke('question.resolve', { questionId: question.questionId, expectedRevision: 1,
    decision: { decisionId: approved.decisionId, revision: approved.revision } });
  await confirm(api, await api.invoke('decision.propose', { projectId, decisionId: approved.decisionId, expectedRevision: 2,
    title: '新判', body: '后来改判登船。' }));
  const page = await openBrowser(t, origin, { width: 390, height: 844 });
  const reads = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  await page.route('**/api/web/invoke', async route => {
    const call = route.request().postDataJSON();
    if (call.operationId === 'decision.read') {
      reads.push(call.input);
      const response = await route.fetch();
      signalStarted();
      await held;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.goto(contextPath(projectId, resolved.contextRevision));
  const section = page.getByRole('region', { name: '已结案问题', exact: true });
  await section.getByRole('button', { name: '当时确认的决定' }).click();
  await started;
  await section.getByRole('button', { name: '查看问题依据' }).click();
  const detail = page.getByRole('complementary', { name: '条目依据' });
  await detail.getByRole('heading', { name: '去向问题 · 第 2 版' }).waitFor();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  assert.deepEqual(reads, [{ decisionId: approved.decisionId, revision: 2 }]);
  assert.equal(await detail.getByRole('heading').innerText(), '去向问题 · 第 2 版');
  await section.getByRole('button', { name: '当时确认的决定' }).click();
  await detail.getByRole('heading', { name: '旧判 · 第 2 版' }).waitFor();
  assert.equal(await detail.getByText(approved.body, { exact: true }).count(), 1);
  assert.equal(await detail.getByText('后来改判登船。', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '条目依据');
});
