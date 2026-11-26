import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/database.ts';
import { createApp, type ServerSettings } from '../src/server.ts';

async function start(directory: string, settings?: ServerSettings) {
  const db = openDatabase(directory);
  const server = createApp(db, settings);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`, db,
    async stop() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
      db.close();
    },
  };
}

const root = '/api/v1/personal-operations';
function post(origin: string, route: string, data: object, token?: string) {
  return fetch(origin + route, { method: 'POST', body: JSON.stringify(data), headers: {
    'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}),
  } });
}

test('Web and paired clients share scoped discovery and worker diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sth-discovery-'));
  const app = await start(directory);
  t.after(async () => { await app.stop(); await rm(directory, { recursive: true, force: true }); });
  const { code } = await (await post(app.origin, '/api/web/connections/code', {})).json();
  const { token } = await (await post(app.origin, root + '/claim', { code, clientName: 'contract test' })).json();
  const query = (args: object) => post(app.origin, root + '/catalog', args, token);
  const index = await (await fetch(app.origin + '/api/web/catalog?view=index')).json();
  assert.deepEqual(await (await query({ view: 'index' })).json(), index);
  assert.ok(index.resourcePaths.includes('sources') && index.resourcePaths.includes('generation-batches'));
  assert.ok(index.operations.some((op: { id: string }) => op.id === 'generation.batches.create'));
  assert.ok(index.operations.every((op: object) => !('inputSchema' in op)));
  const exact = await (await query({ operationId: 'scene.adopt' })).json();
  assert.deepEqual(exact.operations.map((op: { id: string }) => op.id), ['scene.adopt']);
  assert.ok(exact.operations[0].inputSchema.required.includes('draftRevision'));
  const filtered = await (await query({ prefix: 'generation.plans' })).json();
  assert.ok(filtered.operations.length && filtered.operations.every((op: { id: string }) => op.id.startsWith('generation.plans.')));
  assert.equal((await query({ prefix: 'scene', operationId: 'scene.read' })).status, 400);
  assert.equal((await query({ operationId: 'missing.read' })).status, 404);
  assert.equal((await post(app.origin, root + '/providers/media', {})).status, 401);
  const web = await (await fetch(app.origin + '/api/web/providers/media')).json();
  assert.equal(web.status, 'unconfigured');
  assert.deepEqual(await (await post(app.origin, root + '/providers/media', {}, token)).json(), web);
});

test('zero-project pairing survives restart, works across resources and revokes immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sth-service-'));
  let app = await start(dir);
  try {
    const issue = async () => (await post(app.origin, '/api/web/connections/code', {})).json();
    const old = await issue();
    const fresh = await issue();
    assert.equal((await post(app.origin, root + '/claim', { code: old.code, clientName: 'obsolete' })).status, 403);
    const claims = await Promise.all([1, 2].map(() => post(app.origin, root + '/claim', { code: fresh.code, clientName: 'Hermes test' })));
    assert.deepEqual(claims.map(res => res.status).sort(), [200, 403]);
    const { connectionId, token } = await claims.find(res => res.ok)!.json();
    const invoke = async (id: string, input: object, adapter?: string, stepId = String(crypto.randomUUID())) => {
      const response = await post(app.origin, adapter ? root + '/invoke' : '/api/web/invoke', { operationId: id, stepId, input }, adapter);
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value.result;
    };
    assert.deepEqual((await invoke('project.list', {}, token)).items, []);
    const initial = { title: '独立日记', body: '今天的想法', diaryDate: '2026-11-23' };
    const saved = await invoke('diary.create', initial, token, 'day-one');
    await app.stop();
    app = await start(dir);
    assert.equal((await invoke('diary.create', initial, token, 'day-one')).noteId, saved.noteId);
    assert.equal((await invoke('diary.list', {})).items.length, 1);
    const revised = await invoke('diary.revise', { ...initial, noteId: saved.noteId, expectedRevision: 1, body: '网页已改稿' });
    assert.deepEqual(await invoke('diary.read', { noteId: saved.noteId }, token), revised);
    const { projectId } = await invoke('project.create', { title: '第一部作品' });
    const character = await invoke('character.create', { projectId, name: '洛汐', persona: '第一人称' });
    const roleDiary = await invoke('diary.create', { ...initial, projectId, characterId: character.characterId, expectedCharacterRevision: character.revision }, token);
    assert.equal(roleDiary.projectId, projectId);
    assert.equal(roleDiary.character.revision, 1);
    assert.equal((await post(app.origin, `/api/web/connections/${connectionId}/revoke`, {})).status, 200);
    for (const route of ['catalog', 'invoke', 'receipt']) assert.equal((await post(app.origin, `${root}/${route}`, {}, token)).status, 401);
    assert.equal((await invoke('diary.read', { noteId: saved.noteId })).body, '网页已改稿');
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('web owner endpoints reject foreign hosts, cross-origin writes and simple form posts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sth-headers-'));
  const app = await start(dir, { publicOrigin: 'https://example.test', webPassword: 'fixture' });
  try {
    const url = app.origin + '/api/web/connections/code';
    const options = { method: 'POST', body: '{}' };
    assert.equal((await fetch(url, { ...options, headers: { 'content-type': 'application/json', origin: 'https://elsewhere.test' } })).status, 403);
    const owner = 'Basic ' + Buffer.from('sth:fixture').toString('base64');
    assert.equal((await fetch(url, options)).status, 401);
    assert.equal((await fetch(url, { ...options, headers: { authorization: owner } })).status, 415);
    // Core HTTP client permits explicit Host during local reverse-proxy simulation.
    const { request } = await import('node:http');
    const getAs = (host: string, authorization?: string) => new Promise<number>((resolve, reject) => {
      request(app.origin + '/api/web/catalog', { headers: { host, ...(authorization ? { authorization } : {}) } }, res => {
        res.resume(); resolve(res.statusCode!);
      }).on('error', reject).end();
    });
    assert.equal(await getAs('unlisted.test'), 403);
    assert.equal(await getAs('example.test'), 401);
    assert.equal(await getAs('example.test', owner), 200);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
