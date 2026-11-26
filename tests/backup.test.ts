import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/database.ts';
import { Operations } from '../src/core/index.ts';
import { libraryOperations } from '../src/library/index.ts';
import { authenticate, claim, issueCode } from '../src/connections.ts';

test('backup snapshots the open database, restores content and connections, and refuses to overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sth-backup-test-'));
  const live = join(root, 'live');
  const restore = join(root, 'restored');
  const db = openDatabase(live);
  try {
    await mkdir(restore);
    const { token } = claim(db, { code: issueCode(db).code, clientName: 'Test' });
    const ops = new Operations(db, libraryOperations);
    const query = { operationId: 'diary.create', stepId: 'original', input: { title: '备份', body: '写入 WAL 的正文', diaryDate: '2026-11-23' } };
    const scope = authenticate(db, 'Bearer ' + token);
    const saved = ops.invoke(scope, query);
    db.exec('CREATE TABLE backup_payload AS SELECT randomblob(1500000) AS content');
    const original = db.prepare('SELECT content FROM backup_payload').get()!.content;
    const roundTrip = () => promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../scripts/backup.ts', import.meta.url)), join(restore, 'sth.sqlite')],
      { env: { ...process.env, STH_DATA_DIR: live }, windowsHide: true });
    await roundTrip();
    await assert.rejects(roundTrip(), /EEXIST/);
    const restored = openDatabase(restore);
    try {
      const result = new Operations(restored, libraryOperations).invoke(authenticate(restored, 'Bearer ' + token), query);
      assert.deepEqual(result, { ...saved, replayed: true });
      assert.deepEqual(restored.prepare('SELECT content FROM backup_payload').get()!.content, original);
    } finally { restored.close(); }
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
