import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { detectHost, hostProfile, runHost, stopHostProcess } from '../mcp/host-process.mjs';
import { installHost } from '../mcp/hosts.mjs';
import { setupService } from './service-fixture.mjs';

const cli = fileURLToPath(new URL('../mcp/cli.mjs', import.meta.url));

// Opt-in only. Google's documented local silent sign-in intentionally shares
// the OS authorization with the installed host. Never read or copy its tokens.
// ACP fails on missing authorization instead of launching interactive login.
function acp(launcher, env, cwd, allow) {
  const child = spawn(launcher.command, [...launcher.args, 'acp',
    '--include-default-customizations=false', '--disable-telemetry'], {
    env, cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0;
  let buffer = '';
  const pending = new Map();
  const updates = [];
  const permissions = [];
  let closed = false;
  function send(message) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  function fail() {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('Antigravity ACP exited before completing the fixture request.'));
    }
    pending.clear();
  }
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {}); // Account diagnostics never enter test output.
  child.once('error', fail);
  child.once('close', fail);
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 2_000_000) { void stopHostProcess(child); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'session/update') updates.push(message.params);
      if (message.method && message.id !== undefined) {
        if (message.method === 'session/request_permission') {
          const option = message.params.options?.find(item => item.kind === 'allow_once');
          const allowed = option && allow(message.params);
          permissions.push({ allowed: Boolean(allowed) });
          send({ id: message.id, result: { outcome: allowed
            ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
        } else send({ id: message.id, error: { code: -32601, message: 'Client capability unavailable' } });
      } else if (pending.has(message.id)) {
        const request = pending.get(message.id);
        clearTimeout(request.timer);
        pending.delete(message.id);
        request.resolve(message);
      }
    }
  });
  return {
    updates, permissions,
    request(method, params, timeout = 20_000) {
      if (closed) return Promise.reject(new Error('Antigravity ACP is closed.'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Antigravity ACP ${method} fixture request timed out.`));
          void stopHostProcess(child);
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    async close() { await stopHostProcess(child); fail(); },
  };
}

test('Antigravity existing authorization performs fixture MCP calls and reads back in a new session', {
  skip: process.env.STH_TEST_AGY_REUSE_LOGIN !== '1' && 'Explicitly opt in with STH_TEST_AGY_REUSE_LOGIN=1 and STH_TEST_AGY',
  timeout: 180_000,
}, async t => {
  assert.ok(process.env.STH_TEST_AGY, 'Supply the official native Antigravity executable.');
  const f = await setupService(t);
  const temporary = await mkdtemp(join(tmpdir(), 'sth-agy-fixture-'));
  t.after(async () => {
    assert.equal(await realpath(temporary), temporary);
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  });
  const env = await hostProfile(join(temporary, 'profile'), 'antigravity');
  const workspace = join(env.HOME, 'fixture workspace 中文');
  await mkdir(workspace);
  const host = await detectHost('antigravity', { executable: process.env.STH_TEST_AGY, env, cwd: workspace });
  assert.equal(host.available, true);
  const paired = await runHost({ command: process.execPath, args: [cli] }, ['pair', join(f.directory, 'binding'), '--client-name', 'Sth Antigravity fixture'], {
    env: { ...env, STH_PERSONAL_OPERATIONS_ORIGIN: f.origin }, cwd: workspace, input: `${await f.code()}\n`,
  });
  assert.equal(paired.code, 0, 'Fixture pairing failed.');
  const binding = JSON.parse(paired.stdout).file;
  const source = await f.invoke('source.create', 'fixture-create', { kind: 'setting', title: 'Antigravity live fixture', body: 'Initial fixture body.' });
  const config = join(env.HOME, '.gemini', 'config', 'mcp_config.json');
  await installHost({ host: 'antigravity', config, binding, workspace, sourceId: source.sourceId, name: 'sth-fixture' });
  const settingsDirectory = join(env.HOME, '.gemini', 'antigravity-cli');
  await mkdir(settingsDirectory, { recursive: true });
  const settings = JSON.stringify({ toolPermission: 'request-review', allowNonWorkspaceAccess: false,
    permissions: { allow: ['mcp(sth-fixture/*)'], deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'] } });
  await writeFile(join(settingsDirectory, 'settings.json'), settings);
  const installed = await readFile(config, 'utf8');

  // This is an explicit authorization choice, never an automatic fallback from
  // an empty file-token profile. All other home/config/model-key isolation stays.
  delete env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE;
  delete env.ANTIGRAVITY_CREDENTIAL_SCOPE;
  const marker = `STH_AGY_FIXTURE_${randomUUID()}`;
  let writeSession;
  function allow(params) {
    const call = params.toolCall?.rawInput;
    if (call?.ServerName !== 'sth-fixture') return false;
    if (call.ToolName === 'sth_personal_discover') {
      return !call.Arguments?.operationId || ['source.read', 'source.revise'].includes(call.Arguments.operationId);
    }
    if (call.ToolName !== 'sth_personal_invoke' || call.Arguments?.input?.sourceId !== source.sourceId) return false;
    return call.Arguments.operationId === 'source.read' || (params.sessionId === writeSession
      && call.Arguments.operationId === 'source.revise' && call.Arguments.input.expectedRevision === 1 && call.Arguments.input.body === marker);
  }
  const agent = acp(host.launcher, env, workspace, allow);
  try {
    const initialized = await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'sth-controlled-fixture', version: '1.0.0' } });
    assert.ok(initialized.result?.agentInfo, 'ACP initialization failed.');
    const first = await agent.request('session/new', { cwd: workspace, mcpServers: [] });
    if (first.error?.code === -32000 && first.error?.message === 'Authentication required') {
      t.skip('The normal shared authorization is unavailable to ACP. No interactive login was attempted.');
      return;
    }
    assert.ok(first.result?.sessionId, `ACP session creation failed with code ${first.error?.code}.`);
    writeSession = first.result.sessionId;
    const write = await agent.request('session/prompt', { sessionId: first.result.sessionId, prompt: [{ type: 'text', text:
      `Use only the sth-fixture MCP server. Discover source.read and source.revise, read source ${source.sourceId}, then revise it with expectedRevision 1 and body exactly ${marker}. Use caller stepId agy-fixture-write. Do not use file, command, browser, or other tools. Report the saved source ID and revision.` }] }, 65_000);
    assert.ok(!write.error, `ACP fixture write failed with code ${write.error?.code}.`);
    t.diagnostic(`Write turn ended with ${agent.permissions.filter(item => item.allowed).length} fixture permissions and ${f.calls.filter(call => call.action === 'invoke').length} Sth invokes.`);
    const saved = await f.invoke('source.read', 'fixture-web-read', { sourceId: source.sourceId });
    assert.equal(saved.body, marker, 'The real model did not save the expected fixture body.');
    assert.equal(saved.revision, 2);
    const second = await agent.request('session/new', { cwd: workspace, mcpServers: [] });
    assert.ok(second.result?.sessionId, 'A new ACP session could not be created.');
    assert.notEqual(second.result.sessionId, first.result.sessionId);
    const updateStart = agent.updates.length;
    const read = await agent.request('session/prompt', { sessionId: second.result.sessionId, prompt: [{ type: 'text', text:
      `Use only the sth-fixture MCP server. Discover source.read and read source ${source.sourceId} at its latest revision. Use caller stepId agy-fixture-read. Reply with its exact body and revision. Do not use file, command, browser, or other tools.` }] }, 65_000);
    assert.ok(!read.error, `ACP fixture read failed with code ${read.error?.code}.`);
    const secondUpdates = agent.updates.slice(updateStart);
    assert.ok(secondUpdates.some(item => item.update?.sessionUpdate === 'agent_message_chunk' && item.update.content?.text?.includes(marker))
      || secondUpdates.filter(item => item.update?.sessionUpdate === 'agent_message_chunk').map(item => item.update.content?.text || '').join('').includes(marker),
    'The fresh session did not return the saved fixture marker.');
    const toolCalls = agent.updates.filter(item => item.update?.sessionUpdate === 'tool_call' || item.update?.sessionUpdate === 'tool_call_update');
    assert.ok(toolCalls.length >= 4, 'Expected actual ACP MCP tool-call events.');
    assert.ok(agent.permissions.every(item => item.allowed), 'Unexpected permission requests were cancelled.');
    assert.equal(await readFile(config, 'utf8'), installed);
    assert.equal(await readFile(join(settingsDirectory, 'settings.json'), 'utf8'), settings);
    assert.ok(f.calls.filter(call => call.action === 'invoke' && call.status === 200).length >= 4);
    t.diagnostic(`${host.version} completed two new ACP sessions with ${toolCalls.length} tool events and fixture revision ${saved.revision}.`);
  } catch (error) {
    t.diagnostic(JSON.stringify({ fixtureRequests: f.calls.map(call => call.action), permissions: agent.permissions,
      tools: agent.updates.filter(item => item.update?.sessionUpdate === 'tool_call').map(item => item.update.title) }));
    throw error;
  } finally { await agent.close(); }
});
