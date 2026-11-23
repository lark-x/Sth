import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const personal = '/api/v1/personal-operations';

async function post(origin, path, body, { token, status = 200, code } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${origin}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  const result = await response.json();
  assert.equal(response.status, status, `POST ${path} returned ${response.status} (${result.code ?? 'no error code'})`);
  if (code) assert.equal(result.code, code, `POST ${path} error code`);
  return result;
}

export const clientName = 'Browser acceptance';

export async function pairPersonalClient(origin, code) {
  code ??= (await post(origin, '/api/web/connections/code', {})).code;
  assert.match(code, /^[A-Za-z0-9_-]{22}$/, 'owner API issued a pairing code');
  const { token } = await post(origin, `${personal}/claim`, { code, clientName });
  assert.ok(typeof token === 'string' && token.length > 0, 'claim issued a bearer token');
  return {
    catalog: (expected) => post(origin, `${personal}/catalog`, {}, { token, ...expected }),
    async invoke(operationId, input, expected) {
      const stepId = `browser:${randomUUID()}`;
      const response = await post(origin, `${personal}/invoke`, { operationId, stepId, input }, { token, ...expected });
      if (expected?.code) return;
      assert.equal(response.operationId, operationId);
      assert.equal(response.stepId, stepId);
      assert.equal(response.replayed, false);
      return response.result;
    },
  };
}
