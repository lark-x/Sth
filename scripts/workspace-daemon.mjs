import { timingSafeEqual, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  WorkspaceError, clearRuntime, errorDetails, readWorkspace, setAttempt, updateRuntime,
} from './workspace-store.mjs';

const [home, id, requestedPort, attempt, deadlineText] = process.argv.slice(2);
const deadline = Number(deadlineText);
const workspace = readWorkspace({ home, id });
let lease;
let ownsLease = false;
let server;
let app;
let db;
let workers = [];
let closing;
const runtime = {
  workspaceId: id, generation: attempt, pid: process.pid, phase: 'starting',
  origin: null, controlToken: randomBytes(32).toString('hex'),
  startedAt: new Date().toISOString(), installationPath: fileURLToPath(new URL('../', import.meta.url)),
};

async function shutdown(failure = null) {
  if (closing) return closing;
  closing = (async () => {
    if (ownsLease) {
      runtime.phase = 'stopping';
      try { updateRuntime(home, id, runtime); }
      catch (error) {
        failure ??= errorDetails(error);
        console.error(JSON.stringify({ error: failure }));
      }
    }
    try {
      if (server?.listening) {
        await new Promise(resolve => {
          server.close(resolve);
          server.closeIdleConnections();
        });
      }
      await Promise.allSettled(workers.map(worker => worker.stop()));
      db?.close();
    } finally {
      try { if (ownsLease) clearRuntime(home, id, attempt, failure); }
      finally { lease?.close(); }
    }
  })();
  return closing;
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function controlAuthorized(request) {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + runtime.controlToken);
  const trustedHost = request.headers.host === new URL(runtime.origin).host;
  return trustedHost && !request.headers.origin && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

try {
  lease = new DatabaseSync(join(dirname(workspace.dataDir), 'lifecycle.sqlite'));
  // SQLite's OS-level write lock is released by the OS after a crash. No PID
  // signalling or stale lock-file deletion is needed for daemon election.
  try { lease.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch (error) {
    if (!/locked|busy/i.test(error.message)) throw error;
    throw new WorkspaceError('workspace_busy', '另一个进程正在管理此工作区。');
  }
  ownsLease = true;
  updateRuntime(home, id, runtime);
  server = createServer((request, response) => {
    if (request.url === '/.well-known/sth-workspace' || request.url === '/.well-known/sth-workspace/stop') {
      if (!controlAuthorized(request)) return json(response, 403, { code: 'forbidden' });
      if (request.url.endsWith('/stop') && request.method === 'POST') {
        json(response, 202, { stopping: true });
        setImmediate(() => shutdown().catch(() => { process.exitCode = 1; }));
        return;
      }
      if (request.url === '/.well-known/sth-workspace' && request.method === 'GET') {
        return json(response, 200, { workspaceId: id, generation: attempt, pid: process.pid, phase: runtime.phase });
      }
      return json(response, 405, { code: 'method' });
    }
    if (!app || runtime.phase !== 'running') return json(response, 503, { code: 'workspace_starting' });
    app.emit('request', request, response);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(requestedPort), '127.0.0.1', resolve);
  }).catch(error => {
    if (error.code === 'EADDRINUSE') throw new WorkspaceError('port_in_use', '该端口已被占用，无法启动工作区。', '使用 start --port 0 分配空闲端口，或明确选择其他端口。');
    throw error;
  });
  runtime.origin = `http://127.0.0.1:${server.address().port}`;
  updateRuntime(home, id, runtime);
  if (runtime.installationPath.split(sep).includes('node_modules')) {
    await import('../frontend/node-runtime.mjs');
  }
  const [{ openDatabase }, { createApp }, mediaModule, generationModule, externalModule] = await Promise.all([
    import('../src/database.ts'), import('../src/server.ts'), import('../src/jobs/index.ts'),
    import('../src/generation/index.ts'), import('../src/sources/external.ts'),
  ]);
  if (Date.now() >= deadline) throw new WorkspaceError('startup_timeout', '本次工作区启动已超时。', '检查安装和依赖后重新运行 start。');
  let media;
  let invalidMediaConfig = false;
  try { media = mediaModule.createMediaProviderFromEnv(); }
  catch { invalidMediaConfig = true; console.error('Sth media configuration is invalid. Check local provider settings.'); }
  db = openDatabase(workspace.dataDir);
  app = createApp(db, { publicOrigin: process.env.STH_PUBLIC_ORIGIN, webPassword: process.env.STH_WEB_PASSWORD,
    mediaProvider: media, invalidMediaConfig });
  workers.push(generationModule.startGenerationWorker(db), externalModule.startExternalWorker(db));
  if (media) workers.push(mediaModule.startJobsWorker(db, { provider: media }));
  if (Date.now() >= deadline) throw new WorkspaceError('startup_timeout', '本次工作区启动已超时。', '检查安装和依赖后重新运行 start。');
  runtime.phase = 'running';
  updateRuntime(home, id, runtime);
  setAttempt(home, attempt, 'ready');
  console.log(`${new Date().toISOString()} Sth workspace ${id} ready at ${runtime.origin}`);
  process.once('SIGTERM', () => shutdown().catch(() => { process.exitCode = 1; }));
  process.once('SIGINT', () => shutdown().catch(() => { process.exitCode = 1; }));
} catch (error) {
  let failure = errorDetails(error);
  if (error?.code === 'ERR_MODULE_NOT_FOUND') failure = {
    code: 'installation_incomplete', message: '当前 Sth 安装缺少运行文件或依赖。', hint: '全新 clone 后先运行 npm ci，安装包需包含 src、web 和 scripts/workspace*.mjs。',
  };
  if (error?.message?.startsWith('STH_PUBLIC_ORIGIN requires')) failure = {
    code: 'invalid_public_origin', message: 'STH_PUBLIC_ORIGIN 与网页密码配置不完整。', hint: '使用完整 HTTPS origin 并设置 STH_WEB_PASSWORD，本机使用也可取消这两个变量。',
  };
  console.error(JSON.stringify({ at: new Date().toISOString(), error: failure }));
  await shutdown(ownsLease ? failure : null);
  setAttempt(home, attempt, failure.code === 'workspace_busy' ? 'busy' : 'failed', failure);
  process.exitCode = failure.code === 'workspace_busy' ? 0 : 1;
}
