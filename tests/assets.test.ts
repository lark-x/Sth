import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/database.ts';
import { workspaceSchemaVersion } from '../src/workspace.ts';
import { createApp } from '../src/server.ts';

test('imported audio survives a new connection, handles browser Range and deduplicates across callers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sth-assets-'));
  const db = openDatabase(directory);
  const server = createApp(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
    db.close(); await rm(directory, { recursive: true, force: true });
  });
  const post = (path: string, data: object, token?: string) => fetch(origin + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(data) });
  const invoke = (operationId: string, input: object, token?: string) => post(token ? '/api/v1/personal-operations/invoke' : '/api/web/invoke',
    { operationId, input, stepId: crypto.randomUUID() }, token);
  const bytes = Buffer.alloc(1024 * 1024);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const input = { name: '声音.wav', data: bytes.toString('base64'), contentType: 'audio/x-wav' };
  const { code } = await (await post('/api/web/connections/code', {})).json();
  const { token } = await (await post('/api/v1/personal-operations/claim', { code, clientName: 'asset test' })).json();
  const imported = await invoke('asset.import', input, token);
  assert.equal(imported.status, 200);
  const { result: asset } = await imported.json();
  assert.equal(asset.byteLength, bytes.length);
  assert.equal(asset.contentType, 'audio/wav');
  assert.deepEqual((await (await invoke('asset.import', { ...input, name: 'copy.wav' })).json()).result, asset);
  assert.deepEqual((await (await invoke('asset.list', { kind: 'audio' })).json()).result.items, [asset]);
  assert.deepEqual((await (await invoke('asset.read', { assetId: asset.assetId }, token)).json()).result, asset);
  assert.equal((await invoke('asset.import', { ...input, contentType: 'image/png' })).status, 415);
  assert.equal((await invoke('asset.import', { ...input, data: 'YW Jj====' })).status, 400);
  assert.equal((await invoke('diary.create', { text: input.data })).status, 413);
  const head = await fetch(origin + asset.href, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(head.headers.get('etag'), `"${asset.sha256}"`);
  assert.deepEqual(Buffer.from(await (await fetch(origin + asset.href)).arrayBuffer()), bytes);
  const range = await fetch(origin + asset.href, { headers: { range: 'bytes=8-11' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 8-11/${bytes.length}`);
  assert.equal(await range.text(), 'WAVE');
  assert.equal((await fetch(origin + asset.href, { headers: { range: 'bytes=-3' } })).headers.get('content-length'), '3');
  assert.equal((await fetch(origin + asset.href, { headers: { range: 'bytes=2000000-' } })).status, 416);
});

test('format 2 upgrade preserves existing domain rows across repeated opens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sth-upgrade-'));
  try {
    const v2 = new DatabaseSync(join(directory, 'sth.sqlite'));
    v2.exec(`PRAGMA application_id=0x53746831; PRAGMA user_version=2;
      CREATE TABLE library_projects(project_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
      INSERT INTO library_projects VALUES ('prior-work', '已保存的作品')`);
    v2.close();
    for (let open = 0; open < 2; open++) {
      const db = openDatabase(directory);
      try {
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, workspaceSchemaVersion);
        assert.equal(db.prepare('SELECT title FROM library_projects WHERE project_id=?').get('prior-work')?.title, '已保存的作品');
        assert.equal(db.prepare('SELECT COUNT(*) AS total FROM workspace_assets').get()?.total, 0);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { db.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
