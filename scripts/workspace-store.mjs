import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const applicationId = 0x53747731;

export class WorkspaceError extends Error {
  constructor(code, message, hint, details) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export function validateName(value, label = 'workspace') {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(value)) {
    throw new WorkspaceError('invalid_name', `${label} 名称需为 1–64 位字母、数字、点、下划线或连字符。`);
  }
  return value;
}

export function validatePort(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) > 65535) {
    throw new WorkspaceError('invalid_port', '端口需为 0–65535 的整数。', '使用 --port 0 自动分配空闲端口。');
  }
  return Number(value);
}

export function workspaceHome(home = process.env.STH_WORKSPACE_HOME || join(homedir(), '.sth')) {
  const directory = resolve(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return realpathSync(directory);
}

export function withRegistry(home, action) {
  const directory = workspaceHome(home);
  const db = new DatabaseSync(join(directory, 'registry.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const id = Number(db.prepare('PRAGMA application_id').get().application_id);
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (id === 0 && version === 0 && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
      db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('local', 'connected')),
          data_dir TEXT, origin TEXT, port INTEGER NOT NULL DEFAULT 0,
          runtime TEXT, last_error TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE hosts (
          name TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id)
        );
        CREATE TABLE attempts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          state TEXT NOT NULL, error TEXT
        );
        PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
      `);
    } else if (id !== applicationId || version !== 1) {
      throw new WorkspaceError('invalid_registry', '该目录中的 registry.sqlite 不是支持的 Sth 工作区登记库。', '用 --home 指定独立的工作区根目录。');
    }
    const result = action(db, directory);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

function decode(row, db) {
  if (!row) return undefined;
  return {
    id: row.id, name: row.name, kind: row.kind, dataDir: row.data_dir,
    origin: row.origin, port: row.port, createdAt: row.created_at,
    runtime: row.runtime ? JSON.parse(row.runtime) : null,
    lastError: row.last_error ? JSON.parse(row.last_error) : null,
    hosts: db.prepare('SELECT name FROM hosts WHERE workspace_id=? ORDER BY name').all(row.id).map(host => host.name),
  };
}

export function readWorkspace(options = {}) {
  return withRegistry(options.home, db => {
    const host = validateName(options.host ?? 'default', 'host');
    if (options.workspace) validateName(options.workspace);
    const row = options.id
      ? db.prepare('SELECT * FROM workspaces WHERE id=?').get(options.id)
      : options.workspace
        ? db.prepare('SELECT * FROM workspaces WHERE name=?').get(options.workspace)
        : db.prepare('SELECT w.* FROM workspaces w JOIN hosts h ON h.workspace_id=w.id WHERE h.name=?').get(host);
    if (!row) throw new WorkspaceError('workspace_not_found', '找不到指定工作区或宿主尚未绑定工作区。', '先运行 create <名称> 或 connect <URI>，可用 --host 指定宿主。');
    return decode(row, db);
  });
}

export function listWorkspaces(options = {}) {
  return withRegistry(options.home, db => db.prepare('SELECT * FROM workspaces ORDER BY name').all().map(row => decode(row, db)));
}

export function registerLocal(options) {
  const name = validateName(options.workspace ?? 'default');
  validateName(options.host ?? 'default', 'host');
  return withRegistry(options.home, (db, home) => {
    const existing = decode(db.prepare('SELECT * FROM workspaces WHERE name=?').get(name), db);
    if (existing) {
      if (existing.kind !== 'local') throw new WorkspaceError('workspace_exists', '此名称已用于连接已有 Sth。', '使用另一个工作区名称。');
      return existing;
    }
    const id = randomUUID();
    const directory = join(home, 'workspaces', id, 'data');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    db.prepare('INSERT INTO workspaces (id,name,kind,data_dir,created_at) VALUES (?,?,?,?,?)')
      .run(id, name, 'local', directory, new Date().toISOString());
    return decode(db.prepare('SELECT * FROM workspaces WHERE id=?').get(id), db);
  });
}

export function registerConnection(origin, options) {
  const name = validateName(options.workspace ?? 'default');
  const host = validateName(options.host ?? 'default', 'host');
  return withRegistry(options.home, db => {
    let row = db.prepare('SELECT * FROM workspaces WHERE name=?').get(name);
    if (row && (row.kind !== 'connected' || row.origin !== origin)) {
      throw new WorkspaceError('workspace_exists', '此名称已指向另一个工作区。', '用 --workspace 选择新的名称，已有登记会保留。');
    }
    if (!row) {
      const id = randomUUID();
      db.prepare('INSERT INTO workspaces (id,name,kind,origin,created_at) VALUES (?,?,?,?,?)')
        .run(id, name, 'connected', origin, new Date().toISOString());
      row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
    }
    db.prepare('INSERT INTO hosts (name,workspace_id) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET workspace_id=excluded.workspace_id').run(host, row.id);
    return decode(row, db);
  });
}

export function bindHost(options = {}) {
  const workspace = readWorkspace(options);
  const host = validateName(options.host ?? 'default', 'host');
  withRegistry(options.home, db => {
    db.prepare('INSERT INTO hosts (name,workspace_id) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET workspace_id=excluded.workspace_id').run(host, workspace.id);
  });
  return readWorkspace({ ...options, id: workspace.id });
}

export function updateRuntime(home, id, runtime) {
  withRegistry(home, db => {
    if (runtime.phase === 'running') {
      db.prepare('UPDATE workspaces SET runtime=?,origin=?,port=?,last_error=NULL WHERE id=?')
        .run(JSON.stringify(runtime), runtime.origin, new URL(runtime.origin).port, id);
    } else {
      db.prepare('UPDATE workspaces SET runtime=? WHERE id=?').run(JSON.stringify(runtime), id);
    }
  });
}

export function clearRuntime(home, id, generation, failure = null) {
  withRegistry(home, db => {
    const row = db.prepare('SELECT runtime FROM workspaces WHERE id=?').get(id);
    if (row?.runtime && JSON.parse(row.runtime).generation === generation) {
      db.prepare('UPDATE workspaces SET runtime=NULL,last_error=? WHERE id=?').run(failure ? JSON.stringify(failure) : null, id);
    }
  });
}

export function setAttempt(home, id, state, error = null) {
  withRegistry(home, db => db.prepare('UPDATE attempts SET state=?,error=? WHERE id=?').run(state, error ? JSON.stringify(error) : null, id));
}

export function errorDetails(error) {
  if (error instanceof WorkspaceError) return { code: error.code, message: error.message, hint: error.hint, details: error.details };
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return { code: 'permission_denied', message: '无法访问工作区目录或启动进程。', hint: '确认当前用户拥有 --home 目录的读写权限，并检查安全软件是否阻止 Node。' };
  }
  if (error?.code === 'ENOSPC') return { code: 'disk_full', message: '工作区所在磁盘空间不足。', hint: '释放该磁盘空间后重试，已有数据会保留。' };
  return { code: 'workspace_failed', message: '工作区操作失败。', hint: '运行 doctor，查看工作区目录中的 service.log。', details: { systemCode: error?.code ?? 'unknown' } };
}
