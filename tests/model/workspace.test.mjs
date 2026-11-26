import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { request as personalRequest } from '../../adapters/mcp/http.mjs';
import { openDatabase } from '../../src/database.ts';
import { createApp } from '../../src/server.ts';

const magpie = 'http://127.0.0.1:3425/v1';
export const modelSkip = process.env.STH_TEST_MAGPIE !== '1' && 'Set STH_TEST_MAGPIE=1 to use local Magpie';

const tools = [
  { type: 'function', function: {
    name: 'sth_personal_discover',
    description: 'Discover Sth operation IDs, effects and descriptions. Omit arguments or filter the index by prefix. After seeing an ID in the index, call again with only operationId to get its input schema.',
    parameters: { type: 'object', properties: { prefix: { type: 'string' }, operationId: { type: 'string' } }, additionalProperties: false },
  } },
  { type: 'function', function: {
    name: 'sth_personal_invoke',
    description: 'Call a Sth operation after fetching that operation ID’s input schema. Copy stable IDs and exact revisions from previous results.',
    parameters: {
      type: 'object', properties: { operationId: { type: 'string' }, input: { type: 'object' } },
      required: ['operationId', 'input'], additionalProperties: false,
    },
  } },
];

async function request(url, label, { body, token, timeout = 8_000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    headers, redirect: 'error', signal: AbortSignal.timeout(timeout),
    method: body === undefined ? 'GET' : 'POST', body: JSON.stringify(body),
  }).catch(error => { throw new Error(`${label} connection failed (${error.name})`); });
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    await response.body?.cancel();
    const error = new Error(`${label} returned HTTP 429${retryAfter ? ` (Retry-After: ${retryAfter})` : ''}`);
    error.status = 429;
    throw error;
  }
  assert.equal(response.status, 200, `${label} returned HTTP ${response.status}`);
  return response.json();
}

export async function openMagpie(t) {
  const model = process.env.STH_TEST_MAGPIE_MODEL || 'codex/gpt-6.2-sol';
  const token = process.env.MAGPIE_LOCAL_API_KEY || 'local';
  const { data } = await request(`${magpie}/models`, 'Magpie catalog', { token });
  assert.ok(data.some(item => item.id === model && item.tool_call),
    `Magpie must advertise tool calls for ${model}`);
  t.diagnostic(`Real Magpie route ${model}`);
  let rateLimit;
  return async (messages, turn) => {
    if (rateLimit) throw rateLimit;
    const completion = await request(`${magpie}/chat/completions`, `Magpie turn ${turn}`, {
      token, timeout: 50_000,
      body: { model, messages, tools, max_completion_tokens: 2_400, store: false },
    }).catch(error => {
      if (error.status === 429) rateLimit = error;
      throw error;
    });
    const choice = completion.choices?.[0];
    assert.ok(choice?.message, `Magpie turn ${turn} returned an assistant message`);
    assert.notEqual(choice.finish_reason, 'length', `Magpie turn ${turn} reached its token limit`);
    return choice.message;
  };
}

export async function openWorkspace(t) {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'sth-model-'));
  let db;
  let server;
  t.after(async () => {
    if (server?.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    db?.close();
    assert.equal(dirname(resolve(directory)), tempRoot);
    assert.match(basename(directory), /^sth-model-[a-z0-9]+$/i);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  db = openDatabase(directory);
  // Run the registered HTTP app without starting generation or media provider workers.
  server = createApp(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const web = (path, body) => request(`${origin}/api/web/${path}`, `Web ${path}`, { body });
  const invoke = async (operationId, input) => (await web('invoke', {
    operationId, input, stepId: `model-web:${randomUUID()}`,
  })).result;
  const pair = async () => {
    const { code } = await web('connections/code', {});
    const { status, value } = await personalRequest(origin, 'claim', { code, clientName: 'Magpie model acceptance' });
    assert.equal(status, 200, 'isolated personal connection claim');
    assert.ok(typeof value.token === 'string' && value.token.length > 0, 'temporary connection bearer issued');
    return value.token;
  };
  return { origin, web, invoke, pair };
}

export async function runChat(t, workspace, completion, token, prompt, { writes, maxTurns = 18 }) {
  const messages = [
    { role: 'system', content: '请按用户要求实际操作 Sth。先发现相关领域的目录索引，再按操作 ID 获取输入 schema。可以一次发起多个互不依赖的查找。必须按发现的 schema 填参，使用工具实际返回的 ID 和版本。成功后用一句话报告结果。' },
    { role: 'user', content: prompt },
  ];
  const indexed = new Map();
  const schemas = new Map();
  const calls = [];
  const discovery = [];
  const rejected = [];
  for (let turn = 1; turn <= maxTurns; turn++) {
    const message = await completion(messages, turn);
    if (!message.tool_calls?.length) {
      assert.ok(message.content?.trim(), 'model returned a final confirmation');
      assert.deepEqual(calls.filter(call => call.effect === 'write').map(call => call.id), writes,
        'the model performed exactly the authorized writes');
      assert.ok(discovery.some(query => query.view === 'index'), 'model requested a schema-free index');
      t.diagnostic(`Magpie ${turn} turns, ${discovery.filter(query => query.view === 'index').length} index requests, ` +
        `${schemas.size} operation schemas, ${calls.map(call => call.id).join(' → ')}`);
      if (rejected.length) t.diagnostic(`Shim rejected attempted calls: ${rejected.join(', ')}`);
      return { calls, confirmation: message.content };
    }
    messages.push({
      role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls,
      ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}),
    });
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      let result;
      if (call.function.name === 'sth_personal_discover') {
        assert.ok(Object.keys(args).every(key => key === 'prefix' || key === 'operationId'));
        const { prefix, operationId } = args;
        assert.ok(!(prefix && operationId), 'use one discovery selector at a time');
        if (operationId) assert.ok(indexed.has(operationId), `model indexed ${operationId} before fetching its schema`);
        const query = operationId ? { view: 'full', operationId } : { view: 'index', ...(prefix ? { prefix } : {}) };
        const { status, value } = await personalRequest(workspace.origin, 'catalog', query, token);
        assert.equal(status, 200, 'authenticated catalog lookup');
        discovery.push(query);
        if (operationId) {
          assert.equal(value.operations.length, 1);
          const { id, effect, description, inputSchema } = value.operations[0];
          assert.equal(id, operationId);
          assert.equal(effect, indexed.get(id));
          assert.ok(inputSchema && typeof inputSchema === 'object');
          schemas.set(id, effect);
          result = { operation: { id, effect, description, inputSchema } };
        } else {
          for (const operation of value.operations) {
            assert.deepEqual(Object.keys(operation).sort(), ['description', 'effect', 'id']);
            indexed.set(operation.id, operation.effect);
          }
          result = { operations: value.operations };
        }
      } else {
        assert.equal(call.function.name, 'sth_personal_invoke');
        const id = args.operationId;
        const effect = schemas.get(id);
        if (!effect) {
          rejected.push(`${id} (schema required)`);
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
            error: 'schema_required', message: `请先在目录索引中找到 ${id}，然后用 operationId 单独查询它的输入 schema，再按 schema 调用。`,
          }) });
          continue;
        }
        if (effect === 'write') {
          const nextWrite = calls.filter(call => call.effect === 'write').length;
          if (id !== writes[nextWrite]) {
            rejected.push(`${id} (write scope)`);
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
              error: 'fixture_write_scope', message: '这个操作超出本次请求的写入范围，未执行。按用户要求继续或确认已完成的操作。',
            }) });
            continue;
          }
        }
        const stepId = `model:${randomUUID()}`;
        const response = await personalRequest(workspace.origin, 'invoke', { operationId: id, stepId, input: args.input }, token);
        assert.equal(response.status, 200, `${id} invocation (${response.value.code ?? 'ok'}: ${response.value.message ?? ''})`);
        assert.equal(response.value.replayed, false);
        result = response.value;
        calls.push({ id, effect, input: args.input, result: result.result });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  assert.fail(`model exceeded ${maxTurns} turns after ${calls.map(call => call.id).join(', ')}`);
}

function called(chat, id, predicate = () => true) {
  const call = chat.calls.find(call => call.id === id && predicate(call));
  assert.ok(call, `model actually invoked ${id} for the expected resource`);
  return call.result;
}

const ten = '北港末班渡船是晚上十点';
const nine = '北港末班渡船是晚上九点';

if (import.meta.main) test('real Magpie uses all four Sth workspace stages through the authenticated operations API', {
  skip: modelSkip, timeout: 900_000,
}, async t => {
  const complete = await openMagpie(t);
  const workspace = await openWorkspace(t);
  const { invoke, origin, pair, web } = workspace;
  const index = await web('catalog?view=index');
  for (const id of ['source.search', 'scene.adopt', 'generations.save', 'jobs.read']) {
    assert.ok(index.operations.some(operation => operation.id === id), `${id} is registered in the normal HTTP app`);
  }
  assert.deepEqual((await invoke('project.list', {})).items, []);
  const token = await pair();
  let source;
  let scene;
  let projectId;
  const ensureSource = async () => {
    if (!source) {
      source = await invoke('source.create', { title: '北港渡船补充夹具', kind: 'setting', body: nine });
      t.diagnostic('Web seeded a source fixture for later stages after the stage 1 failure');
    }
    return source;
  };

  await t.test('stage 1 finds and pins ten and nine o’clock originals across Web and two paired chats', async t => {
    const date = '2026-11-23';
    const first = await runChat(t, workspace, complete, token,
      `帮我把引号内的设定原样存为个人资料《北港渡船》：「${ten}」。根据这条资料写一篇短日记《北港昨夜》，日期 ${date}。首次保存日记就要附上结构化引用，带资料 ID、版本和逐字摘录。资料和日记都独立保存，各创建一次，成功后确认。`,
      { writes: ['source.create', 'diary.create'] });
    const original = called(first, 'source.create');
    const oldDiary = called(first, 'diary.create');
    assert.equal(original.title, '北港渡船');
    assert.equal(original.body, ten);
    assert.deepEqual(original.projectIds, []);
    assert.equal(oldDiary.title, '北港昨夜');
    assert.equal(oldDiary.diaryDate, date);
    assert.equal(oldDiary.projectId, undefined);
    assert.deepEqual(oldDiary.sourcePins, [{ sourceId: original.sourceId, revision: 1, excerpt: ten, href: original.href }]);
    assert.deepEqual(await invoke('diary.read', { noteId: oldDiary.noteId }), oldDiary);

    source = await invoke('source.revise', { sourceId: original.sourceId, expectedRevision: 1, body: nine });
    assert.equal(source.revision, 2);
    const nextToken = await pair();
    assert.notEqual(nextToken, token, 'the second chat uses a fresh pairing and conversation');
    const second = await runChat(t, workspace, complete, nextToken,
      `我分享了旧日记 ${oldDiary.href}。请读它和当时引用的资料版本。再用“北港渡船”搜索最新资料并读原文，创建个人短日记《北港今夜》，日期 ${date}。首次保存新日记就要附上最新原文的结构化版本引用，最后反查这条资料被哪些日记引用。`,
      { writes: ['diary.create'] });
    assert.deepEqual(called(second, 'diary.read'), oldDiary);
    assert.deepEqual(called(second, 'source.read', ({ input }) => input.revision === 1), original);
    const matches = called(second, 'source.search');
    assert.ok(matches.items.some(item => item.sourceId === source.sourceId && item.revision === 2));
    assert.deepEqual(called(second, 'source.read', ({ result }) => result.revision === 2), source);
    const newer = called(second, 'diary.create');
    assert.equal(newer.title, '北港今夜');
    assert.deepEqual(newer.sourcePins, [{ sourceId: source.sourceId, revision: 2, excerpt: nine, href: source.href }]);
    const ids = links => new Set(links.items.map(({ owner }) => owner.id));
    assert.deepEqual(ids(called(second, 'source.backlinks')), new Set([oldDiary.noteId, newer.noteId]));
    assert.deepEqual(ids(await invoke('source.backlinks', { sourceId: source.sourceId })), new Set([oldDiary.noteId, newer.noteId]));
    assert.deepEqual(await invoke('diary.read', { noteId: newer.noteId }), newer);
    for (const pin of [oldDiary.sourcePins[0], newer.sourcePins[0]]) {
      const url = new URL(pin.href, origin);
      assert.equal(url.pathname, `/sources/${pin.sourceId}`);
      assert.equal(url.searchParams.get('revision'), String(pin.revision));
      const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, 'pinned source URL resolves at the isolated Web entry');
    }
    t.diagnostic(`Web revised ${source.sourceId} 1→2. Fresh pairing read both originals and persisted both diary backlinks.`);
  });

  await t.test('stage 2 compares two candidate drafts and adopts the author-selected revision', async t => {
    await ensureSource();
    ({ projectId } = await invoke('project.create', { title: '虚构北港纪事' }));
    const chapter = await invoke('chapter.create', { projectId, title: '第一章' });
    const base = await invoke('scene.create', {
      title: '渡灯未灭', place: '北港码头', sources: [{ sourceId: source.sourceId, revision: source.revision, excerpt: nine }],
    });
    await invoke('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: chapter.revision, sceneIds: [base.sceneId] });
    scene = await invoke('scene.read', { sceneId: base.sceneId });
    const context = { sceneId: base.sceneId, sceneRevision: base.revision };
    const left = await invoke('draft.create', { ...context, title: '渡口回声', body: '船尚未靠岸，孩子在雨里听见一阵桨声。' });
    const right = await invoke('draft.create', { ...context, title: '灯塔信号', body: '守塔人举起灯，九点的渡船在雨中调头。' });
    const chat = await runChat(t, workspace, complete, token,
      `请查找场景《${base.title}》，用候选稿对照操作比较《${left.title}》和《${right.title}》，然后把《${right.title}》的当前版本采纳为这场戏的正式稿。`,
      { writes: ['scene.adopt'] });
    const compared = chat.calls.find(call => call.id === 'draft.compare');
    assert.ok(compared, 'model used the candidate comparison operation');
    assert.deepEqual(new Set([compared.input.left.draftId, compared.input.right.draftId]), new Set([left.draftId, right.draftId]));
    const adopted = called(chat, 'scene.adopt');
    scene = await invoke('scene.read', { sceneId: base.sceneId });
    const pinnedDraft = await invoke('draft.read', { draftId: right.draftId, revision: right.revision });
    assert.deepEqual(scene.adopted, pinnedDraft);
    assert.deepEqual(adopted.adopted, pinnedDraft);
    assert.equal(scene.revision, base.revision + 1);
    const readChapter = await invoke('chapter.read', { chapterId: chapter.chapterId });
    assert.ok(readChapter.scenes.some(item => item.sceneId === base.sceneId));
    assert.deepEqual(await invoke('draft.read', { draftId: left.draftId }), left);
    t.diagnostic(`Web read scene revision ${scene.revision} with adopted draft ${right.draftId}@${right.revision}. Both candidates remain stored.`);
  });

  await t.test('stage 3 saves validated text written by the current chat using a versioned template', async t => {
    await ensureSource();
    const template = await invoke('templates.create', {
      title: '北港双段日记', kind: 'diary', fields: [
        { key: 'opening', label: '所见', type: 'text', maxLength: 140 },
        { key: 'reflection', label: '所感', type: 'text', maxLength: 140 },
      ],
    });
    const title = '九点渡船札记';
    const chat = await runChat(t, workspace, complete, token,
      `请查用《${template.title}》模板，准备写作并在当前会话完成《${title}》。用第一人称写两个简短段落，第一段必须有“九点”。资料是 ${source.href}，引用原句“${nine}”。这次只交付一份独立的模板生成记录，保存结构化正文成功后直接确认完成。`,
      { writes: ['generations.prepare', 'generations.save'] });
    const prepared = called(chat, 'generations.prepare');
    const saved = called(chat, 'generations.save');
    const generation = await invoke('generations.get', { generationId: prepared.generationId });
    assert.equal(generation.title, title);
    assert.equal(generation.mode, 'current-chat');
    assert.equal(generation.status, 'succeeded');
    assert.equal(generation.plan, undefined);
    assert.deepEqual(generation.composition.template, template);
    assert.deepEqual(generation.composition.references.map(({ id, revision, href, excerpt }) => ({ id, revision, href, excerpt })),
      [{ id: source.sourceId, revision: source.revision, href: source.href, excerpt: nine }]);
    assert.equal(saved.result.resultId, generation.result.resultId);
    const result = await invoke('generations.result.get', { resultId: generation.result.resultId });
    assert.deepEqual(Object.keys(result.output).sort(), ['opening', 'reflection']);
    assert.match(result.output.opening, /九点/);
    assert.ok(result.output.reflection.trim());
    assert.deepEqual(result.output, chat.calls.find(call => call.id === 'generations.save').input.output);
    assert.deepEqual((await invoke('generations.list', {})).items.map(({ mode }) => mode), ['current-chat']);
    t.diagnostic(`Web read generation ${generation.generationId} and its two validated fields from template revision ${template.revision}.`);
  });

  await t.test('stage 4 selects a composition and checks actual queued job status in the same workspace', async t => {
    assert.ok(scene && projectId, 'stage 2 supplied the adopted scene and project');
    const composition = await invoke('composition.create', {
      projectId, sceneId: scene.sceneId, sceneRevision: scene.revision, candidates: [
        { title: '渡口俯瞰', prompt: '俯看虚构码头和一盏孤灯。' },
        { title: '雨中侧影', prompt: '雨幕中渡船与码头灯塔的侧影。' },
      ],
    });
    const candidate = composition.candidates[1];
    const title = '北港插画试跑';
    const chat = await runChat(t, workspace, complete, token,
      `我选虚构场景《${scene.title}》的构图《${candidate.title}》。构图组编号是 ${composition.compositionId}。请保存我的选择，为这个构图建一次手动出图任务《${title}》，再查询该任务的逐项进度告诉我。`,
      { writes: ['composition.select', 'jobs.create'] });
    const selection = called(chat, 'composition.select');
    assert.equal(selection.selectedCandidateId, candidate.candidateId);
    assert.equal(selection.selectionRevision, composition.selectionRevision + 1);
    assert.deepEqual(await invoke('composition.read', { compositionId: composition.compositionId }), selection);
    const created = called(chat, 'jobs.create');
    const queried = called(chat, 'jobs.read', ({ input }) => input.jobId === created.jobId);
    assert.deepEqual(await invoke('jobs.read', { jobId: created.jobId }), queried);
    assert.equal(queried.title, title);
    assert.equal(queried.mode, 'manual');
    assert.equal(queried.attemptsStarted, 0);
    assert.equal(queried.progress.queued, 1);
    assert.equal(queried.items.length, 1);
    assert.equal(queried.items[0].candidateId, candidate.candidateId);
    assert.equal(queried.items[0].scene.revision, scene.revision);
    t.diagnostic(`Model and Web read job ${queried.jobId} queued with one item pinned to scene revision ${scene.revision}. Provider workers are disabled.`);
  });
});
