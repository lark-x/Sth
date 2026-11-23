import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from './core/index.ts';

export const connectionsDDL = `
  CREATE TABLE connection_code (slot INTEGER PRIMARY KEY CHECK (slot = 1), digest TEXT NOT NULL, expires_at TEXT NOT NULL) STRICT;
  CREATE TABLE connections (id TEXT PRIMARY KEY, client_name TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, revoked_at TEXT) STRICT;
`;

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function issueCode(db: DatabaseSync) {
  const code = randomBytes(16).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare(`INSERT INTO connection_code VALUES (1,?,?) ON CONFLICT(slot)
    DO UPDATE SET digest=excluded.digest, expires_at=excluded.expires_at`).run(digest(code), expiresAt);
  return { code, expiresAt };
}

export function claim(db: DatabaseSync, input: Record<string, unknown>) {
  const { code, clientName } = input;
  if (Object.keys(input).length !== 2 || typeof code !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(code)
      || typeof clientName !== 'string' || !clientName.trim() || clientName.length > 120 || /[\x00-\x1f\x7f]/.test(clientName)) {
    throw new OperationError(400, 'invalid_claim', '请输入有效的连接码和客户端名称。');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date().toISOString();
    const claimed = db.prepare('DELETE FROM connection_code WHERE slot=1 AND digest=? AND expires_at>?').run(digest(code), now);
    if (!claimed.changes) throw new OperationError(403, 'invalid_code', '连接码已使用、已到期或无效。请重新生成。');
    const connectionId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO connections(id,client_name,digest,created_at) VALUES (?,?,?,?)').run(connectionId, clientName.trim(), digest(token), now);
    db.exec('COMMIT');
    return { connectionId, token };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function authenticate(db: DatabaseSync, authorization?: string) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')?.[1];
  const row = token && db.prepare('SELECT id FROM connections WHERE digest=? AND revoked_at IS NULL').get(digest(token));
  if (!row) throw new OperationError(401, 'invalid_connection', '请先配对助手，或重新连接已撤销的助手。');
  return `connection:${row.id}`;
}

export function listConnections(db: DatabaseSync) {
  return { items: db.prepare(`SELECT id AS connectionId, client_name AS clientName, created_at AS createdAt,
    revoked_at AS revokedAt FROM connections ORDER BY created_at DESC, id`).all() };
}

export function revoke(db: DatabaseSync, id: string) {
  const updated = db.prepare('UPDATE connections SET revoked_at=coalesce(revoked_at,?) WHERE id=?').run(new Date().toISOString(), id);
  if (!updated.changes) throw new OperationError(404, 'unknown_connection', '找不到此连接。');
  return { connectionId: id, revoked: true };
}
