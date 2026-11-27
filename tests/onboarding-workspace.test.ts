import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = join(root, 'scripts', 'workspace.mjs');

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  entry?: string;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  value: any;
  error: any;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sth-onboarding-'));
  const homes = new Set<string>();
  const home = join(directory, '本机 配置');
  const cwd = join(directory, '用户 工作目录');
  await mkdir(cwd);
  async function cli(args: string[], options: RunOptions = {}, stateHome = home): Promise<CliResult> {
    homes.add(stateHome);
    return new Promise(resolve => {
      execFile(process.execPath, [options.entry ?? entry, ...args], {
        cwd, windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024,
        env: { ...process.env, STH_WORKSPACE_HOME: stateHome, STH_DATA_DIR: join(directory, 'unused-data'),
          STH_PORT: '1', STH_CONTAINER: '1', STH_PUBLIC_ORIGIN: '', STH_WEB_PASSWORD: '', ...options.env },
      }, (error, stdout, stderr) => {
        let value;
        let failure;
        try { value = JSON.parse(stdout); } catch { /* uri and help are plain text */ }
        for (const line of stderr.split('\n')) {
          try { const parsed = JSON.parse(line); if (parsed.ok === false) failure = parsed.error; } catch { /* Node warnings */ }
        }
        resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr, value, error: failure });
      });
    });
  }
  t.after(async () => {
    for (const stateHome of homes) {
      const listed = await cli(['list'], {}, stateHome);
      for (const workspace of listed.value?.workspaces ?? []) {
        if (workspace.kind !== 'local') continue;
        const stopped = await cli(['stop', '--workspace', workspace.name], {}, stateHome);
        assert.equal(stopped.code, 0, stopped.stderr);
      }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { directory, home, cwd, cli };
}

async function successful(result: Promise<CliResult>) {
  const resolved = await result;
  assert.equal(resolved.code, 0, resolved.stderr || resolved.stdout);
  assert.equal(resolved.value?.ok, true, resolved.stdout);
  return resolved.value;
}

async function fakeServer(t: TestContext, handler: RequestListener, port = 0) {
  const server = createServer(handler);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => close(server));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, port: address.port, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}

async function post(origin: string, route: string, input: object, token?: string) {
  return fetch(origin + route, { method: 'POST', body: JSON.stringify(input), headers: {
    'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
  } });
}

async function invoke(origin: string, operationId: string, input: object, token?: string) {
  const response = await post(origin, token ? '/api/v1/personal-operations/invoke' : '/api/web/invoke', {
    stepId: crypto.randomUUID(), operationId, input,
  }, token);
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value.result;
}

async function pair(origin: string, clientName: string) {
  const code = await (await post(origin, '/api/web/connections/code', {})).json();
  const claim = await post(origin, '/api/v1/personal-operations/claim', { code: code.code, clientName });
  assert.equal(claim.status, 200);
  return (await claim.json()).token as string;
}

test('help and invalid flags do not initialize a workspace', async t => {
  const f = await fixture(t);
  const help = await f.cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /create.*host/);
  for (const args of [
    ['create', '../escape'], ['create', '--host', '../host'], ['start', '--port', '65536'],
    ['create', '--port', '-1'], ['create', '--port', '1.5'], ['status', '--port', '0'],
    ['doctor', '--token-env', 'INVALID-NAME'], ['status', '--wat'], ['connect'],
    ['create', '--home'], ['create', '--port', '0', '--port', '0'], ['restart', 'extra'],
  ]) {
    const result = await f.cli(args);
    assert.equal(result.code, 1, args.join(' '));
    assert(result.error?.code, result.stderr);
  }
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
});

test('first create persists outside the clone and ignores legacy bind/data environment variables', async t => {
  const f = await fixture(t);
  const state = await successful(f.cli(['create', '杉渡', '--host', 'codex']));
  assert.equal(state.kind, 'local');
  assert.equal(state.state, 'running');
  assert.equal(state.owned, true);
  assert.equal(state.healthy, true);
  assert.deepEqual(state.hosts, ['codex']);
  assert(state.dataDir.startsWith(f.home));
  assert(!state.dataDir.startsWith(root));
  assert.match(state.workspaceUri, /^sth:\/\/workspace\/[a-f\d-]{36}$/);
  assert.equal((await fetch(state.origin + '/api/health')).status, 200);
  assert.equal((await fetch(state.origin.replace('127.0.0.1', 'localhost') + '/api/health')).status, 200);
  assert.equal((await readdir(state.dataDir)).includes('sth.sqlite'), true);
  await assert.rejects(readdir(join(f.directory, 'unused-data')), { code: 'ENOENT' });
  const uri = await f.cli(['uri', '--host', 'codex']);
  assert.equal(uri.stdout.trim(), state.origin);
  const json = await successful(f.cli(['uri', '--host', 'codex', '--json']));
  assert.equal(json.personalOperationsOrigin, state.origin);
  assert.equal(json.connectionsUrl, state.origin + '/settings/connections');
  assert(!json.stdout?.includes('controlToken'));
  assert(!JSON.stringify(json).includes('controlToken'));
});

test('stop, start, restart and repeated create recover the same diary and pairing', async t => {
  const f = await fixture(t);
  const initial = await successful(f.cli(['create', 'journal']));
  const token = await pair(initial.origin, '本机助手');
  const diary = await invoke(initial.origin, 'diary.create', { title: '本机持久化', body: '第一次运行', diaryDate: '2026-11-27' }, token);
  const stopped = await successful(f.cli(['stop']));
  assert.equal(stopped.state, 'stopped');
  const status = await f.cli(['status']);
  assert.equal(status.code, 1);
  assert.equal(status.value.state, 'stopped');
  const started = await successful(f.cli(['start']));
  assert.equal(started.id, initial.id);
  assert.equal(started.origin, initial.origin);
  assert.equal(started.dataDir, initial.dataDir);
  assert.equal((await invoke(started.origin, 'diary.read', { noteId: diary.noteId }, token)).body, '第一次运行');
  const again = await successful(f.cli(['init', 'journal']));
  assert.equal(again.pid, started.pid);
  const restarted = await successful(f.cli(['restart']));
  assert.equal(restarted.id, initial.id);
  assert.notEqual(restarted.pid, started.pid);
  assert.equal(restarted.origin, initial.origin);
  assert.equal((await invoke(restarted.origin, 'diary.read', { noteId: diary.noteId }, token)).noteId, diary.noteId);
});

test('two hosts share one service with independently verified personal tokens', async t => {
  const f = await fixture(t);
  const state = await successful(f.cli(['create', 'shared', '--host', 'codex']));
  const bound = await successful(f.cli(['use', 'shared', '--host', 'hermes']));
  assert.deepEqual(bound.hosts, ['codex', 'hermes']);
  const first = await pair(state.origin, 'Codex 验证');
  const second = await pair(state.origin, 'Hermes 验证');
  const diary = await invoke(state.origin, 'diary.create', { title: '共享日记', body: 'Codex 写入', diaryDate: '2026-11-27' }, first);
  assert.equal((await invoke(state.origin, 'diary.read', { noteId: diary.noteId }, second)).body, 'Codex 写入');
  const report = await successful(f.cli(['doctor', '--host', 'hermes', '--token-env', 'STH_TEST_TOKEN'], { env: { STH_TEST_TOKEN: second } }));
  assert.equal(report.passed, true);
  assert.equal(report.checks.find((check: any) => check.id === 'personal_catalog').authenticated, true);
  const raw = JSON.stringify(report);
  assert(!raw.includes(second));
  assert(!raw.includes('controlToken'));
  const revoked = await f.cli(['doctor', '--host', 'hermes', '--token-env', 'STH_TEST_TOKEN'], { env: { STH_TEST_TOKEN: 'wrong-token' } });
  assert.equal(revoked.code, 1);
  assert.equal(revoked.value.checks.find((check: any) => check.id === 'personal_catalog').httpStatus, 401);
  const missing = await f.cli(['doctor', '--host', 'hermes', '--token-env', 'STH_EMPTY_TOKEN'], { env: { STH_EMPTY_TOKEN: '' } });
  assert.equal(missing.value.checks.find((check: any) => check.id === 'personal_catalog').code, 'token_missing');
  const noToken = await successful(f.cli(['doctor', '--host', 'codex']));
  assert.equal(noToken.checks.find((check: any) => check.id === 'personal_catalog').authenticated, false);
});

test('concurrent first creation elects exactly one daemon and retains every host binding', async t => {
  const f = await fixture(t);
  const results = await Promise.all(['codex', 'hermes', 'mcp'].map(host => successful(f.cli(['create', '共同工作区', '--host', host]))));
  assert.equal(new Set(results.map(value => value.id)).size, 1);
  assert.equal(new Set(results.map(value => value.pid)).size, 1);
  const state = await successful(f.cli(['status', '--workspace', '共同工作区']));
  assert.deepEqual(state.hosts, ['codex', 'hermes', 'mcp']);
  const list = await successful(f.cli(['list']));
  assert.equal(list.workspaces.length, 1);
});

test('independent named workspaces have separate ports and data', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all(['one', 'two'].map(name => successful(f.cli(['create', name, '--host', name]))));
  assert.notEqual(first.origin, second.origin);
  assert.notEqual(first.dataDir, second.dataDir);
  await invoke(first.origin, 'diary.create', { title: '第一份数据', body: '只在 one', diaryDate: '2026-11-27' });
  assert.equal((await invoke(second.origin, 'diary.list', {})).items.length, 0);
  await successful(f.cli(['stop', '--host', 'one']));
  assert.equal((await successful(f.cli(['status', '--host', 'two']))).healthy, true);
  assert.equal((await successful(f.cli(['status', '--workspace', 'two']))).name, 'two');
});

test('connect registers an existing Sth without taking over its lifecycle', async t => {
  const f = await fixture(t);
  const owner = await successful(f.cli(['create', 'owner']));
  const clientHome = join(f.directory, '另一个 安装');
  const connection = await successful(f.cli(['connect', owner.origin + '/', '--workspace', 'existing', '--host', 'mcp'], {}, clientHome));
  assert.equal(connection.kind, 'connected');
  assert.equal(connection.dataDir, null);
  assert.equal(connection.owned, false);
  assert.equal(connection.origin, owner.origin);
  for (const command of ['start', 'stop', 'restart']) {
    const result = await f.cli([command, '--host', 'mcp'], {}, clientHome);
    assert.equal(result.code, 1);
    assert.equal(result.error.code, 'external_lifecycle');
  }
  const diary = await invoke(connection.origin, 'diary.create', { title: '已连接的服务', body: '同一份数据', diaryDate: '2026-11-27' });
  assert.equal((await invoke(owner.origin, 'diary.read', { noteId: diary.noteId })).body, '同一份数据');
  assert.equal((await successful(f.cli(['status']))).pid, owner.pid);
  assert.equal((await successful(f.cli(['doctor', '--host', 'mcp'], {}, clientHome))).passed, true);
});

test('an occupied port is preserved and failed creation retains the previous host binding', async t => {
  const f = await fixture(t);
  const original = await successful(f.cli(['create', 'original']));
  let requests = 0;
  const occupied = await fakeServer(t, (_request, response) => { requests++; response.end('existing service'); });
  const failure = await f.cli(['create', 'conflict', '--port', String(occupied.port)]);
  assert.equal(failure.code, 1);
  assert.equal(failure.error.code, 'port_in_use');
  assert.equal(requests, 0);
  const list = await successful(f.cli(['list']));
  const conflict = list.workspaces.find((workspace: any) => workspace.name === 'conflict');
  assert(conflict);
  assert.deepEqual(await readdir(conflict.dataDir), []);
  assert.equal((await successful(f.cli(['status']))).id, original.id);
  assert.equal(await (await fetch(occupied.origin)).text(), 'existing service');
  const recovered = await successful(f.cli(['start', '--workspace', 'conflict', '--port', '0']));
  assert.equal(recovered.id, conflict.id);
  assert.notEqual(recovered.origin, occupied.origin);
});

test('restart refuses a newly occupied saved port and can recover on an automatic port', async t => {
  const f = await fixture(t);
  const initial = await successful(f.cli(['create', 'recover']));
  const diary = await invoke(initial.origin, 'diary.create', { title: '端口切换', body: '原数据', diaryDate: '2026-11-27' });
  await successful(f.cli(['stop']));
  const occupied = await fakeServer(t, (_request, response) => response.end('other owner'), Number(new URL(initial.origin).port));
  const failure = await f.cli(['restart']);
  assert.equal(failure.error.code, 'port_in_use');
  assert.equal(await (await fetch(occupied.origin)).text(), 'other owner');
  const recovered = await successful(f.cli(['restart', '--port', '0']));
  assert.equal(recovered.id, initial.id);
  assert.equal(recovered.dataDir, initial.dataDir);
  assert.notEqual(recovered.origin, initial.origin);
  assert.equal((await invoke(recovered.origin, 'diary.read', { noteId: diary.noteId })).body, '原数据');
});

test('a crashed managed process releases its lease and recovers persisted data', async t => {
  const f = await fixture(t);
  const initial = await successful(f.cli(['create', 'crash']));
  const diary = await invoke(initial.origin, 'diary.create', { title: '崩溃恢复', body: '已提交数据', diaryDate: '2026-11-27' });
  process.kill(initial.pid, 'SIGKILL');
  await delay(100);
  const recovered = await successful(f.cli(['start']));
  assert.notEqual(recovered.pid, initial.pid);
  assert.equal(recovered.id, initial.id);
  assert.equal((await invoke(recovered.origin, 'diary.read', { noteId: diary.noteId })).body, '已提交数据');
});

test('management endpoints require the private runtime token', async t => {
  const f = await fixture(t);
  const state = await successful(f.cli(['create', 'owned']));
  for (const [path, method] of [['/.well-known/sth-workspace', 'GET'], ['/.well-known/sth-workspace/stop', 'POST']]) {
    const response = await fetch(state.origin + path, { method });
    assert.equal(response.status, 403);
    assert(!JSON.stringify(await response.json()).includes('controlToken'));
  }
  const invalidRestart = await f.cli(['restart', '--port', '65536']);
  assert.equal(invalidRestart.error.code, 'invalid_port');
  const differentPort = await f.cli(['start', '--port', '1']);
  assert.equal(differentPort.error.code, 'already_running');
  assert.equal((await successful(f.cli(['status']))).pid, state.pid);
});

test('a stale PID reused by another process cannot authorize stopping the new port owner', async t => {
  const f = await fixture(t);
  const state = await successful(f.cli(['create', 'stale-pid']));
  process.kill(state.pid, 'SIGKILL');
  await delay(100);
  const foreign = await fakeServer(t, (_request, response) => response.end('unrelated service'), Number(new URL(state.origin).port));
  const registry = new DatabaseSync(join(f.home, 'registry.sqlite'));
  try {
    const row = registry.prepare('SELECT runtime FROM workspaces WHERE id=?').get(state.id);
    assert(row && typeof row.runtime === 'string');
    const runtime = JSON.parse(row.runtime);
    runtime.pid = process.pid;
    registry.prepare('UPDATE workspaces SET runtime=? WHERE id=?').run(JSON.stringify(runtime), state.id);
    const stop = await f.cli(['stop']);
    assert.equal(stop.code, 1);
    assert.equal(stop.error.code, 'ownership_unverified');
    const status = await f.cli(['status']);
    assert.equal(status.value.state, 'unverified');
    assert.equal(status.value.owned, false);
    assert.equal(await (await fetch(foreign.origin)).text(), 'unrelated service');
  } finally {
    registry.prepare('UPDATE workspaces SET runtime=NULL WHERE id=?').run(state.id);
    registry.close();
  }
});

test('failed startup returns actionable feedback and is immediately retryable', async t => {
  const f = await fixture(t);
  const invalid = await f.cli(['create', 'retry'], { env: { STH_PUBLIC_ORIGIN: 'http://invalid.example', STH_WEB_PASSWORD: 'never-print-me' } });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.error.code, 'invalid_public_origin');
  assert(!invalid.stderr.includes('never-print-me'));
  const status = await f.cli(['status', '--workspace', 'retry']);
  assert.equal(status.code, 1);
  assert.equal(status.value.lastError.code, 'invalid_public_origin');
  const recovered = await successful(f.cli(['create', 'retry']));
  assert.equal(recovered.id, status.value.id);
  assert.equal(recovered.lastError, undefined);
  const log = await readFile(recovered.logPath, 'utf8');
  assert(!log.includes('never-print-me'));
});

test('bad connections preserve bindings and reject credentials, redirects and insecure remote origins', async t => {
  const f = await fixture(t);
  const current = await successful(f.cli(['create', 'current']));
  const foreign = await fakeServer(t, (_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"name":"Other","status":"ok","schemaVersion":4}'); });
  const redirect = await fakeServer(t, (_request, response) => { response.writeHead(302, { location: current.origin + '/api/health' }); response.end(); });
  for (const origin of [foreign.origin, redirect.origin]) {
    const failed = await f.cli(['connect', origin, '--workspace', 'bad']);
    assert.equal(failed.error.code, 'connection_failed');
  }
  const credentials = new URL(current.origin);
  credentials.username = 'fixture';
  credentials.password = 'fixture';
  for (const origin of ['ftp://localhost', credentials.href, 'http://192.0.2.1:42', current.origin + '/api/health', current.origin + '?token=secret']) {
    const failed = await f.cli(['connect', origin, '--workspace', 'bad']);
    assert.equal(failed.code, 1);
    assert(['invalid_uri', 'https_required'].includes(failed.error.code));
    assert(!failed.stderr.includes('secret'));
  }
  assert.equal((await successful(f.cli(['status']))).id, current.id);
  assert.equal((await successful(f.cli(['list']))).workspaces.length, 1);
});

test('stopped workspace doctor reports the selected host and retained data directory', async t => {
  const f = await fixture(t);
  const state = await successful(f.cli(['create', 'diagnose', '--host', 'my-agent']));
  await successful(f.cli(['stop', '--host', 'my-agent']));
  const result = await f.cli(['doctor', '--host', 'my-agent']);
  assert.equal(result.code, 1);
  assert.equal(result.value.passed, false);
  assert.deepEqual(result.value.hosts, ['my-agent']);
  assert.equal(result.value.dataDir, state.dataDir);
  assert.equal(result.value.checks.find((check: any) => check.id === 'data_directory').ok, true);
  assert.equal(result.value.checks.find((check: any) => check.id === 'managed_service').ok, false);
});

test('installation in a different path and invocation from another cwd retain the same workspace', async t => {
  const f = await fixture(t);
  const installed = join(f.directory, 'Sth 安装目录');
  await mkdir(join(installed, 'scripts'), { recursive: true });
  const scripts = (await readdir(join(root, 'scripts'))).filter(file => /^workspace.*\.mjs$/.test(file));
  for (const script of scripts) await cp(join(root, 'scripts', script), join(installed, 'scripts', script));
  const installedEntry = join(installed, 'scripts', 'workspace.mjs');
  const missing = await f.cli(['create', 'portable'], { entry: installedEntry });
  assert.equal(missing.error.code, 'installation_incomplete');
  await cp(join(root, 'src'), join(installed, 'src'), { recursive: true });
  await symlink(join(root, 'node_modules'), join(installed, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const initial = await successful(f.cli(['create', 'portable'], { entry: installedEntry }));
  assert.equal(initial.installationPath, installed + (process.platform === 'win32' ? '\\' : '/'));
  const diary = await invoke(initial.origin, 'diary.create', { title: '安装位置变更', body: '数据随用户目录保留', diaryDate: '2026-11-27' });
  // Switch back to the actual checkout using the same user home.
  const restarted = await successful(f.cli(['restart']));
  assert.equal(restarted.id, initial.id);
  assert.equal(restarted.dataDir, initial.dataDir);
  assert.equal(restarted.installationPath, root);
  assert.equal((await invoke(restarted.origin, 'diary.read', { noteId: diary.noteId })).body, '数据随用户目录保留');
});
