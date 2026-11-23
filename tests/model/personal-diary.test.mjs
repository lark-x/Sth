import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { request as personalRequest } from '../../adapters/mcp/http.mjs';
import { openBrowser, startService } from '../browser/harness.mjs';

const magpie = 'http://127.0.0.1:3425/v1';
const model = 'codex/gpt-6.2-sol';
const tools = [
  { type: 'function', function: {
    name: 'sth_personal_discover',
    description: 'Discover the registered Sth operations and their input schemas.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  } },
  { type: 'function', function: {
    name: 'sth_personal_invoke',
    description: 'Call an operation using its discovered ID and input schema.',
    parameters: {
      type: 'object',
      properties: { operationId: { type: 'string' }, input: { type: 'object' } },
      required: ['operationId', 'input'],
      additionalProperties: false,
    },
  } },
];

async function request(url, label, { body, token, timeout = 5_000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    headers, redirect: 'error', signal: AbortSignal.timeout(timeout),
    method: body === undefined ? 'GET' : 'POST', body: JSON.stringify(body),
  }).catch(error => { throw new Error(`${label} connection failed (${error.name})`); });
  assert.equal(response.status, 200, `${label} returned HTTP ${response.status}`);
  return response.json();
}

// Opt in with STH_TEST_MAGPIE=1. This HTTP tool shim uses no Hermes profile.
test('configured Magpie discovers and saves one standalone diary for Web readback', {
  skip: process.env.STH_TEST_MAGPIE !== '1' && 'Set STH_TEST_MAGPIE=1 to use local Magpie',
  timeout: 150_000,
}, async t => {
  const modelToken = process.env.MAGPIE_LOCAL_API_KEY || 'local';
  const { data } = await request(`${magpie}/models`, 'Magpie catalog', { token: modelToken });
  assert.ok(data.some(item => item.id === model && item.owned_by === 'codex' && item.tool_call),
    `Magpie must advertise the configured ${model} tool route`);
  t.diagnostic(`Magpie catalog advertised ${model}`);

  const origin = await startService(t);
  const page = await openBrowser(t, origin, { width: 1000, height: 800 });
  const web = (path, body) => request(`${origin}/api/web/${path}`, `Web ${path}`, { body });
  const webInvoke = async (operationId, input) => (await web('invoke', {
    operationId, input, stepId: `model-web:${randomUUID()}`,
  })).result;
  const { code } = await web('connections/code', {});
  const { status, value } = await personalRequest(origin, 'claim', { code, clientName: 'Magpie model acceptance' });
  assert.equal(status, 200, 'isolated personal connection claim');
  const token = value.token;
  assert.ok(typeof token === 'string' && token.length > 0, 'temporary connection bearer issued');
  assert.deepEqual((await webInvoke('project.list', {})).items, []);
  assert.deepEqual((await webInvoke('diary.list', { limit: 2 })).items, []);
  t.diagnostic('Fresh Sth service paired with zero projects and zero diaries');

  const diaryDate = '2026-11-23';
  const title = 'The Quiet Bench';
  const messages = [{ role: 'user', content:
    `Discover the available Sth operations, then save exactly one personal diary for ${diaryDate} titled "${title}". ` +
    'Write two short first-person sentences about sitting in a quiet park after rain. The workspace has zero projects. ' +
    'Leave the diary unassigned, with no project or character. Confirm after the save tool reports success.',
  }];
  let catalog;
  let saved;
  let writes = 0;
  let confirmed = false;
  for (let turn = 1; turn <= 5; turn++) {
    const completion = await request(`${magpie}/chat/completions`, `Magpie turn ${turn}`, {
      token: modelToken, timeout: 30_000,
      body: { model, messages, tools, reasoning_effort: 'low', max_completion_tokens: 1400, store: false },
    });
    const message = completion.choices?.[0]?.message;
    assert.ok(message, `Magpie turn ${turn} returned an assistant message`);
    if (!message.tool_calls?.length) {
      assert.ok(saved && message.content?.trim(), 'model confirmed after a successful save');
      confirmed = true;
      break;
    }
    messages.push({ role: 'assistant', content: message.content, tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      const { name, arguments: raw } = call.function;
      const args = JSON.parse(raw);
      let result;
      if (name === 'sth_personal_discover') {
        assert.deepEqual(args, {});
        const response = await personalRequest(origin, 'catalog', {}, token);
        assert.equal(response.status, 200, 'authenticated catalog lookup');
        catalog = response.value.operations;
        assert.ok(catalog.some(operation => operation.id === 'diary.create'));
        result = { operations: catalog };
        t.diagnostic(`Model discovered ${catalog.length} registered operations`);
      } else {
        assert.equal(name, 'sth_personal_invoke');
        const operation = catalog?.find(entry => entry.id === args.operationId);
        assert.ok(operation, 'model invoked an operation from the authenticated catalog');
        if (operation.effect === 'write') {
          assert.equal(operation.id, 'diary.create');
          assert.equal(++writes, 1, 'model requested exactly one write');
          assert.equal(args.input.title, title);
          assert.equal(args.input.diaryDate, diaryDate);
          assert.equal(args.input.projectId, undefined);
          assert.equal(args.input.characterId, undefined);
        }
        const response = await personalRequest(origin, 'invoke', {
          operationId: operation.id, stepId: `model:${randomUUID()}`, input: args.input,
        }, token);
        assert.equal(response.status, 200, `${operation.id} invocation`);
        assert.equal(response.value.replayed, false);
        result = response.value;
        if (operation.id === 'diary.create') saved = result.result;
        t.diagnostic(`Model invoked ${operation.id} and received HTTP 200`);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  assert.equal(confirmed, true, 'model completed the tool loop within five turns');
  assert.equal(writes, 1);
  assert.ok(saved.body.trim());
  assert.equal(saved.projectId, undefined);
  assert.equal(saved.characterId, undefined);
  assert.equal(saved.href, `/diaries/${saved.noteId}`);
  assert.deepEqual((await webInvoke('project.list', {})).items, []);
  assert.deepEqual((await webInvoke('diary.list', { limit: 2 })).items, [saved]);
  assert.deepEqual(await webInvoke('diary.read', { noteId: saved.noteId }), saved);
  t.diagnostic('Web list and detail returned the same single diary with zero projects');

  await page.goto('/');
  const entry = page.locator(`a[href="${saved.href}"]`);
  await entry.waitFor();
  assert.equal(await entry.count(), 1);
  await entry.click();
  await page.getByRole('heading', { level: 1, name: saved.title, exact: true }).waitFor();
  await page.getByRole('article').getByText(saved.body, { exact: true }).waitFor();
  assert.equal(await page.getByRole('main').locator('time').getAttribute('datetime'), diaryDate);
  t.diagnostic('Chromium opened the diary from the Web list and rendered its title, date, and body');
});
