import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { backup, DatabaseSync } from 'node:sqlite';
import { dataDir } from '../src/database.ts';

const target = process.argv[2];
if (!target) throw new Error('Usage: npm run backup -- <new-backup-file>');
const source = join(dataDir(), 'sth.sqlite');
await access(source);
const db = new DatabaseSync(source, { readOnly: true });
const directory = await mkdtemp(join(tmpdir(), 'sth-backup-'));
const snapshot = join(directory, 'snapshot.sqlite');
try {
  // Finish in one SQLite backup step on a separate read connection. Node 24.15 can
  // report SQLITE_OK as an error between page batches on larger WAL databases.
  await backup(db, snapshot, { rate: -1 });
  const check = new DatabaseSync(snapshot, { readOnly: true });
  try {
    if (check.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Snapshot integrity check failed');
  } finally { check.close(); }
  await copyFile(snapshot, resolve(target), constants.COPYFILE_EXCL);
  console.log(resolve(target));
} finally {
  db.close();
  await rm(directory, { force: true, recursive: true });
}
