import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { assetOperations, assetsDDL } from '../src/assets/index.ts';
import { connectionsDDL } from '../src/connections.ts';
import { Operations, operationsDDL } from '../src/core/index.ts';
import type {
  Generation, Plan, PromptInspection, PromptPage, PromptPageInput, ReferenceInput, Requirements,
} from '../src/generation/contracts.ts';
import { createOpenAICompatibleProvider, generationDDL, generationOperations, processNextGeneration } from '../src/generation/index.ts';
import { libraryDDL, libraryOperations } from '../src/library/index.ts';
import { createApp } from '../src/server.ts';
import { sourcesDDL, sourceOperations } from '../src/sources/index.ts';
import { storyDDL } from '../src/story/index.ts';

const diary = { setting: 'Harbor', events: 'Ferry arrived.', feelings: 'Relief', reflection: 'Remember the time.' };

test('Chinese template aliases resolve built-ins and preserve exact author titles', t => {
  const { call } = fixture(t);
  const list = (offset = 0) => call<{ items: { templateId: string }[] }>('templates.list', { name: '短篇故事', offset }).items;
  assert.deepEqual(list().map(row => row.templateId), ['short-story']);
  const custom = call<{ templateId: string }>('templates.create', { title: '短篇故事', kind: 'custom',
    fields: [{ key: 'line', label: '段落', type: 'text' }] });
  assert.deepEqual(list().map(row => row.templateId), [custom.templateId]);
  assert.deepEqual(list(1), []);
});
const planInput = { title: 'Named draft', executor: 'openai-compatible', provider: 'test', model: 'selected-model',
  parameters: { temperature: 0, responseFormat: 'json-schema' } };
const prepareInput = { title: 'Ferry', templateId: 'diary', brief: '\u7cbe\u786e "quoted" \u{1f6f3}\ufe0f\ntext',
  inputs: { 'weather/type': 'rain', count: 2, cast: [{ name: 'Lin' }] } };
const providerEnv = { STH_GENERATION_PROVIDERS_JSON: '{"test":{"baseUrl":"http://localhost/v1","apiKeyEnv":"KEY"}}',
  KEY: 'synthetic-provider-secret' };

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; ${operationsDDL}${assetsDDL}${libraryDDL}${sourcesDDL}${storyDDL}${generationDDL}`);
  const registry = new Operations(db, [...assetOperations, ...libraryOperations, ...sourceOperations, ...generationOperations]);
  let step = 0;
  function call<T>(operationId: string, input: unknown): T {
    return registry.invoke('owner:test', { operationId, stepId: `step-${++step}`, input }).result as T;
  }
  function inspect(generationId: string) { return call<PromptInspection>('generations.prompt', { generationId }); }
  function start(generationId: string) {
    const plan = call<Plan>('generation.plans.create', planInput);
    return call<Generation>('generations.start', { generationId, planId: plan.planId }).generationId;
  }
  function asset(contentType: string, bytes: Buffer) {
    return call<{ assetId: string; href: string }>('asset.import', { contentType, data: bytes.toString('base64') });
  }
  return { db, call, inspect, start, asset };
}

test('current-chat inspector pins exact text and provenance for the selected character blocks', t => {
  const { call, inspect, asset } = fixture(t);
  const audio = asset('audio/wav', Buffer.from('RIFF0000WAVEvoice'));
  const { characterId } = call<{ characterId: string }>('character.create', { name: 'Lin', description: 'Old description.', entries: [
    { entryId: 'clip/one', label: 'Dialogue sample', blocks: [{ type: 'audio', assetId: audio.assetId }, { type: 'text', text: 'Old transcript.' }] },
    { entryId: 'private', label: 'Background', blocks: [{ type: 'text', text: 'Omitted notes live here.' }] },
  ] });
  const { requirementId } = call<Requirements>('writing.requirements.set', { title: 'Diary style', constraints: ['Short'], tone: 'Sober' });
  const reference: ReferenceInput = { kind: 'character', id: characterId, revision: 1 };
  const core = call<Generation>('generations.prepare', { ...prepareInput, references: [reference] });
  assert.deepEqual(core.composition.references[0].content, { persona: 'Old description.', projectId: null });
  const coreTrace = inspect(core.generationId);
  assert.equal(coreTrace.href, `/generations/${core.generationId}/prompt`);
  const quoteOnly = call<Generation>('generations.prepare', { ...prepareInput, references: [{ ...reference,
    includeDescription: false, selections: [{ entryId: 'clip/one', blockIndex: 1 }] }] });
  assert.doesNotMatch(JSON.stringify(inspect(quoteOnly.generationId).messages), /Old description/);
  assert.match(JSON.stringify(inspect(quoteOnly.generationId).messages), /Old transcript/);
  assert.doesNotMatch(JSON.stringify(coreTrace.messages), /Dialogue sample|Old transcript|Background|Omitted notes|audio|assetId/);
  assert.ok(coreTrace.provenance.every(item => item.entryId === undefined && item.blockIndex === undefined));
  const input = { ...prepareInput, requirementId, references: [{ ...reference, selections: [{ entryId: 'clip/one', blockIndex: 1 }] }] };
  const prepared = call<Generation>('generations.prepare', input);
  const { generationId } = prepared;
  const trace = inspect(generationId);
  assert.equal(trace.status, 'provided');
  assert.equal(trace.historical, false);
  assert.deepEqual(trace.parameters, {});
  assert.deepEqual(trace.messages, prepared.composition.messages.map(({ role, content }) => ({ role, parts: [{ type: 'text', text: content }] })));
  assert.deepEqual(prepared.composition.references[0].content, { persona: 'Old description.', projectId: null, entries: [
    { entryId: 'clip/one', label: 'Dialogue sample', blocks: [{ type: 'text', text: 'Old transcript.' }] },
  ] });
  assert.doesNotMatch(JSON.stringify(trace.messages), /Omitted notes|Background|audio|assetId/);
  const span = (path: string) => {
    const row = trace.provenance.find(item => item.disposition === 'included' && item.path === path);
    assert.ok(row?.disposition === 'included');
    const part = trace.messages[row.messageIndex].parts[row.partIndex];
    assert.ok(part.type === 'text' && row.start !== undefined && row.end !== undefined);
    return { row, text: part.text.slice(row.start, row.end) };
  };
  assert.equal(span('/system').row.kind, 'fixed');
  assert.equal(JSON.parse(span('/brief').text), prepareInput.brief);
  assert.equal(JSON.parse(span('/inputs/weather~1type').text), 'rain');
  assert.equal(JSON.parse(span('/inputs/cast/0/name').text), 'Lin');
  assert.equal(span('/template/fields/0/key').row.revision, 1);
  assert.equal(span('/requirements/constraints/0').row.id, requirementId);
  const block = span('/references/0/content/entries/0/blocks/0/text');
  assert.equal(block.row.blockIndex, 1);
  assert.equal(block.row.entryId, 'clip/one');
  assert.equal(block.row.revision, 1);
  assert.equal(JSON.parse(block.text), 'Old transcript.');
  assert.doesNotMatch(JSON.stringify(trace.provenance), /private|Background|audio|not-selected/);
  assert.ok(trace.provenance.filter(row => row.blockIndex !== undefined).every(row => row.blockIndex === 1 && row.blockType === 'text'));

  call('character.revise', { characterId, expectedRevision: 1, description: 'Revised description.', entries: [] });
  call('writing.requirements.set', { requirementId, expectedRevision: 1, title: 'Diary style', tone: 'Cheerful' });
  call('generations.save', { generationId, output: diary, reportedModel: 'reported-chat-model' });
  assert.deepEqual(inspect(generationId), trace);
  assert.deepEqual(inspect(call<Generation>('generations.prepare', {
    ...input, requirementRevision: 1,
  }).generationId).provenance, trace.provenance);
  assert.throws(() => call('generations.prepare', { ...input, references: [{ ...reference, revision: 2,
    selections: [{ entryId: 'clip/one', blockIndex: 1 }] }] }), { code: 'generation_character_selection_missing' });
  assert.throws(() => call('generations.prepare', { ...input, references: [{ ...reference,
    selections: [{ entryId: 'clip/one', blockIndex: 9 }] }] }), { code: 'generation_character_selection_missing' });
});

test('unselected labels do not count toward prompt limits and a selected reference supplies a pinned pointer', t => {
  const { call, inspect } = fixture(t);
  const { sourceId } = call<{ sourceId: string }>('source.create', {
    title: 'Target source', kind: 'setting', body: 'Body only available in the target source.',
  });
  const target = { kind: 'source', id: sourceId, revision: 1 };
  const longLabel = 'Unselected label '.padEnd(300, 'x');
  // The labels alone exceed the text budget and the old omitted rows exceeded the provenance budget.
  const entries = Array.from({ length: 3_500 }, (_, index) => ({ entryId: `unused-${index}`, label: longLabel, blocks: [] }));
  const kept = { entryId: 'kept', label: 'Kept pointer', blocks: [{ type: 'reference', ...target }] };
  const { characterId } = call<{ characterId: string }>('character.create', { name: 'Lin', entries: [...entries, kept] });
  const prepared = call<Generation>('generations.prepare', { ...prepareInput, references: [
    { kind: 'character', id: characterId, revision: 1, entryIds: ['kept'] },
  ] });
  const trace = inspect(prepared.generationId);
  assert.deepEqual(prepared.composition.references[0].content, { persona: '', projectId: null, entries: [kept] });
  assert.doesNotMatch(JSON.stringify(trace.messages), /Unselected label|unused-\d+|Body only available/);
  assert.doesNotMatch(JSON.stringify(trace.provenance), /Unselected label|unused-\d+/);
  const pointer = trace.provenance.find(item => item.path === '/references/0/content/entries/0/blocks/0');
  assert.ok(pointer);
  assert.deepEqual(pointer.target, target);
  const part = trace.messages[pointer.messageIndex].parts[pointer.partIndex];
  assert.equal(part.type, 'text');
  assert.deepEqual(JSON.parse(part.text.slice(pointer.start, pointer.end)), kept.blocks[0]);
});

test('delegation sends selected image and audio bytes in pinned order with matching text and options', async t => {
  const { call, inspect, start, asset, db } = fixture(t);
  const imageBytes = Buffer.from('\x89PNG\r\n\x1a\nimage', 'latin1');
  const audioBytes = Buffer.from('RIFF0000WAVEvoice');
  const image = asset('image/png', imageBytes);
  const audio = asset('audio/wav', audioBytes);
  const { sourceId } = call<{ sourceId: string }>('source.create', { title: 'Tide', kind: 'setting', body: 'The tide is high.' });
  const target = { kind: 'source', id: sourceId, revision: 1 };
  const { characterId } = call<{ characterId: string }>('character.create', { name: 'Lin', entries: [
    { entryId: 'portrait', label: 'Portrait', blocks: [
      { type: 'text', text: 'Omitted portrait notes' }, { type: 'image', assetId: image.assetId },
    ] },
    { entryId: 'sound', label: 'Voice', blocks: [
      { type: 'audio', assetId: audio.assetId }, { type: 'reference', ...target, excerpt: 'tide is high' },
    ] },
    { entryId: 'text', label: 'Selected text', blocks: [{ type: 'text', text: 'A selected third entry.' }] },
  ] });
  const prepared = call<Generation>('generations.prepare', { ...prepareInput, references: [
    { kind: 'character', id: characterId, revision: 1, entryIds: ['sound'], selections: [
      { entryId: 'text', blockIndex: 0 }, { entryId: 'sound', blockIndex: 0 }, { entryId: 'portrait', blockIndex: 1 },
    ] },
    { ...target, excerpt: 'tide is high' },
  ] });
  const generationId = start(prepared.generationId);
  const queued = inspect(generationId);
  assert.equal(queued.status, 'prepared');
  assert.deepEqual(queued.messages, inspect(prepared.generationId).messages);
  assert.deepEqual(queued.provenance, inspect(prepared.generationId).provenance);
  assert.deepEqual(queued.provenance.find(item => item.blockType === 'reference')?.target, target);
  assert.match(JSON.stringify(queued.messages), /A selected third entry/);
  const [context, portrait, sound] = queued.messages[1].parts;
  assert.ok(context.type === 'text' && portrait.type === 'image' && sound.type === 'audio');
  for (const [part, fixture, bytes] of [[portrait, image, imageBytes], [sound, audio, audioBytes]] as const) {
    assert.equal(part.asset.assetId, fixture.assetId);
    assert.equal(part.asset.href, fixture.href);
    assert.equal(part.asset.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(queued.provenance.find(item => item.disposition === 'included' && item.partIndex === 1)?.blockIndex, 1);
  assert.doesNotMatch(context.text, /Omitted portrait notes/);
  assert.ok(queued.provenance.every(item => item.entryId !== 'portrait' || item.blockIndex !== 0));
  assert.doesNotMatch(JSON.stringify(queued), /base64|synthetic-provider-secret/);
  call('character.revise', { characterId, expectedRevision: 1, entries: [] });
  call('source.revise', { sourceId, expectedRevision: 1, body: 'Low tide.' });
  call('generation.plans.update', { ...planInput, planId: queued.parameters.plan?.planId, expectedRevision: 1, model: 'revised-model' });

  let wire: { messages: unknown[]; [key: string]: unknown } | undefined;
  assert.equal(await processNextGeneration(db, createOpenAICompatibleProvider(providerEnv, async (_url, init) => {
    assert.equal(inspect(generationId).status, 'unknown');
    wire = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-provider-secret');
    return Response.json({ choices: [{ message: { content: JSON.stringify(diary) }, finish_reason: 'stop' }] });
  })), true);
  assert.ok(wire);
  const { messages, ...requestOptions } = wire;
  assert.deepEqual(messages, [prepared.composition.messages[0], { role: 'user', content: [
    context,
    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBytes.toString('base64')}` } },
    { type: 'input_audio', input_audio: { data: audioBytes.toString('base64'), format: 'wav' } },
  ] }]);
  const sent = inspect(generationId);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.parameters.plan?.revision, 1);
  assert.deepEqual(sent.parameters.requestOptions, requestOptions);
  assert.deepEqual(sent.provenance, queued.provenance);
  assert.deepEqual(sent.messages, queued.messages);
  assert.equal(call<Generation>('generations.get', { generationId }).status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(sent), /synthetic-provider-secret|localhost|revised-model|Low tide/);
});

test('legacy omitted rows are filtered from reads and copies into new delegations', t => {
  const { call, inspect, start, db } = fixture(t);
  const { generationId } = call<Generation>('generations.prepare', prepareInput);
  const before = inspect(generationId);
  db.prepare(`UPDATE generation_records SET composition_json = json_insert(composition_json, '$.promptProvenance[#]', json(?))
    WHERE generation_id = ?`).run(JSON.stringify({ kind: 'reference', path: '/references/0/content/entries/0', entryId: 'legacy-private',
      entryLabel: 'Legacy unselected label', disposition: 'omitted', reason: 'not-selected' }), generationId);
  assert.deepEqual(inspect(generationId), before);

  const delegationId = start(generationId);
  const persisted = db.prepare('SELECT composition_json FROM generation_records WHERE generation_id = ?').get(delegationId);
  assert.ok(persisted);
  assert.deepEqual(JSON.parse(String(persisted.composition_json)).promptProvenance, before.provenance);
  assert.deepEqual(inspect(delegationId).provenance, before.provenance);
});

test('historical prompt fallback uses stored messages and only approved options', t => {
  const { call, inspect, start, db } = fixture(t);
  const prepared = call<Generation>('generations.prepare', prepareInput);
  db.prepare(`UPDATE generation_records SET composition_json = json_remove(composition_json, '$.promptProvenance')
    WHERE generation_id = ?`).run(prepared.generationId);
  const old = inspect(prepared.generationId);
  assert.equal(old.historical, true);
  assert.equal(old.status, 'unknown');
  assert.deepEqual(old.provenance, []);
  assert.deepEqual(old.messages, prepared.composition.messages.map(({ role, content }) => ({ role, parts: [{ type: 'text', text: content }] })));
  const delegated = start(prepared.generationId);
  db.prepare(`UPDATE generation_records SET status = 'succeeded', execution_json = json_set(json_remove(execution_json, '$.promptStatus'),
    '$.requestOptions', json(?)) WHERE generation_id = ?`).run(JSON.stringify({ model: 'selected-model', stream: false, n: 1,
    authorization: 'legacy-secret', temperature: 0.8, response_format: { type: 'json_object', secret: 'legacy-secret' } }), delegated);
  const historical = inspect(delegated);
  assert.equal(historical.historical, true);
  assert.equal(historical.status, 'unknown');
  assert.deepEqual(historical.parameters.requestOptions, { model: 'selected-model', stream: false, n: 1 });
  assert.doesNotMatch(JSON.stringify(historical), /legacy-secret/);
  assert.deepEqual(call('generations.prompt.page', { generationId: delegated, section: 'provenance' }), {
    generationId: delegated, section: 'provenance', start: 0, end: 2, totalLength: 2, fragment: '[]', nextCursor: null,
  });
});

test('personal HTTP prompt pages fit the tool budget and restore long Unicode, media and provenance exactly', async t => {
  const { call, inspect, asset, db } = fixture(t);
  const image = asset('image/png', Buffer.from('\x89PNG\r\n\x1a\nimage', 'latin1'));
  const audio = asset('audio/wav', Buffer.from('RIFF0000WAVEvoice'));
  const { characterId } = call<{ characterId: string }>('character.create', { name: 'Lin', entries: [
    { entryId: 'media', label: 'Media', blocks: [
      { type: 'image', assetId: image.assetId }, { type: 'audio', assetId: audio.assetId },
    ] },
  ] });
  const longKey = '\u6c34\u{1f6f3}~/"\\'.repeat(8_000);
  const longText = '\u6545\u4e8b\u{1f6f3}"\\\n\t\u0000\uD800'.repeat(7_000);
  const { generationId } = call<Generation>('generations.prepare', { ...prepareInput, inputs: { [longKey]: longText }, references: [
    { kind: 'character', id: characterId, revision: 1, entryIds: ['media'] },
  ] });
  const full = inspect(generationId);
  assert.deepEqual(full.messages[1].parts.map(part => part.type), ['text', 'image', 'audio']);
  assert.ok(full.provenance.some(row => row.path.length > 50_000));
  assert.ok(JSON.stringify(full.messages).length > 50_000);

  db.exec(connectionsDDL);
  const server = createApp(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    await closed;
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  async function post(path: string, body: unknown, token?: string) {
    const response = await fetch(`${origin}/api/${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, path);
    return response.json();
  }
  const personal = 'v1/personal-operations';
  const { code } = await post('web/connections/code', {});
  const { token } = await post(`${personal}/claim`, { code, clientName: 'Prompt pagination test' });
  const operationId = 'generations.prompt.page';
  const catalog = await post(`${personal}/catalog`, { operationId }, token);
  assert.deepEqual(catalog.operations.map((operation: { id: string; effect: string }) => [operation.id, operation.effect]), [[operationId, 'read']]);
  const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
  let step = 0;
  for (const section of ['messages', 'provenance'] as const) {
    const expected = JSON.stringify(full[section]);
    const fragments: string[] = [];
    let cursor = 0;
    while (cursor < expected.length) {
      const input: PromptPageInput = { generationId, ...(section === 'provenance' ? { section } : {}),
        ...(cursor === 0 ? {} : { cursor }) };
      const stepId = `prompt-page-${++step}`.padEnd(512, '\u6c34');
      const envelope = await post(`${personal}/invoke`, { operationId, stepId, input }, token);
      assert.deepEqual(Object.keys(envelope.result).sort(), ['end', 'fragment', 'generationId', 'nextCursor', 'section', 'start', 'totalLength']);
      const page: PromptPage = envelope.result;
      const mcp = { jsonrpc: '2.0', id: step, result: {
        content: [{ type: 'text', text: asciiJson(envelope) }], structuredContent: envelope,
      } };
      assert.ok(asciiJson(mcp).length < 45_000, 'Leave room even with duplicated MCP content and ASCII escaping');
      assert.equal(page.generationId, generationId);
      assert.equal(page.section, section);
      assert.equal(page.start, cursor);
      assert.equal(page.totalLength, expected.length);
      assert.ok(page.fragment.length > 0);
      assert.doesNotMatch(page.fragment, /\p{Surrogate}/u);
      assert.equal(page.end, cursor + page.fragment.length);
      assert.equal(page.nextCursor, page.end === expected.length ? null : page.end);
      fragments.push(page.fragment);
      cursor = page.end;
    }
    assert.ok(fragments.length > 1);
    const reassembled = fragments.join('');
    assert.equal(reassembled, expected);
    assert.deepEqual(JSON.parse(reassembled), full[section]);
  }
  const web = await post('web/invoke', { operationId: 'generations.prompt', stepId: 'prompt-full', input: { generationId } });
  assert.deepEqual(web.result, full);
});

test('prompt page rejects offsets outside the array or inside a surrogate pair', t => {
  const { call, inspect } = fixture(t);
  const { generationId } = call<Generation>('generations.prepare', prepareInput);
  const json = JSON.stringify(inspect(generationId).messages);
  const characterStart = json.indexOf('\u{1f6f3}');
  assert.ok(characterStart >= 0);
  for (const cursor of [characterStart + 1, json.length, json.length + 1]) {
    assert.throws(() => call('generations.prompt.page', { generationId, cursor }), { code: 'generation_prompt_cursor_invalid' });
  }
  for (const cursor of [-1, 0.5]) {
    assert.throws(() => call('generations.prompt.page', { generationId, cursor }), { code: 'operation_invalid_input' });
  }
  const page = call<PromptPage>('generations.prompt.page', { generationId, cursor: characterStart });
  assert.equal(page.fragment, json.slice(characterStart));
  assert.equal(page.nextCursor, null);
});

test('unsupported audio fails before dispatch, while missing response leaves delivery unknown', async t => {
  const { call, inspect, start, asset, db } = fixture(t);
  const audio = asset('audio/flac', Buffer.from('fLaCvoice'));
  const { characterId } = call<{ characterId: string }>('character.create', { name: 'Lin', entries: [
    { entryId: 'voice', label: 'Voice', blocks: [{ type: 'audio', assetId: audio.assetId }] },
  ] });
  const prepared = call<Generation>('generations.prepare', { ...prepareInput, references: [
    { kind: 'character', id: characterId, revision: 1, entryIds: ['voice'] },
  ] });
  const audioId = start(prepared.generationId);
  await processNextGeneration(db, createOpenAICompatibleProvider(providerEnv, async () => assert.fail('Unsupported audio reached fetch')));
  assert.equal(inspect(audioId).status, 'prepared');
  assert.match(call<Generation>('generations.get', { generationId: audioId }).error?.message ?? '', /WAV or MP3/);

  const planId = inspect(audioId).parameters.plan?.planId;
  const text = call<Generation>('generations.prepare', prepareInput);
  const textId = call<Generation>('generations.start', { generationId: text.generationId, planId }).generationId;
  await processNextGeneration(db, createOpenAICompatibleProvider(providerEnv, async () => { throw new Error('connection lost'); }));
  assert.equal(inspect(textId).status, 'unknown');
  assert.equal(call<Generation>('generations.get', { generationId: textId }).status, 'uncertain');
  const rejectedId = call<Generation>('generations.start', { generationId: text.generationId, planId }).generationId;
  await processNextGeneration(db, createOpenAICompatibleProvider(providerEnv, async () => new Response('denied', { status: 400 })));
  assert.equal(inspect(rejectedId).status, 'sent');
  assert.equal(call<Generation>('generations.get', { generationId: rejectedId }).status, 'failed');
});

test('media selection size is bounded and changed bytes cannot be dispatched', async t => {
  const { call, inspect, start, asset, db } = fixture(t);
  const bytes = Buffer.alloc(6 * 1024 * 1024);
  bytes.write('\x89PNG\r\n\x1a\n', 'latin1');
  const { assetId } = asset('image/png', bytes);
  const { characterId } = call<{ characterId: string }>('character.create', { name: 'Lin', entries: [
    { entryId: 'images', label: 'Images', blocks: Array.from({ length: 3 }, () => ({ type: 'image', assetId })) },
  ] });
  const reference = { kind: 'character', id: characterId, revision: 1 };
  assert.throws(() => call('generations.prepare', { ...prepareInput, references: [{ ...reference, entryIds: ['images'] }] }),
    { code: 'generation_media_too_large' });
  const selected = call<Generation>('generations.prepare', { ...prepareInput, references: [{ ...reference, selections: [
    { entryId: 'images', blockIndex: 0 },
  ] }] });
  assert.ok(Buffer.byteLength(JSON.stringify(inspect(selected.generationId))) < 5 * 1024 * 1024);
  const generationId = start(selected.generationId);
  const before = inspect(generationId);
  // Simulate corruption of the bytes on disk while retaining the stored asset hash.
  bytes[bytes.length - 1] = 1;
  db.prepare('UPDATE workspace_assets SET bytes = ? WHERE asset_id = ?').run(bytes, assetId);
  let calls = 0;
  await processNextGeneration(db, createOpenAICompatibleProvider(providerEnv, async () => {
    calls++;
    return new Response();
  }));
  assert.equal(calls, 0);
  assert.equal(call<Generation>('generations.get', { generationId }).error?.code, 'generation_pinned_asset_unavailable');
  assert.deepEqual(inspect(generationId), before);
});
