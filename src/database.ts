import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { operationsDDL } from './core/index.ts';
import { workspaceDDL, workspaceSchemaVersion } from './workspace.ts';
import { connectionsDDL } from './connections.ts';
import { migrateDecisions } from './story/decision-schema.ts';
import { manuscriptEvidenceDDL } from './generation/evidence-contracts.ts';
import { manuscriptDDL } from './manuscripts.ts';

const applicationId = 0x53746831;
export const dataDir = () => resolve(process.env.STH_DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url)));

export function openDatabase(directory = dataDir()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'sth.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const appId = Number(db.prepare('PRAGMA application_id').get()?.application_id);
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (appId === 0 && version === 0 && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
      db.exec(operationsDDL);
      db.exec(workspaceDDL);
      db.exec(connectionsDDL);
      db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=${workspaceSchemaVersion}`);
    } else if (appId === applicationId && (version === 2 || version === 3)) {
      // The newer domains add tables. Existing revisions and receipts retain their identities.
      db.exec(workspaceDDL);
      db.exec(`PRAGMA user_version=${workspaceSchemaVersion}`);
    } else if (appId !== applicationId || version !== workspaceSchemaVersion) {
      throw new Error(`Unsupported database. Start Sth with a fresh STH_DATA_DIR or restore a v${workspaceSchemaVersion} snapshot.`);
    }
    migrateDecisions(db);
    db.exec(manuscriptEvidenceDDL);
    db.exec(manuscriptDDL);
    db.exec('COMMIT; PRAGMA journal_mode=WAL');
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}
