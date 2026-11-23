import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/database.ts';
import { createApp } from '../../src/server.ts';

const tests = fileURLToPath(new URL('./', import.meta.url));

async function scratch() {
  const parent = await realpath(tests);
  const directory = await mkdtemp(join(parent, '.scratch-'));
  async function close() {
    assert.equal(await realpath(directory), directory);
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  return { directory, close };
}

export async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

export async function setupService(t) {
  const { directory, close } = await scratch();
  const db = openDatabase(join(directory, 'db'));
  const calls = [];
  const app = createApp(db);
  app.prependListener('request', (req, res) => {
    const root = '/api/v1/personal-operations/';
    if (!req.url.startsWith(root)) return;
    res.on('finish', () => calls.push({ action: req.url.slice(root.length), method: req.method,
      bearer: /^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? ''), status: res.statusCode }));
  });
  app.on('close', () => db.close());
  const origin = await listen(t, app);
  t.after(close);

  async function web(path, input) {
    const response = await fetch(`${origin}/api/web/${path}`, input === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, `Sth Web ${path} failed`);
    return response.json();
  }

  return {
    origin, directory, calls,
    code: async () => (await web('connections/code', {})).code,
    connections: async () => (await web('connections')).items,
    revoke: id => web(`connections/${id}/revoke`, {}),
    invoke: async (operationId, stepId, input) => (await web('invoke', { operationId, stepId, input })).result,
    diaryCount: () => db.prepare('SELECT count(*) AS n FROM library_diaries').get().n,
  };
}
