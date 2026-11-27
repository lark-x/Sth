import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  WorkspaceError, bindHost as storeBindHost, clearRuntime, listWorkspaces, readWorkspace,
  registerConnection, registerLocal, validateName, validatePort, withRegistry, workspaceHome,
} from './workspace-store.mjs';

const daemonPath = fileURLToPath(new URL('./workspace-daemon.mjs', import.meta.url));
const installationPath = fileURLToPath(new URL('../', import.meta.url));
const controlPath = '/.well-known/sth-workspace';

export { WorkspaceError };

export function bindHost(options = {}) {
  return publicWorkspace(storeBindHost(options));
}

export function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new WorkspaceError('invalid_uri', '需要完整的 Sth HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new WorkspaceError('invalid_uri', '请输入不含凭据、路径、查询或片段的 Sth 服务地址。');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new WorkspaceError('https_required', '非回环地址需要 HTTPS。', '本机使用 http://127.0.0.1:<端口>，远程使用已配置的 HTTPS 入口。');
  }
  return url.origin;
}

async function requestJson(url, options = {}, timeout = 1500) {
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal });
    // Diagnostics must not buffer an arbitrary server response indefinitely.
    const reader = response.body?.getReader();
    const parts = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) {
            await reader.cancel();
            return { ok: false, status: response.status, code: 'invalid_response' };
          }
          parts.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    let value;
    try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { value = null; }
    return { ok: response.ok, status: response.status, value };
  } catch (error) {
    return { ok: false, status: 0, code: signal.aborted ? 'timeout' : 'unreachable' };
  }
}

export async function checkHealth(origin, timeout) {
  const response = await requestJson(origin + '/api/health', {}, timeout);
  const value = response.value;
  const healthy = response.ok && value?.name === 'Sth' && value?.status === 'ok' && Number.isInteger(value?.schemaVersion) && value.schemaVersion > 0;
  return {
    healthy,
    code: healthy ? 'ok' : response.status === 0 ? response.code : 'not_sth',
    httpStatus: response.status,
    ...(healthy ? { schemaVersion: value.schemaVersion } : {}),
  };
}

function publicWorkspace(workspace) {
  const origin = workspace.runtime?.origin || workspace.origin;
  return {
    id: workspace.id, name: workspace.name, kind: workspace.kind,
    workspaceUri: `sth://workspace/${workspace.id}`, origin,
    dataDir: workspace.dataDir, hosts: workspace.hosts,
    ...(origin ? {
      connectionsUrl: origin + '/settings/connections',
      personalOperationsOrigin: origin,
      personalOperationsUrl: origin + '/api/v1/personal-operations',
    } : {}),
    ...(workspace.kind === 'local' ? { logPath: join(dirname(workspace.dataDir), 'service.log') } : {}),
  };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function identify(runtime, timeout = 1000) {
  if (!runtime?.origin) return false;
  const response = await requestJson(runtime.origin + controlPath, { headers: { authorization: `Bearer ${runtime.controlToken}` } }, timeout);
  return response.ok && response.value?.workspaceId === runtime.workspaceId && response.value?.generation === runtime.generation && response.value?.pid === runtime.pid;
}

async function inspect(workspace, timeout) {
  const origin = workspace.runtime?.origin || workspace.origin;
  const [health, owned] = await Promise.all([
    origin ? checkHealth(origin, timeout) : { healthy: false, code: 'not_started', httpStatus: 0 },
    workspace.kind === 'local' ? identify(workspace.runtime, timeout) : false,
  ]);
  let state = health.healthy ? 'running' : 'unreachable';
  if (workspace.kind === 'local') {
    if (!workspace.runtime || (!owned && !processExists(workspace.runtime.pid))) state = 'stopped';
    else if (owned && workspace.runtime.phase !== 'running') state = workspace.runtime.phase;
    else if (!owned) state = 'unverified';
  }
  return {
    ...publicWorkspace(workspace), state, healthy: health.healthy, owned, health,
    ...(owned ? { pid: workspace.runtime.pid, startedAt: workspace.runtime.startedAt, installationPath: workspace.runtime.installationPath } : {}),
    ...(workspace.lastError ? { lastError: workspace.lastError } : {}),
  };
}

export async function workspaceStatus(options = {}) {
  return inspect(readWorkspace(options), options.timeout);
}

export function workspaceList(options = {}) {
  return { workspaces: listWorkspaces(options).map(publicWorkspace) };
}

export async function connectWorkspace(origin, options = {}) {
  const normalized = normalizeOrigin(origin);
  // Validate names before any network request and preserve bindings on failure.
  validateName(options.workspace ?? 'default');
  validateName(options.host ?? 'default', 'host');
  const health = await checkHealth(normalized, options.timeout);
  if (!health.healthy) throw new WorkspaceError('connection_failed', '目标未返回可用的 Sth 健康信息。', '确认 URI、服务状态及 /api/health，随后重试。', health);
  return inspect(registerConnection(normalized, options), options.timeout);
}

export async function createWorkspace(options = {}) {
  const port = options.port === undefined ? undefined : validatePort(options.port);
  const workspace = registerLocal(options);
  const result = await startWorkspace({ ...options, workspace: workspace.name, port });
  bindHost({ ...options, workspace: workspace.name });
  return { ...result, hosts: readWorkspace({ ...options, workspace: workspace.name }).hosts };
}

export async function startWorkspace(options = {}) {
  const workspace = readWorkspace(options);
  if (workspace.kind !== 'local') throw new WorkspaceError('external_lifecycle', '此工作区连接的是已有 Sth，由其服务管理器负责启停。', '使用 status、uri 或 doctor 检查连接。');
  const requestedPort = options.port === undefined ? workspace.port : validatePort(options.port);
  const current = await inspect(workspace, options.timeout);
  if (current.owned && current.healthy && current.state === 'running') {
    if (options.port !== undefined && requestedPort !== 0 && requestedPort !== Number(new URL(current.origin).port)) {
      throw new WorkspaceError('already_running', '工作区正在另一个端口运行。', '用 restart --port <端口> 更换入口。');
    }
    return current;
  }
  const home = workspaceHome(options.home);
  const attempt = randomUUID();
  const timeout = options.startupTimeout ?? 15000;
  const deadline = Date.now() + timeout;
  withRegistry(home, db => db.prepare('INSERT INTO attempts (id,workspace_id,state) VALUES (?,?,?)').run(attempt, workspace.id, 'pending'));
  const logPath = join(dirname(workspace.dataDir), 'service.log');
  let log;
  let spawnError;
  try {
    log = await open(logPath, 'a', 0o600);
    const launch = () => {
      const child = spawn(process.execPath, [daemonPath, home, workspace.id, String(requestedPort), attempt, String(deadline)], {
        cwd: installationPath, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      });
      child.once('error', error => { spawnError = error; });
      child.unref();
    };
    launch();
    while (Date.now() < deadline) {
      if (spawnError) throw new WorkspaceError('spawn_failed', '无法启动 Node 工作区进程。', '确认 Node 可执行文件和安装目录仍可访问。', { systemCode: spawnError.code });
      const record = readWorkspace({ home, id: workspace.id });
      const progress = withRegistry(home, db => db.prepare('SELECT state,error FROM attempts WHERE id=?').get(attempt));
      if (progress?.state === 'failed') {
        const failure = JSON.parse(progress.error);
        throw new WorkspaceError(failure.code, failure.message, failure.hint, failure.details);
      }
      if (record.runtime?.phase === 'running') {
        const status = await inspect(record, 750);
        if (status.owned && status.healthy) {
          if (options.port !== undefined && requestedPort !== 0 && requestedPort !== Number(new URL(status.origin).port)) {
            throw new WorkspaceError('already_running', '另一个启动请求已在其他端口启动此工作区。', '用 restart --port <端口> 更换入口。');
          }
          return status;
        }
      }
      if (progress?.state === 'busy' && !record.runtime) {
        // A concurrent stop can release the lease after this attempt lost its
        // first election. Retry only after that owner's runtime is cleared.
        withRegistry(home, db => db.prepare('UPDATE attempts SET state=?,error=NULL WHERE id=?').run('pending', attempt));
        launch();
      }
      await delay(75);
    }
    // A timed out attempt cannot later publish a ready service. The daemon also
    // checks this deadline after imports and before recording readiness.
    const record = readWorkspace({ home, id: workspace.id });
    if (record.runtime?.generation === attempt && await identify(record.runtime)) {
      await requestJson(record.runtime.origin + controlPath + '/stop', { method: 'POST', headers: { authorization: `Bearer ${record.runtime.controlToken}` } });
    }
    throw new WorkspaceError('startup_timeout', '工作区未在启动时限内就绪。', '用 status 和 doctor 检查实例，查看 service.log 后重试。', { logPath });
  } finally {
    await log?.close().catch(() => {});
    withRegistry(home, db => db.prepare('DELETE FROM attempts WHERE id=?').run(attempt));
  }
}

export async function stopWorkspace(options = {}) {
  const workspace = readWorkspace(options);
  if (workspace.kind !== 'local') throw new WorkspaceError('external_lifecycle', '此连接指向已有 Sth，无法通过工作区命令停止。', '在已有 Sth 的服务管理器中操作。');
  const runtime = workspace.runtime;
  if (!runtime || !processExists(runtime.pid)) {
    if (runtime) clearRuntime(options.home, workspace.id, runtime.generation);
    return { ...publicWorkspace(workspace), state: 'stopped', healthy: false, owned: false };
  }
  if (!await identify(runtime)) throw new WorkspaceError('ownership_unverified', '无法验证当前端口上的进程身份，已保留该进程。', '运行 doctor 并检查 service.log，恢复连接后重试。');
  const response = await requestJson(runtime.origin + controlPath + '/stop', { method: 'POST', headers: { authorization: `Bearer ${runtime.controlToken}` } });
  if (!response.ok) throw new WorkspaceError('stop_failed', '工作区没有接受停止请求。', '运行 doctor 检查实例状态后重试。');
  const deadline = Date.now() + (options.startupTimeout ?? 15000);
  while (Date.now() < deadline) {
    const current = readWorkspace({ ...options, id: workspace.id });
    if (!current.runtime || current.runtime.generation !== runtime.generation) {
      return { ...publicWorkspace(current), state: current.runtime?.phase ?? 'stopped', healthy: false, owned: false };
    }
    await delay(75);
  }
  throw new WorkspaceError('stop_timeout', '工作区仍在等待后台任务结束。', '稍后重试 status，停止完成前不要手动删除数据文件。');
}

export async function restartWorkspace(options = {}) {
  if (options.port !== undefined) validatePort(options.port);
  // Reuse the selected ID even when another host changes its own binding.
  const workspace = readWorkspace(options);
  await stopWorkspace({ ...options, id: workspace.id });
  return startWorkspace({ ...options, id: workspace.id });
}

export async function workspaceDoctor(options = {}) {
  const workspace = readWorkspace(options);
  const status = await inspect(workspace, options.timeout);
  const checks = [];
  const version = process.versions.node.split('.').map(Number);
  checks.push({ id: 'node', ok: version[0] > 24 || (version[0] === 24 && version[1] >= 15), version: process.versions.node, required: '>=24.15.0' });
  if (workspace.kind === 'local') {
    let writable = true;
    try { await access(workspace.dataDir, constants.R_OK | constants.W_OK); } catch { writable = false; }
    checks.push({ id: 'data_directory', ok: writable, path: workspace.dataDir });
    checks.push({ id: 'managed_service', ok: status.owned && status.state === 'running', state: status.state });
  }
  checks.push({ id: 'health', ok: status.healthy, ...status.health });
  if (status.healthy) {
    const headers = process.env.STH_WEB_PASSWORD
      ? { authorization: 'Basic ' + Buffer.from('sth:' + process.env.STH_WEB_PASSWORD).toString('base64') } : {};
    const web = await requestJson(status.origin + '/api/web/catalog?view=index', { headers }, options.timeout);
    checks.push({ id: 'web_catalog', ok: web.ok && Array.isArray(web.value?.operations), httpStatus: web.status,
      ...(web.status === 401 ? { hint: '此服务需要网页密码，设置 STH_WEB_PASSWORD 后重新检查。' } : {}) });
    const token = options.tokenEnv ? process.env[options.tokenEnv] : undefined;
    if (options.tokenEnv && !token) {
      checks.push({ id: 'personal_catalog', ok: false, code: 'token_missing', hint: `当前进程中缺少 ${options.tokenEnv}，请在本机设置该宿主的连接令牌。` });
    } else {
      const personal = await requestJson(status.origin + '/api/v1/personal-operations/catalog', {
        method: 'POST', body: JSON.stringify({ view: 'index' }),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      }, options.timeout);
      checks.push({ id: 'personal_catalog', ok: token ? personal.ok && Array.isArray(personal.value?.operations) : personal.status === 401,
        authenticated: Boolean(token && personal.ok), httpStatus: personal.status,
        ...(!token || personal.status === 401 ? { hint: `在 ${status.connectionsUrl} 配对此宿主，再用 --token-env <环境变量名> 验证令牌。` } : {}) });
    }
  }
  return { ...status, checks, passed: checks.every(check => check.ok) };
}
