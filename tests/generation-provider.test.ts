import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createOpenAICompatibleProvider, type GenerationProviderRequest } from '../src/generation/index.ts';

const request: GenerationProviderRequest = {
  requestId: 'delegation-1', messages: [{ role: 'user', content: 'Write a draft.' }],
  plan: { planId: 'named-plan', title: 'Alternate', revision: 1, href: '/generation-plans/named-plan?revision=1',
    executor: 'openai-compatible', provider: 'local', model: 'request-model', parameters: { temperature: 0, topP: 0.8, maxOutputTokens: 128 } },
};

test('OpenAI-compatible adapter sends one real HTTP request and reads provider-reported metadata', async t => {
  const received: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, method: req.method, key: req.headers['idempotency-key'], auth: req.headers.authorization,
      contentType: req.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'completion-123', model: 'actual-model', choices: [{ message: { content: '{"events":"Ferry"}' }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/v1/`;
  const provider = createOpenAICompatibleProvider({
    STH_GENERATION_PROVIDERS_JSON: JSON.stringify({ local: { baseUrl, apiKeyEnv: 'SYNTHETIC_TEXT_KEY' } }),
    SYNTHETIC_TEXT_KEY: 'synthetic-fixture',
  });
  const prepared = provider.prepare(request);
  assert.equal(prepared.endpoint, `${baseUrl}chat/completions`);
  assert.deepEqual(await prepared.execute(AbortSignal.timeout(5000)), {
    content: '{"events":"Ferry"}', reportedModel: 'actual-model', responseId: 'completion-123', finishReason: 'stop',
  });
  assert.deepEqual(received, [{ url: '/v1/chat/completions', method: 'POST', key: request.requestId, auth: 'Bearer synthetic-fixture',
    contentType: 'application/json', body: { model: 'request-model', messages: request.messages, stream: false, n: 1,
      temperature: 0, top_p: 0.8, max_tokens: 128 } }]);
});

test('missing config, HTTP failures and omitted metadata are reported without substituting model claims', async () => {
  const baseUrl = 'http://127.0.0.1:1/v1';
  const configured = (apiKeyEnv?: string) => ({ STH_GENERATION_PROVIDERS_JSON: JSON.stringify({ local: { baseUrl, apiKeyEnv } }) });
  assert.throws(() => createOpenAICompatibleProvider({}).prepare(request), { state: 'failed', code: 'generation_provider_not_configured' });
  assert.throws(() => createOpenAICompatibleProvider({ STH_GENERATION_PROVIDERS_JSON: ' ' }).prepare(request),
    { state: 'failed', code: 'generation_provider_not_configured' });
  assert.throws(() => createOpenAICompatibleProvider(configured('MISSING')).prepare(request), { state: 'failed', code: 'generation_provider_key_missing' });
  assert.throws(() => createOpenAICompatibleProvider({ STH_GENERATION_PROVIDERS_JSON: '{' }), /must contain valid JSON/);

  const signal = AbortSignal.timeout(5000);
  for (const [status, state] of [[401, 'failed'], [408, 'uncertain'], [502, 'uncertain']] as const) {
    const provider = createOpenAICompatibleProvider(configured(), async () => new Response('synthetic provider error', { status }));
    await assert.rejects(provider.prepare(request).execute(signal), { state, message: `Text provider returned HTTP ${status}.` });
  }
  const provider = createOpenAICompatibleProvider(configured(), async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { model: request.plan.model, messages: request.messages, stream: false, n: 1 });
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json({ choices: [{ message: { content: '{}' } }] });
  });
  const result = await provider.prepare({ ...request, plan: { ...request.plan, parameters: {} } }).execute(signal);
  assert.deepEqual(result, { content: '{}', reportedModel: null, responseId: null, finishReason: null });
});

test('structured response modes are opt-in and strict schema follows pinned template fields', async () => {
  const calls: Record<string, unknown>[] = [];
  const provider = createOpenAICompatibleProvider({ STH_GENERATION_PROVIDERS_JSON: '{"local":{"baseUrl":"http://localhost/v1"}}' },
    async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: '{"shots":[{"number":1,"sound":null}]}' } }] });
    });
  const signal = AbortSignal.timeout(5000);
  const plan = { ...request.plan, parameters: { responseFormat: 'json-schema' as const } };
  assert.throws(() => provider.prepare({ ...request, plan }), { code: 'generation_provider_schema_missing' });
  await provider.prepare({ ...request, plan, templateFields: [
    { type: 'sections', key: 'shots', label: 'Shots', fields: [
      { type: 'integer', key: 'number', label: 'Number', minimum: 1 },
      { type: 'text', key: 'sound', label: 'Sound', required: false },
    ] },
  ] }).execute(signal);
  assert.deepEqual(calls[0].response_format, { type: 'json_schema', json_schema: { name: 'sth_generation', strict: true, schema: {
    type: 'object', additionalProperties: false, required: ['shots'], properties: { shots: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['number', 'sound'],
      properties: { number: { type: 'integer' }, sound: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    } } },
  } } });
  await provider.prepare({ ...request, plan: { ...plan, parameters: { responseFormat: 'json-object' } } }).execute(signal);
  assert.deepEqual(calls[1].response_format, { type: 'json_object' });
});
