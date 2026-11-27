import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { link, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installHost } from '../mcp/hosts.mjs';
import { updateAntigravityConfig } from '../mcp/host-json.mjs';
import { absoluteLocalPath, hostProfile, isolatedEnvironment, runHost } from '../mcp/host-process.mjs';
import { setupService } from './service-fixture.mjs';

const cli = fileURLToPath(new URL('../mcp/cli.mjs', import.meta.url));
const installer = fileURLToPath(new URL('../scripts/install-agent-host.mjs', import.meta.url));

export function command(file, args, { env = process.env, input, cwd } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

export async function pairing(f, name) {
  const code = await f.code();
  const result = await command(cli, ['pair', join(f.directory, name), '--client-name', `Sth ${name}`], {
    env: { ...process.env, STH_PERSONAL_OPERATIONS_ORIGIN: f.origin }, input: `${code}\n`,
  });
  assert.equal(result.code, 0, result.stderr);
  const { file, connectionId } = JSON.parse(result.stdout);
  const { token } = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(!result.stdout.includes(token) && !result.stdout.includes(code) && !result.stderr);
  return { file, connectionId, token };
}

export async function connect(t, entry) {
  const client = new Client({ name: 'sth-host-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...entry, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  try { await client.connect(transport, { timeout: 5_000 }); } catch (error) {
    await client.close();
    throw new Error(`${error.message} ${stderr}`);
  }
  return client;
}

export async function invoke(client, operationId, stepId, input) {
  const response = await client.callTool({ name: 'sth_personal_invoke', arguments: { operationId, stepId, input } });
  assert.ok(!response.isError, response.content[0].text);
  return response.structuredContent.result;
}

test('Antigravity JSON edits preserve other bytes and protect collisions and malformed files', () => {
  const old = '{\r\n "comment": "保留\\\"内容",\r\n "mcpServers": {"other": {"args":["a",{"b":[1,true,null]}], "env":{"KEY":"private"}}},\r\n "tail": 42\r\n}\r\n';
  const entry = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['F:\\本地 工作区\\cli.mjs'] };
  const next = updateAntigravityConfig(old, 'sth', entry);
  assert.deepEqual(JSON.parse(next), { ...JSON.parse(old), mcpServers: { ...JSON.parse(old).mcpServers, sth: entry } });
  assert.ok(next.includes('"other": {"args":["a",{"b":[1,true,null]}], "env":{"KEY":"private"}}'));
  assert.ok(next.startsWith('{\r\n "comment": "保留\\\"内容",\r\n '));
  assert.ok(next.endsWith(',\r\n "tail": 42\r\n}\r\n'));
  assert.equal(updateAntigravityConfig(next, 'sth', entry), next);
  const reordered = { args: entry.args, command: entry.command };
  assert.equal(updateAntigravityConfig(next, 'sth', reordered), next);
  assert.throws(() => updateAntigravityConfig(next, 'sth', { ...entry, args: [] }), /--replace/);
  const replaced = updateAntigravityConfig(next, 'sth', { ...entry, args: [] }, true);
  assert.equal(JSON.parse(replaced).mcpServers.sth.args.length, 0);
  assert.deepEqual(JSON.parse(replaced).mcpServers.other, JSON.parse(old).mcpServers.other);
  for (const value of ['[]', '{"mcpServers":null}', '{"mcpServers":[]}', '{"mcpServers":{},"mcpServers":{}}', '{"nested":{"a":1,"a":2}}', '{"secret":"do-not-echo",oops}']) {
    assert.throws(() => updateAntigravityConfig(value, 'sth', entry), error => !error.message.includes('do-not-echo'));
  }
  assert.deepEqual(JSON.parse(updateAntigravityConfig('{}', 'sth', entry)), { mcpServers: { sth: entry } });
  assert.deepEqual(JSON.parse(updateAntigravityConfig('{"other":1}', 'sth', entry)), { other: 1, mcpServers: { sth: entry } });
});

test('isolated profiles exclude production credentials and bind Windows credential storage', async t => {
  const f = await setupService(t);
  const env = isolatedEnvironment(f.directory, { PATH: 'runtime', MAGPIE_API_KEY: 'secret', OPENAI_API_KEY: 'secret',
    GEMINI_API_KEY: 'secret', GOOGLE_APPLICATION_CREDENTIALS: 'secret', AGY_ACCOUNT: 'secret',
    ANTIGRAVITY_LS_ADDRESS: 'secret', CODEX_HOME: 'secret', HOME: 'secret', USERPROFILE: 'secret',
    HTTP_PROXY: 'http://proxy:1234' });
  for (const key of ['MAGPIE_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_ACCOUNT', 'ANTIGRAVITY_LS_ADDRESS']) assert.equal(env[key], undefined);
  assert.equal(env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE, '1');
  assert.match(env.ANTIGRAVITY_CREDENTIAL_SCOPE, /^sth-[a-f0-9]{24}$/);
  assert.equal(env.CODEX_HOME, join(f.directory, 'codex'));
  assert.equal(env.HTTP_PROXY, 'http://proxy:1234');
  if (process.platform === 'win32') {
    for (const remote of ['\\\\server\\share\\config.json', '//server/share/profile', '\\\\.\\pipe\\host']) {
      assert.throws(() => absoluteLocalPath(remote, 'configuration'), /absolute local/);
    }
  }
  const root = join(f.directory, 'host-profile');
  assert.deepEqual(await hostProfile(root, 'antigravity'), await hostProfile(root, 'antigravity'));
  await assert.rejects(hostProfile(root, 'codex'), /different host/);
  await assert.rejects(hostProfile(f.directory, 'antigravity'), /isolation marker/);
});

test('independent Codex and Antigravity pairings select one source and preserve receipts and revocation boundaries', { timeout: 45_000 }, async t => {
  const f = await setupService(t);
  const agy = await pairing(f, 'Antigravity');
  const codex = await pairing(f, 'Codex');
  assert.notEqual(agy.token, codex.token);
  assert.notEqual(agy.connectionId, codex.connectionId);
  const source = await f.invoke('source.create', 'web-source', { kind: 'setting', title: '共享源', body: '同一份初始内容。' });
  const workspace = join(f.directory, '本地 workspace with spaces');
  await mkdir(workspace);
  const config = join(workspace, '.agents', 'mcp_config.json');
  await mkdir(join(workspace, '.agents'));
  const initial = '{\r\n  "custom": {"key":"keep"},\r\n  "mcpServers": {"existing":{"command":"keep"}}\r\n}\r\n';
  await writeFile(config, initial, { mode: 0o600 });
  const options = { host: 'antigravity', config, binding: agy.file, workspace, sourceId: source.sourceId, name: 'sth-acceptance' };
  assert.equal((await installHost(options)).changed, true);
  const saved = await readFile(config, 'utf8');
  const mtime = (await lstat(config)).mtimeMs;
  assert.equal((await installHost(options)).changed, false);
  assert.equal((await lstat(config)).mtimeMs, mtime);
  assert.equal(await readFile(config, 'utf8'), saved);
  assert.equal(f.calls.filter(call => call.action === 'claim').length, 2);
  const configValue = JSON.parse(saved);
  assert.deepEqual(configValue.mcpServers.existing, { command: 'keep' });
  assert.deepEqual(configValue.custom, { key: 'keep' });
  assert.ok(saved.includes('"custom": {"key":"keep"}'));
  assert.ok(!saved.includes(agy.token) && !saved.includes(codex.token));
  await t.test('stdio source readback and independent revocation', async protocol => {
    const clientAgy = await connect(protocol, configValue.mcpServers['sth-acceptance']);
    const clientCodex = await connect(protocol, { command: process.execPath, args: [cli, 'stdio', codex.file, '--workspace', workspace, '--source-id', source.sourceId] });
    for (const client of [clientAgy, clientCodex]) {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 3);
      assert.ok(tools.tools[0].description.includes(source.sourceId));
      assert.ok(tools.tools.find(tool => tool.name === 'sth_personal_invoke').description.includes('top-level'));
      const invalid = await client.callTool({ name: 'sth_personal_invoke', arguments: {
        operationId: 'source.read', caller: { stepId: 'nested-by-mistake' }, input: { sourceId: source.sourceId },
      } });
      assert.equal(invalid.isError, true);
      assert.match(JSON.parse(invalid.content[0].text).message, /top-level.*stepId/);
      assert.deepEqual(await invoke(client, 'source.read', 'same-step', { sourceId: source.sourceId }),
        { ...source, portalUrl: f.origin + source.href });
    }
    const changed = await invoke(clientAgy, 'source.revise', 'revise-shared', { sourceId: source.sourceId, expectedRevision: 1, body: 'Antigravity 保存的共享内容。' });
    assert.equal(changed.revision, 2);
    assert.deepEqual(await invoke(clientCodex, 'source.read', 'read-current', { sourceId: source.sourceId }), changed);
    const { portalUrl, ...changedSource } = changed;
    assert.equal(portalUrl, f.origin + changed.href);
    assert.deepEqual(await f.invoke('source.read', 'web-read-host-source', { sourceId: source.sourceId }), changedSource);
    const scene = await f.invoke('scene.create', 'ordinary-scene', { title: '普通写作场景' });
    const textSource = await f.invoke('source.create', 'unicode-source', {
      kind: 'excerpt', title: '重复句的精确选段', body: '🌙序。同一句。过渡。同一句。结尾。',
    });
    const start = textSource.body.lastIndexOf('同一句');
    const range = { start, end: start + '同一句'.length };
    const notes = [];
    for (const [host, client] of [['Antigravity', clientAgy], ['Codex', clientCodex]]) {
      const call = (name, args) => client.callTool({ name, arguments: args });
      async function wire(operationId, stepId, input) {
        const response = await call('sth_personal_invoke', { operationId, stepId, input });
        assert.ok(!response.isError, response.content[0].text);
        assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
        assert.equal(response.structuredContent.operationId, operationId);
        assert.equal(response.structuredContent.stepId, `sth.mcp.v1:${stepId}`);
        assert.equal(response.structuredContent.replayed, false);
        const saved = response.structuredContent.result;
        assert.equal(response.content[1].text, `[${saved.title}](${saved.portalUrl})`);
        return response.structuredContent;
      }
      const diary = await wire('diary.create', 'ordinary-diary', {
        title: `${host} 普通日记`, body: '当前对话完成的正文。', diaryDate: '2024-02-29',
      });
      notes.push(diary.result.noteId);
      assert.equal(diary.result.portalUrl, `${f.origin}/diaries/${diary.result.noteId}?revision=1`);
      assert.equal(diary.result.projectId, undefined);
      const draft = await wire('draft.create', 'ordinary-draft', {
        sceneId: scene.sceneId, sceneRevision: scene.revision, title: `${host} 候选稿`, body: '普通写作直接保存的候选正文。',
      });
      assert.equal(draft.result.portalUrl, `${f.origin}/drafts/${draft.result.draftId}?revision=1`);
      const selected = await wire('source.read', 'read-selection', {
        sourceId: textSource.sourceId, revision: 1, range, contextChars: 0,
      });
      assert.equal(selected.result.body, '同一句');
      assert.equal(selected.result.portalUrl, `${f.origin}${textSource.href}&start=${range.start}&end=${range.end}`);
      assert.deepEqual(selected.result.context.range, range);
      const current = await f.invoke('diary.revise', `web-revise-${host}`, {
        noteId: diary.result.noteId, title: diary.result.title, diaryDate: diary.result.diaryDate,
        body: '网页上的新版正文。', expectedRevision: 1,
      });
      await f.invoke('draft.revise', `web-revise-draft-${host}`, {
        draftId: draft.result.draftId, expectedRevision: 1, body: '网页修改过的候选正文。',
      });
      for (const original of [diary, draft, selected]) {
        const response = await call('sth_personal_receipt', {
          operationId: original.operationId, stepId: original.stepId.slice('sth.mcp.v1:'.length),
        });
        assert.deepEqual(response.structuredContent, { ...original, replayed: true });
        assert.ok(response.content[1].text.includes(original.result.portalUrl));
      }
      const read = await wire('diary.read', 'read-latest-diary', { noteId: current.noteId });
      assert.equal(read.result.portalUrl, `${f.origin}/diaries/${current.noteId}?revision=2`);
      const old = await wire('draft.read', 'read-old-draft', { draftId: draft.result.draftId, revision: 1 });
      assert.equal(old.result.body, draft.result.body);
      assert.equal(old.result.portalUrl, draft.result.portalUrl);
    }
    assert.notEqual(notes[0], notes[1]);
    await f.revoke(agy.connectionId);
    const revoked = await clientAgy.callTool({ name: 'sth_personal_discover', arguments: {} });
    assert.equal(JSON.parse(revoked.content[0].text).error, 'connection_unauthorized');
    const revokedReceipt = await clientAgy.callTool({ name: 'sth_personal_receipt', arguments: {
      operationId: 'diary.create', stepId: 'ordinary-diary',
    } });
    assert.equal(JSON.parse(revokedReceipt.content[0].text).error, 'connection_unauthorized');
    const retainedReceipt = await clientCodex.callTool({ name: 'sth_personal_receipt', arguments: {
      operationId: 'diary.create', stepId: 'ordinary-diary',
    } });
    assert.equal(retainedReceipt.structuredContent.result.noteId, notes[1]);
    assert.notEqual(retainedReceipt.structuredContent.result.noteId, notes[0]);
    assert.ok(!(await clientCodex.callTool({ name: 'sth_personal_discover', arguments: {} })).isError);
  });
  assert.deepEqual((await f.connections()).map(connection => connection.clientName).sort(), ['Sth Antigravity', 'Sth Codex']);
  if (process.platform !== 'win32') assert.equal((await lstat(config)).mode & 0o777, 0o600);
});

test('installer refuses unsafe paths, invalid source, existing entries, locks and configuration aliases', { timeout: 30_000 }, async t => {
  const f = await setupService(t);
  const binding = await pairing(f, 'Antigravity');
  const config = join(f.directory, 'mcp_config.json');
  const options = { host: 'antigravity', config, binding: binding.file, workspace: f.directory };
  const initial = '{"mcpServers":{"sth-personal":{"serverUrl":"https://example.test","headers":{"Authorization":"secret-value"}}}}';
  await writeFile(config, initial);
  await assert.rejects(installHost(options), /--replace/);
  assert.equal(await readFile(config, 'utf8'), initial);
  await assert.rejects(installHost({ ...options, replace: true, sourceId: 'missing-source' }), /could not be read/);
  assert.equal(await readFile(config, 'utf8'), initial);
  await writeFile(`${config}.sth-install-lock`, 'held');
  await assert.rejects(installHost({ ...options, replace: true }), /locked/);
  for (const extra of [{ config: 'relative.json' }, { binding: 'relative.json' }, { workspace: 'relative' }, { name: '__proto__?' }, { sourceId: 'injected source' }, { config: binding.file }]) {
    await assert.rejects(installHost({ ...options, ...extra }));
  }
  const linked = join(f.directory, 'linked.json');
  await link(config, linked);
  await assert.rejects(installHost({ ...options, config: linked }), /regular/);
  await unlink(linked);
  // File symlink creation on Windows may require developer mode. Junctions do
  // not, so exercise the redirected parent there as well.
  if (process.platform !== 'win32') {
    await symlink(config, linked);
    await assert.rejects(installHost({ ...options, config: linked }), /regular/);
  } else {
    const alias = join(f.directory, 'junction');
    await symlink(join(f.directory, 'Antigravity'), alias, 'junction');
    await assert.rejects(installHost({ ...options, config: join(alias, 'mcp.json') }), /symlink or junction/);
    await assert.rejects(installHost({ ...options, config: join(alias, 'must-not-create', 'mcp.json') }), /symlink or junction/);
    await assert.rejects(lstat(join(f.directory, 'Antigravity', 'must-not-create')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(config, 'utf8'), initial);
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.pending')).length, 0);
});

test('installer CLI registers explicit configuration and rejects secret-bearing parser errors without echoing them', { timeout: 30_000 }, async t => {
  const f = await setupService(t);
  const binding = await pairing(f, 'Antigravity');
  const config = join(f.directory, 'local host.json');
  const result = await command(installer, ['--host', 'antigravity', '--config', config, '--binding', binding.file, '--workspace', f.directory]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).config, config);
  assert.ok(!result.stdout.includes(binding.token));
  const installed = await readFile(config, 'utf8');
  const invalid = await command(installer, ['--accidental-token', binding.token]);
  assert.equal(invalid.code, 1);
  assert.ok(!invalid.stderr.includes(binding.token));
  assert.equal(await readFile(config, 'utf8'), installed);
});

test('installer detects concurrent external edits before replacing the selected file', { timeout: 20_000 }, async t => {
  const f = await setupService(t);
  const binding = await pairing(f, 'Antigravity');
  const source = await f.invoke('source.create', 'source-for-race', { kind: 'setting', title: 'Race source', body: 'content' });
  const config = join(f.directory, 'race.json');
  await writeFile(config, '{}');
  const external = '{"externalEdit":"must survive"}';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith('/invoke')) await writeFile(config, external);
    return response;
  };
  try {
    await assert.rejects(installHost({ host: 'antigravity', config, binding: binding.file,
      workspace: f.directory, sourceId: source.sourceId }), /changed during installation/);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(await readFile(config, 'utf8'), external);
  assert.ok(!(await readdir(f.directory)).some(name => name.endsWith('.pending') || name.endsWith('.sth-install-lock')));
});

test('CLI timeout closes the owned process tree and inherited stdio handles', { timeout: 10_000 }, async () => {
  const script = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit',windowsHide:true}); setTimeout(()=>{},30000)";
  const started = Date.now();
  const result = await runHost({ command: process.execPath, args: [] }, ['-e', script], { timeout: 250 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 8_000);
});
