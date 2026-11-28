import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { assertFitsViewport, openBrowser, startService } from '../../tests/browser/harness.mjs';

const root = resolve(import.meta.dirname, '../..');
const artifacts = join(root, 'frontend/.artifacts/evidence-ai');
const button = (page, name) => page.getByRole('button', { name, exact: true });
const panel = page => page.getByRole('complementary', { name: '本次依据', exact: true })
  .or(page.getByRole('dialog', { name: '本次依据', exact: true }));
const responsivePanel = (page, width) => page.getByRole(width < 640 ? 'dialog' : 'complementary', { name: '本次依据', exact: true });
const emptyDraft = '这版稿件还没有已确认的来源记录';
const hrefWithReturn = (path, returnTo) => `${path}&${new URLSearchParams({ returnTo })}`;

async function fixture(t) {
  const backend = await startService(t);
  const cacheDir = await mkdtemp(join(tmpdir(), 'sth-evidence-vite-'));
  const entry = '/@evidence-fixture.ts';
  const vite = await createServer({
    configFile: false, root, cacheDir, publicDir: false, logLevel: 'error',
    plugins: [vue(), {
      name: 'isolated-evidence-component',
      resolveId(id) { if (id === entry) return `\0${entry}`; },
      load(id) {
        if (id !== `\0${entry}`) return;
        return `import {createApp,h,shallowRef} from 'vue';
          import ManuscriptEvidence from '/frontend/writing/ManuscriptEvidence.vue';
          import {invoke,operation} from '/frontend/api.ts';
          const params=new URLSearchParams(location.search);
          const scene=shallowRef(),draft=shallowRef();
          window.switchEvidence=(nextScene,nextDraft)=>{scene.value=nextScene;draft.value=nextDraft};
          const initialDraft=params.get('draftId')?await invoke(operation('draft.read',{draftId:params.get('draftId'),...(params.has('draftRevision')?{revision:Number(params.get('draftRevision'))}:{})})):undefined;
          scene.value=await invoke(operation('scene.read',{sceneId:params.get('sceneId'),revision:initialDraft?.sceneRevision??Number(params.get('revision')??1)}));
          draft.value=initialDraft;
          createApp({setup(){return()=>h('main',{style:'max-width:48rem;margin:auto;padding:1rem;min-width:0'},[
            h('nav',{class:'fixture-toolbar',style:'position:sticky;top:0;z-index:3;background:white'},[
              h('button',{'aria-label':'工具栏依据',onClick:event=>event.currentTarget.dispatchEvent(new CustomEvent('sth:open-evidence',{bubbles:true}))},'工具栏依据')
            ]),
            h('h1',scene.value.title),h('label',{for:'manuscript-editor'},'稿件正文'),
            h('textarea',{id:'manuscript-editor',value:draft.value?.body??'新稿临时正文',style:'display:block;box-sizing:border-box;width:100%;height:9rem;font:inherit'}),
            h('div',{id:'passage-body',tabindex:-1,style:'white-space:pre-wrap;margin-block:1rem;line-height:1.8'},draft.value?.body??'新稿临时正文'),
            h(ManuscriptEvidence,{scene:scene.value,draft:draft.value})
          ])}}).mount('#app');`;
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith('/evidence-fixture')) return next();
          const html = await server.transformIndexHtml(request.url,
            `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本次依据验收</title><style>:root{font-family:system-ui;--sheet:#fff;--ink:#23332c;--muted:#56665b;--line:#d7dfd6;--line-strong:#87968c;--danger:#8c362c;--accent:#285a46}body{margin:0;color:var(--ink)}button,input,select,textarea{font:inherit}button{max-width:100%;white-space:normal}a{color:var(--accent)}*{box-sizing:border-box}</style></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`);
          response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, proxy: { '/api': {
      target: backend, changeOrigin: true,
      configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', backend)); },
    } } },
  });
  t.after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  async function invoke(operationId, input) {
    const response = await fetch(`${backend}/api/web/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, input, stepId: `evidence:${randomUUID()}` }) });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data)); return data.result;
  }
  const source = await invoke('source.create', { title: '渡口旧公告', kind: 'excerpt', body: '旧公告。钟响两次，渡船离港。\n<script>原文保持可读</script>' });
  const character = await invoke('character.create', { name: '守灯人', persona: '每次钟响都会抬头。' });
  const scene = await invoke('scene.create', { title: '暮色中的渡口', characters: [{ characterId: character.characterId, revision: 1 }],
    sources: [{ sourceId: source.sourceId, revision: 1, excerpt: '钟响两次，渡船离港。', range: { start: 4, end: 14 } }] });
  const draft = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '等待的初稿', body: '灯亮了。\n他仍在等船。' });
  const target = { sceneId: scene.sceneId, sceneRevision: 1 };
  const prepare = (extra = {}) => invoke('generations.prepare', { title: '渡口写作记录', brief: '描写他没有离开的原因。', templateId: 'short-story', manuscript: target, ...extra });
  const path = (withDraft = true) => `/evidence-fixture?sceneId=${scene.sceneId}${withDraft ? `&draftId=${draft.draftId}` : ''}`;
  return { origin, invoke, source, character, scene, draft, target, prepare, path };
}
async function open(t, fx, withDraft = true, viewport = { width: 1280, height: 900 }) {
  const page = await openBrowser(t, fx.origin, viewport);
  await page.goto(fx.path(withDraft));
  await button(page, '本次依据').waitFor();
  return page;
}
async function capture(page, name) {
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true, animations: 'disabled' });
}

test('ordinary drafts have an honest empty state and scene links never become generated evidence', async t => {
  const fx = await fixture(t);
  await fx.prepare({ references: [{ kind: 'draft', id: fx.draft.draftId, revision: 1 }] });
  const page = await open(t, fx);
  const calls = [];
  page.on('request', request => { if (request.url().endsWith('/api/web/invoke')) calls.push(request.postDataJSON()); });
  assert.equal(await panel(page).count(), 0);
  const entry = button(page, '本次依据');
  assert.deepEqual(await entry.evaluate(node => ({
    height: node.getBoundingClientRect().height >= 44,
    border: getComputedStyle(node).borderTopWidth,
    background: getComputedStyle(node).backgroundColor,
    iconHidden: node.querySelector('svg')?.getAttribute('aria-hidden'),
  })), { height: true, border: '0px', background: 'rgba(0, 0, 0, 0)', iconHidden: 'true' });
  await capture(page, 'quiet-trigger-desktop');
  await button(page, '本次依据').click();
  await panel(page).getByRole('heading', { name: '本次依据', exact: true }).waitFor();
  await panel(page).getByText(`${fx.draft.title} · 修订 1`, { exact: true }).waitFor();
  await panel(page).getByText(emptyDraft, { exact: true }).waitFor();
  assert.equal(await panel(page).locator('.evidence-empty').innerText(), `${emptyDraft}。场景可用资料不会自动成为本版依据。`);
  assert.equal(await panel(page).getByRole('region', { name: '组稿固定输入' }).count(), 0);
  assert.equal(await panel(page).getByLabel('组稿编号').isVisible(), false);
  assert.equal(await panel(page).getByText('钟响两次，渡船离港。', { exact: true }).isVisible(), false);
  await panel(page).getByRole('heading', { name: '准备下一稿', exact: true }).waitFor();
  await panel(page).getByText(`准备下一稿会建立新的写作上下文，不会改变正在阅读的《${fx.draft.title}》第 1 版依据。`, { exact: true }).waitFor();
  await capture(page, 'evidence-empty-draft-desktop');
  await panel(page).getByText('查看场景资料', { exact: true }).click();
  await panel(page).getByText('钟响两次，渡船离港。', { exact: true }).waitFor();
  await panel(page).getByText('每次钟响都会抬头。', { exact: true }).waitFor();
  assert.equal(await panel(page).getByRole('heading', { name: '场景可用资料', exact: true }).count(), 1);
  assert.equal(await panel(page).getByRole('region', { name: '组稿固定输入' }).count(), 0,
    'scene facts remain available without being presented as this draft evidence');
  await capture(page, 'evidence-scene-available-desktop');
  assert.equal(await panel(page).getByRole('link', { name: '场景引用原文 1 · 第 1 版', exact: true }).getAttribute('href'),
    hrefWithReturn(`/sources/${fx.source.sourceId}?revision=1&start=4&end=14`, fx.path()));
  assert.equal(await panel(page).getByRole('link', { name: '守灯人 · 第 1 版', exact: true }).getAttribute('href'),
    hrefWithReturn(`/characters/${fx.character.characterId}?revision=1`, fx.path()));
  assert.equal(calls.filter(call => call.operationId === 'generations.prepare').length, 0);
  assert.equal(calls.filter(call => call.operationId === 'generations.get').length, 0);
  await assertFitsViewport(page);
  await capture(page, 'ordinary-draft-desktop');
});

test('failed evidence reads stay unknown and panel descriptions reference rendered nodes', async t => {
  const fx = await fixture(t);
  const page = await open(t, fx);
  await page.route('**/api/web/invoke', async route => {
    if (route.request().postDataJSON().operationId !== 'generations.evidence.list') return route.continue();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary failure' }) });
  });
  await button(page, '本次依据').click();
  const evidencePanel = panel(page);
  const describedByTargets = () => evidencePanel.evaluate(node => (node.getAttribute('aria-describedby') ?? '')
    .split(/\s+/u).filter(Boolean).map(id => ({ id, exists: Boolean(document.getElementById(id)) })));
  await evidencePanel.getByRole('alert').getByText(/本次依据读取失败/).waitFor();
  assert.equal(await evidencePanel.getByText(/这版没有已确认依据/).count(), 0);
  assert.deepEqual(await describedByTargets(), [{ id: await evidencePanel.locator('.evidence-identity-line').getAttribute('id'), exists: true }]);

  await page.unrouteAll();
  await evidencePanel.getByRole('alert').getByRole('button', { name: '重新读取本次依据' }).click();
  await evidencePanel.locator('.evidence-empty').waitFor();
  const targetsAfterRetry = await describedByTargets();
  assert.equal(targetsAfterRetry.length, 2);
  assert.ok(targetsAfterRetry.every(target => target.exists));
  const emptyId = await evidencePanel.locator('.evidence-empty').getAttribute('id');
  assert.ok(targetsAfterRetry.some(target => target.id === emptyId));
  assert.equal(await evidencePanel.locator('.evidence-status').count(), 0, 'empty guidance is shown only once');
});

test('confirmed association shows pinned originals, characters and author decisions after later edits', async t => {
  const fx = await fixture(t);
  const project = await fx.invoke('project.create', { title: '钟声作品' });
  const proposed = await fx.invoke('decision.propose', { projectId: project.projectId, title: '离港时间', body: '钟响两次离港。' });
  const decision = await fx.invoke('decision.confirm', { decisionId: proposed.decisionId, expectedRevision: 1, proposalRevision: 1,
    authorConfirmed: true, confirmedBy: '作者' });
  const record = await fx.prepare({ authorContext: { projectId: project.projectId, branchId: null, contextRevision: decision.contextRevision }, references: [
    { kind: 'source', id: fx.source.sourceId, revision: 1 }, { kind: 'character', id: fx.character.characterId, revision: 1 },
  ] });
  await fx.invoke('generations.save', { generationId: record.generationId, output: { opening: '灯亮了。', development: '他等船。', ending: '钟响了。' } });
  await fx.invoke('generations.evidence.attach', { generationId: record.generationId, draftId: fx.draft.draftId, draftRevision: 1,
    authorConfirmed: true, passages: [{ start: 0, end: 4, referenceIndex: 0 }] });
  await fx.invoke('source.revise', { sourceId: fx.source.sourceId, expectedRevision: 1, body: '新公告，响四次。' });
  await fx.invoke('character.revise', { characterId: fx.character.characterId, expectedRevision: 1, persona: '已离开渡口。' });
  const page = await open(t, fx, true, { width: 390, height: 844 });
  await capture(page, 'quiet-trigger-phone');
  await button(page, '本次依据').click();
  const fixed = panel(page).getByRole('region', { name: '组稿固定输入' });
  await fixed.getByText(fx.source.body, { exact: true }).waitFor();
  await fixed.getByText('每次钟响都会抬头。', { exact: true }).waitFor();
  await fixed.getByText('钟响两次离港。', { exact: true }).waitFor();
  assert.equal(await fixed.getByText('新公告，响四次。', { exact: true }).count(), 0);
  assert.equal(await fixed.locator('script').count(), 0);
  assert.equal(await fixed.getByRole('link', { name: '渡口旧公告 · 第 1 版', exact: true }).getAttribute('href'),
    hrefWithReturn(`/sources/${fx.source.sourceId}?revision=1`, fx.path()));
  assert.equal(await fixed.getByRole('link', { name: '守灯人 · 第 1 版', exact: true }).getAttribute('href'),
    hrefWithReturn(`/characters/${fx.character.characterId}?revision=1`, fx.path()));
  await panel(page).getByText('作者已确认关联到这版稿件。', { exact: true }).waitFor();
  assert.equal(await panel(page).getByRole('heading', { name: '准备下一稿', exact: true }).count(), 1);
  assert.equal(await panel(page).getByText(`准备下一稿会建立新的写作上下文，不会改变正在阅读的《${fx.draft.title}》第 1 版依据。`, { exact: true }).count(), 1);
  assert.match(await panel(page).getByRole('link', { name: '定位稿件片段 1 · 依据 1' }).getAttribute('href'), /revision=1&start=0&end=4$/);
  assert.equal(await fixed.getByRole('link', { name: '完整提示词与出处' }).count(), 0);
  await capture(page, 'evidence-confirmed-phone');
  await fixed.getByText('查看来源记录', { exact: true }).click();
  assert.match(await fixed.getByRole('link', { name: '完整提示词与出处' }).getAttribute('href'), /\/generations\/.+\/prompt$/);
  await fixed.getByText('查看来源记录', { exact: true }).click();
  await assertFitsViewport(page);
  await capture(page, 'pinned-inputs-phone');
  await page.setViewportSize({ width: 320, height: 800 });
  await assertFitsViewport(page);
  await capture(page, 'pinned-inputs-compact');
});

test('closing restores editor focus, selection and native manuscript text selection', async t => {
  const fx = await fixture(t);
  const page = await open(t, fx, true, { width: 390, height: 844 });
  await page.getByLabel('稿件正文').focus();
  await page.getByLabel('稿件正文').evaluate(node => node.setSelectionRange(2, 7, 'backward'));
  await button(page, '本次依据').click();
  await panel(page).waitFor();
  await panel(page).press('Escape');
  assert.deepEqual(await page.getByLabel('稿件正文').evaluate(node => ({ focused: document.activeElement === node,
    start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection })),
  { focused: true, start: 2, end: 7, direction: 'backward' });
  await page.locator('#passage-body').evaluate(node => {
    node.focus(); const range = document.createRange(); range.setStart(node.firstChild, 1); range.setEnd(node.firstChild, 4);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await button(page, '本次依据').click();
  await button(page, '关闭依据').click();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), fx.draft.body.slice(1, 4));
  assert.equal(await page.locator('#passage-body').evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Tab');
  assert.equal(await button(page, '本次依据').evaluate(node => document.activeElement === node), true);
  assert.equal(await button(page, '本次依据').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
  await button(page, '本次依据').press('Enter');
  assert.equal(await page.locator('.evidence-trigger').getAttribute('aria-expanded'), 'true');
  await panel(page).press('Escape');
  assert.equal(await button(page, '本次依据').getAttribute('aria-expanded'), 'false');
});

test('new writing can add, remove, recover and persist this generation references without editing the scene', async t => {
  const fx = await fixture(t);
  const page = await open(t, fx, false, { width: 320, height: 800 });
  await button(page, '本次依据').click();
  await panel(page).getByText('当前显示场景准备记录，尚未关联到具体稿件。', { exact: true }).waitFor();
  assert.equal(await panel(page).getByText('此场景版本还没有保存的组稿。', { exact: true }).count(), 1);
  await capture(page, 'evidence-scene-no-record');
  await button(page, '准备新稿').click();
  await page.getByLabel('稿件标题（必填）').waitFor();
  await capture(page, 'evidence-prepare-next-compact');
  await page.getByLabel('稿件标题（必填）').fill('钟声后的一幕');
  await page.getByLabel('写作要求（必填）').fill('只使用本次选定的资料。');
  await page.getByLabel('内容模板（必填）').selectOption('short-story');
  await page.getByText('从场景关联中选择', { exact: true }).click();
  await button(page, '加入场景依据 1').click();
  await button(page, '加入场景依据 2').click();
  await button(page, '移除第 2 项依据').click();
  await button(page, '加入场景依据 2').click();
  await button(page, '移除第 1 项依据').click();
  await assertFitsViewport(page);
  await capture(page, 'prepare-compact');
  await page.reload();
  await button(page, '本次依据').click();
  await button(page, '准备新稿').click();
  assert.equal(await page.getByLabel('稿件标题（必填）').inputValue(), '钟声后的一幕');
  assert.equal(await page.locator('.evidence-picker ol li').count(), 1);
  await button(page, '准备写作').click();
  await page.getByRole('link', { name: '查看提示词与出处', exact: true }).waitFor();
  const prompt = await page.getByRole('link', { name: '查看提示词与出处', exact: true }).getAttribute('href');
  const saved = await fx.invoke('generations.get', { generationId: prompt.split('/')[2] });
  assert.deepEqual(saved.composition.references.map(item => [item.kind, item.id, item.revision]), [['character', fx.character.characterId, 1]]);
  const current = await fx.invoke('scene.read', { sceneId: fx.scene.sceneId });
  assert.deepEqual(current.sources, fx.scene.sources);
  assert.deepEqual(current.characters, fx.scene.characters);
  const listed = await fx.invoke('generations.evidence.list', fx.target);
  assert.equal(listed.items[0].generation.generationId, saved.generationId);
  await capture(page, 'prepared-compact');
});

test('reference catalog can select exact historical versions and lost preparation responses recover one generation', async t => {
  const fx = await fixture(t);
  const page = await open(t, fx, false);
  await button(page, '本次依据').click();
  await button(page, '准备新稿').click();
  await button(page, '添加本次依据').click();
  await page.getByLabel('选择资料', { exact: true }).selectOption(fx.source.sourceId);
  await page.getByLabel('引用原句（可选，留空引用全文）').fill('钟响两次，渡船离港。');
  await page.getByText('指定原文位置', { exact: true }).click();
  await page.getByLabel('原文起点', { exact: true }).fill('4');
  await page.getByLabel('原文终点', { exact: true }).fill('14');
  await button(page, '加入本次依据').click();
  await page.getByLabel('稿件标题（必填）').fill('固定原文');
  await page.getByLabel('写作要求（必填）').fill('钟响。');
  await page.getByLabel('内容模板（必填）').selectOption('short-story');
  let committed;
  await page.route('**/api/web/invoke', async route => {
    const request = route.request().postDataJSON();
    if (request.operationId !== 'generations.prepare' || committed) return route.continue();
    const response = await route.fetch(); committed = (await response.json()).result;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'lost-response' }) });
  });
  await button(page, '准备写作').click();
  await page.getByRole('alert').filter({ hasText: '准备结果尚未确认' }).waitFor();
  assert.ok(committed?.generationId);
  await page.reload();
  await button(page, '本次依据').click();
  await button(page, '准备新稿').click();
  await button(page, '重试本次准备').click();
  await page.getByRole('link', { name: '查看提示词与出处', exact: true }).waitFor();
  const listed = await fx.invoke('generations.evidence.list', fx.target);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].generation.generationId, committed.generationId);
  assert.deepEqual(committed.composition.references[0].range, { start: 4, end: 14 });
});

test('an author can inspect an existing completed generation and explicitly associate the exact draft', async t => {
  const fx = await fixture(t);
  const record = await fx.prepare({ references: [{ kind: 'source', id: fx.source.sourceId, revision: 1 }] });
  await fx.invoke('generations.save', { generationId: record.generationId, output: { opening: '灯亮了。', development: '等船。', ending: '离开。' } });
  const page = await open(t, fx);
  await button(page, '本次依据').click();
  await panel(page).getByText(emptyDraft, { exact: true }).waitFor();
  await page.getByText('关联已有记录', { exact: true }).click();
  await page.getByLabel('组稿编号', { exact: true }).fill(record.generationId);
  await button(page, '读取待核对组稿').click();
  await page.getByRole('heading', { name: '待核对的组稿', exact: true }).waitFor();
  await page.getByLabel('我确认这版稿件使用了这次组稿').check();
  await button(page, '确认关联此版本').click();
  await panel(page).getByText(`${fx.draft.title} · 修订 1`, { exact: true }).waitFor();
  await panel(page).getByText('查看来源记录', { exact: true }).click();
  await panel(page).locator('.evidence-content').getByText(/作者已确认关联/).waitFor();
  await panel(page).locator('.evidence-status').getByText('作者已确认关联到这版稿件。', { exact: true }).waitFor();
  assert.equal((await fx.invoke('generations.evidence.list', { ...fx.target, draftId: fx.draft.draftId, draftRevision: 1 })).items[0].generation.generationId, record.generationId);
});

test('prop changes cancel an older snapshot and isolate ordinary drafts and scope errors', async t => {
  const fx = await fixture(t);
  const record = await fx.prepare();
  const other = await fx.invoke('scene.create', { title: '另一本场景' });
  const page = await open(t, fx, false);
  let release;
  const delayed = new Promise(done => { release = done; });
  let received;
  const reading = new Promise(done => { received = done; });
  await page.route('**/api/web/invoke', async route => {
    const request = route.request().postDataJSON();
    if (request.operationId !== 'generations.get' || request.input.generationId !== record.generationId) return route.continue();
    const response = await route.fetch(); received(); await delayed;
    await route.fulfill({ response }).catch(() => {});
  });
  await button(page, '本次依据').click();
  await reading;
  await page.evaluate(scene => window.switchEvidence(scene), other);
  await panel(page).getByText('此场景版本还没有保存的组稿。', { exact: true }).waitFor();
  release();
  assert.equal(await panel(page).getByText(record.title, { exact: true }).count(), 0);
  await page.evaluate(({ scene, draft }) => window.switchEvidence(scene, draft), { scene: other, draft: fx.draft });
  await panel(page).getByRole('alert').filter({ hasText: '稿件与场景版本不匹配' }).waitFor();
});

test('an open panel clears the previous revision immediately and discards a late snapshot across draft switches', async t => {
  const fx = await fixture(t);
  async function associate(draft, reference) {
    const record = await fx.prepare({ title: `${draft.title}记录`, references: [reference] });
    await fx.invoke('generations.save', { generationId: record.generationId, output: { opening: '灯亮了。', development: '等船。', ending: '离开。' } });
    await fx.invoke('generations.evidence.attach', { generationId: record.generationId, draftId: draft.draftId,
      draftRevision: draft.revision, authorConfirmed: true });
    return record;
  }
  await associate(fx.draft, { kind: 'source', id: fx.source.sourceId, revision: 1 });
  const revised = await fx.invoke('draft.revise', { draftId: fx.draft.draftId, expectedRevision: 1, body: '这是修订后的正文。' });
  const alternate = await fx.invoke('draft.create', { sceneId: fx.scene.sceneId, sceneRevision: 1, title: '另一候选稿', body: '他转身离开渡口。' });
  const alternateRecord = await associate(alternate, { kind: 'character', id: fx.character.characterId, revision: 1 });
  const page = await open(t, fx);
  const firstPath = `${fx.path()}&draftRevision=1#passage-body`;
  const secondPath = `${fx.path()}&draftRevision=2#passage-body`;
  const alternatePath = `/evidence-fixture?sceneId=${fx.scene.sceneId}&draftId=${alternate.draftId}&draftRevision=1#passage-body`;
  await page.goto(firstPath);
  await button(page, '工具栏依据').click();
  await panel(page).getByText(fx.source.body, { exact: true }).waitFor();
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let received;
  const reading = new Promise(resolve => { received = resolve; });
  let settled;
  const finished = new Promise(resolve => { settled = resolve; });
  await page.route('**/api/web/invoke', async route => {
    const request = route.request().postDataJSON();
    if (request.operationId !== 'generations.get' || request.input.generationId !== alternateRecord.generationId) return route.continue();
    const response = await route.fetch();
    received();
    await delayed;
    try { await route.fulfill({ response }); } catch {} finally { settled(); }
  });
  async function switchTo(draft, path) {
    await page.evaluate(({ scene, draft, path }) => {
      history.pushState(null, '', path);
      window.switchEvidence(scene, draft);
    }, { scene: fx.scene, draft, path });
    await panel(page).getByText(`${draft.title} · 修订 ${draft.revision}`, { exact: true }).waitFor();
    assert.equal(await page.locator('#passage-body').innerText(), draft.body);
    assert.equal(await page.locator('.evidence-trigger').getAttribute('aria-expanded'), 'true');
  }
  await switchTo(revised, secondPath);
  await panel(page).getByText(emptyDraft, { exact: true }).waitFor();
  assert.equal(await panel(page).locator('.evidence-content').count(), 0);
  await switchTo(alternate, alternatePath);
  try {
    await reading;
    assert.equal(await panel(page).getByText(fx.source.body, { exact: true }).count(), 0);
    await switchTo(revised, secondPath);
  } finally { release(); }
  await finished;
  await panel(page).getByText(emptyDraft, { exact: true }).waitFor();
  assert.equal(await panel(page).locator('.evidence-content').count(), 0);
  await page.unrouteAll({ behavior: 'wait' });
  await switchTo(alternate, alternatePath);
  const alternateLink = panel(page).getByRole('link', { name: '守灯人 · 第 1 版', exact: true });
  assert.equal(await alternateLink.getAttribute('href'), hrefWithReturn(`/characters/${fx.character.characterId}?revision=1`, alternatePath));
  assert.equal(await panel(page).getByText(fx.source.body, { exact: true }).count(), 0);
});

test('scene preparation history keeps multiple records available after expanding the selector', async t => {
  const fx = await fixture(t);
  const first = await fx.prepare({ title: '人物组稿', references: [{ kind: 'character', id: fx.character.characterId, revision: 1 }] });
  const second = await fx.prepare({ title: '原文组稿', references: [{ kind: 'source', id: fx.source.sourceId, revision: 1 }] });
  const page = await open(t, fx, false);
  await button(page, '工具栏依据').click();
  const selector = panel(page).getByRole('combobox', { name: '为此场景准备的组稿' });
  const summary = panel(page).getByText('切换来源记录', { exact: true });
  await summary.waitFor();
  assert.equal(await selector.count(), 0);
  await summary.click();
  await selector.selectOption(first.generationId);
  const fixed = panel(page).getByRole('region', { name: '组稿固定输入' });
  await fixed.getByText(fx.character.persona, { exact: true }).waitFor();
  await selector.selectOption(second.generationId);
  await fixed.getByText(fx.source.body, { exact: true }).waitFor();
});

for (const engine of [chromium, webkit]) {
  test(`mobile evidence focus in ${engine.name()}`, async t => {
    const fx = await fixture(t);
    const browser = await engine.launch();
    t.after(() => browser.close());
    const focused = locator => locator.evaluate(node => node === document.activeElement);

    async function openAtWidth(t, width) {
      const page = await browser.newPage({ baseURL: fx.origin, viewport: { width, height: 844 },
        ...(engine === webkit ? { isMobile: true, hasTouch: true } : {}) });
      t.after(() => page.close());
      await page.goto(fx.path());
      await button(page, '工具栏依据').press('Enter');
      await responsivePanel(page, width).getByText(emptyDraft, { exact: true }).waitFor();
      return page;
    }

    await t.test('Tab wraps at the last visible control with the attachment closed or open', async t => {
      const page = await openAtWidth(t, 390);
      const dialog = responsivePanel(page, 390);
      const attachment = dialog.locator('.evidence-attachment');
      const summary = attachment.locator('summary');
      const close = button(dialog, '关闭依据');
      assert.equal(await attachment.getAttribute('open'), null);
      await summary.focus();
      assert.equal(await focused(summary), true);
      await page.keyboard.press('Tab');
      assert.equal(await focused(close), true, 'Tab from the closed attachment summary wraps to Close');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focused(summary), true, 'Shift+Tab returns to the closed attachment summary');

      await page.keyboard.press('Enter');
      const inspect = button(attachment, '读取待核对组稿');
      await inspect.focus();
      assert.equal(await focused(inspect), true);
      await page.keyboard.press('Tab');
      assert.equal(await focused(close), true, 'Tab from the expanded attachment button wraps to Close');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await focused(button(page, '工具栏依据')), true);
    });

    await t.test('resizing into a modal brings outside focus to Close and preserves inside focus', async t => {
      const page = await openAtWidth(t, 768);
      const passage = page.locator('#passage-body');
      await passage.focus();
      assert.equal(await focused(passage), true);

      const dialog = responsivePanel(page, 390);
      await page.setViewportSize({ width: 390, height: 844 });
      await dialog.waitFor();
      assert.equal(await dialog.getAttribute('aria-modal'), 'true');
      assert.equal(await passage.evaluate(node => node.inert), true);
      assert.equal(await focused(button(dialog, '关闭依据')), true, 'the modal moves reading focus to Close');

      const summary = page.locator('.evidence-attachment summary');
      await summary.focus();
      await page.setViewportSize({ width: 768, height: 844 });
      await responsivePanel(page, 768).waitFor();
      assert.equal(await passage.evaluate(node => node.inert), false);
      await page.setViewportSize({ width: 390, height: 844 });
      await dialog.waitFor();
      assert.equal(await focused(summary), true, 'focus already inside the panel stays on the same control');

      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await focused(button(page, '工具栏依据')), true);
      assert.equal(await passage.evaluate(node => node.inert), false);
    });
  });
}

test('opening uses the current viewport before a delayed media change reaches the component', async t => {
  const fx = await fixture(t);
  const page = await openBrowser(t, fx.origin, { width: 640, height: 800 });
  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    const pending = [];
    window.pendingEvidenceMediaChanges = () => pending.length;
    window.releaseEvidenceMediaChanges = () => pending.splice(0).forEach(deliver => deliver());
    window.matchMedia = query => {
      const media = nativeMatchMedia(query);
      if (query !== '(width < 640px)') return media;
      const add = media.addEventListener.bind(media);
      const remove = media.removeEventListener.bind(media);
      const listeners = new Map();
      media.addEventListener = (type, listener, options) => {
        if (type !== 'change') return add(type, listener, options);
        const deferred = event => pending.push(() => listener.call(media, event));
        listeners.set(listener, deferred);
        add(type, deferred, options);
      };
      media.removeEventListener = (type, listener, options) => remove(type, listeners.get(listener) ?? listener, options);
      return media;
    };
  });
  await page.goto(fx.path());
  await button(page, '工具栏依据').click();
  await responsivePanel(page, 640).getByText(emptyDraft, { exact: true }).waitFor();
  await panel(page).press('Escape');
  for (const width of [390, 640, 639, 640, 390, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForFunction(() => window.pendingEvidenceMediaChanges() > 0);
    assert.equal(await page.evaluate(() => matchMedia('(width < 640px)').matches), width < 640);
    await button(page, '工具栏依据').press('Enter');
    const current = responsivePanel(page, width);
    await current.waitFor();
    assert.equal(await current.getAttribute('aria-modal'), width < 640 ? 'true' : null);
    assert.equal(await page.locator('.fixture-toolbar').evaluate(node => node.inert), width < 640);
    assert.equal(await page.evaluate(() => document.body.style.position), width < 640 ? 'fixed' : '');
    await current.press('Escape');
    await page.evaluate(() => window.releaseEvidenceMediaChanges());
    assert.equal(await panel(page).count(), 0);
    assert.equal(await page.locator('.fixture-toolbar').evaluate(node => node.inert), false);
    assert.equal(await page.evaluate(() => document.body.style.position), '');
    assert.equal(await button(page, '工具栏依据').evaluate(node => document.activeElement === node), true);
  }
});

test('toolbar opens a fixed independently scrolling side panel and mobile screen, restoring the reading position', async t => {
  const fx = await fixture(t);
  const longText = Array.from({ length: 70 }, (_, index) => `第 ${index + 1} 段。灯火落在水面，等船的人仍然望着远岸。`).join('\n\n');
  const source = await fx.invoke('source.create', { title: '漫长的渡口记录', kind: 'excerpt', body: longText });
  const draft = await fx.invoke('draft.create', { sceneId: fx.scene.sceneId, sceneRevision: 1, title: '长篇稿件', body: longText });
  const record = await fx.prepare({ references: [{ kind: 'source', id: source.sourceId, revision: 1 }] });
  await fx.invoke('generations.save', { generationId: record.generationId, output: { opening: '灯亮了。', development: '他等船。', ending: '钟响了。' } });
  await fx.invoke('generations.evidence.attach', { generationId: record.generationId, draftId: draft.draftId, draftRevision: 1, authorConfirmed: true });
  const page = await open(t, fx);
  await page.goto(`/evidence-fixture?sceneId=${fx.scene.sceneId}&draftId=${draft.draftId}`);
  await button(page, '本次依据').waitFor();
  for (const width of [1280, 768, 640, 639, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 300));
    await button(page, '工具栏依据').focus();
    const before = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    await button(page, '工具栏依据').press('Enter');
    await responsivePanel(page, width).getByRole('region', { name: '组稿固定输入' }).waitFor();
    const bounds = await panel(page).boundingBox();
    assert.ok(bounds);
    assert.equal(bounds.y, 0);
    assert.equal(bounds.height, 800);
    assert.ok(Math.abs(bounds.x + bounds.width - width) < 1);
    assert.ok(Math.abs(bounds.width - (width < 640 ? width : Math.min(320, width * .4))) < 1);
    assert.equal(await panel(page).getAttribute('role'), width < 640 ? 'dialog' : null);
    if (width < 640) {
      assert.equal(await panel(page).getAttribute('aria-modal'), 'true');
      assert.equal(await page.locator('.fixture-toolbar').evaluate(node => node.inert), true);
      assert.equal(await page.evaluate(() => document.body.style.position), 'fixed');
      await panel(page).press('Shift+Tab');
      assert.equal(await panel(page).evaluate(node => node.contains(document.activeElement)), true);
      await page.keyboard.press('Tab');
      assert.equal(await button(page, '关闭依据').evaluate(node => document.activeElement === node), true);
    }
    if (width === 1280) {
      await panel(page).getByText('查看完整内容', { exact: true }).click();
      await panel(page).getByText(longText, { exact: true }).waitFor();
    }
    await panel(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
    const close = await button(page, '关闭依据').boundingBox();
    const heading = await panel(page).getByRole('heading', { name: '本次依据', exact: true }).boundingBox();
    assert.ok(close && heading && close.y >= 0 && close.y + close.height < 100 && heading.y >= 0);
    assert.equal(await button(page, '关闭依据').evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), true, 'the sticky reading toolbar cannot cover the panel close control');
    const afterScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    await panel(page).hover();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })), afterScroll);
    if ([1280, 768, 640, 390, 320].includes(width)) await capture(page, `fixed-panel-${width}`);
    await panel(page).press('Escape');
    assert.equal(await panel(page).count(), 0);
    assert.deepEqual(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })), before);
    assert.equal(await page.locator('.fixture-toolbar').evaluate(node => node.inert), false);
    assert.equal(await page.evaluate(() => document.body.style.position), '');
    assert.equal(await button(page, '工具栏依据').evaluate(node => document.activeElement === node), true);
  }
  await page.setViewportSize({ width: 768, height: 800 });
  await page.locator('main').evaluate(node => node.style.setProperty('--ms-evidence-width', 'clamp(17rem, 34vw, 21rem)'));
  await button(page, '工具栏依据').click();
  assert.equal((await panel(page).boundingBox()).width, 272, 'panel consumes the same width variable as the frame');
  for (const width of [640, 390, 640, 639, 640, 390, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await responsivePanel(page, width).waitFor();
    assert.equal(await panel(page).getAttribute('aria-modal'), width < 640 ? 'true' : null);
    assert.equal(await page.locator('.fixture-toolbar').evaluate(node => node.inert), width < 640);
    assert.equal(await page.evaluate(() => document.body.style.position), width < 640 ? 'fixed' : '');
    assert.equal(await panel(page).evaluate(node => node.contains(document.activeElement)), true);
  }
  await panel(page).press('Escape');
});
