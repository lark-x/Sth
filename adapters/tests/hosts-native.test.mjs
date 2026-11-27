import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { detectHost, hostProfile, runHost } from '../mcp/host-process.mjs';
import { antigravityAuthStatus } from '../mcp/host-probe.mjs';
import { installHost } from '../mcp/hosts.mjs';
import { setupService } from './service-fixture.mjs';

const cli = fileURLToPath(new URL('../mcp/cli.mjs', import.meta.url));

for (const [host, executable] of [['antigravity', process.env.STH_TEST_AGY], ['codex', process.env.STH_TEST_CODEX]]) {
  test(`installed ${host} CLI reads an isolated config whose stdio command round-trips Sth`, {
    skip: !executable && `Set ${host === 'codex' ? 'STH_TEST_CODEX' : 'STH_TEST_AGY'} to the real installed CLI`, timeout: 90_000,
  }, async t => {
    const f = await setupService(t);
    const env = await hostProfile(join(f.directory, 'isolated-profile'), host);
    const workspace = join(env.HOME, 'workspace with 中文 spaces');
    await mkdir(workspace);
    const detected = await detectHost(host, { executable, env, cwd: workspace });
    assert.equal(detected.available, true);
    t.diagnostic(`${host} native version ${detected.version}`);
    const paired = await runHost({ command: process.execPath, args: [cli] }, ['pair', join(f.directory, 'binding'), '--client-name', `Sth ${host}`], {
      env: { ...env, STH_PERSONAL_OPERATIONS_ORIGIN: f.origin }, cwd: workspace, input: `${await f.code()}\n`,
    });
    assert.equal(paired.code, 0, paired.stderr);
    const { file } = JSON.parse(paired.stdout);
    const source = await f.invoke('source.create', 'web-create', { kind: 'setting', title: 'Native host shared source', body: '真实配置的本地源。' });
    const config = host === 'codex' ? join(env.CODEX_HOME, 'config.toml') : join(env.HOME, '.gemini', 'config', 'mcp_config.json');
    if (host === 'antigravity') {
      const add = await runHost(detected.launcher, ['mcp', 'add', 'keep-native', process.execPath], { env, cwd: workspace });
      assert.equal(add.code, 0, add.stderr);
    } else {
      await writeFile(config, '# Keep this comment and unrelated settings\nmodel = "test-model-preserved"\n\n[mcp_servers.keep-native]\ncommand = "keep"\nargs = ["unchanged"]\n');
    }
    const before = await readFile(config, 'utf8');
    const options = { host, executable, config, binding: file, workspace, sourceId: source.sourceId, name: 'sth-native' };
    assert.equal((await installHost(options)).changed, true);
    const installed = await readFile(config, 'utf8');
    assert.equal((await installHost(options)).changed, false);
    assert.equal(await readFile(config, 'utf8'), installed);
    assert.equal(f.calls.filter(item => item.action === 'claim').length, 1);
    const listing = await runHost(detected.launcher, ['mcp', 'list', ...(host === 'codex' ? ['--json'] : [])], { env, cwd: workspace });
    assert.equal(listing.code, 0, listing.stderr);
    assert.ok(listing.stdout.includes('sth-native'));
    assert.ok(listing.stdout.includes('keep-native'));
    let entry;
    if (host === 'codex') {
      const transport = JSON.parse(listing.stdout).find(item => item.name === 'sth-native').transport;
      entry = { command: transport.command, args: transport.args };
      assert.ok(installed.includes('# Keep this comment and unrelated settings'));
      assert.ok(installed.includes('model = "test-model-preserved"'));
    } else {
      const value = JSON.parse(installed);
      entry = value.mcpServers['sth-native'];
      assert.deepEqual(value.mcpServers['keep-native'], JSON.parse(before).mcpServers['keep-native']);
      // A separate workspace file uses a distinct server name. Some CLI builds
      // list only global definitions in `mcp list`; report the actual behavior.
      const workspaceConfig = join(workspace, '.agents', 'mcp_config.json');
      await installHost({ ...options, config: workspaceConfig, name: 'sth-workspace' });
      const localList = await runHost(detected.launcher, ['mcp', 'list'], { env, cwd: workspace });
      assert.equal(localList.code, 0, localList.stderr);
      t.diagnostic(`mcp list includes workspace entry ${localList.stdout.includes('sth-workspace')}`);
      const auth = await antigravityAuthStatus(detected.launcher, { env, cwd: workspace });
      assert.equal(auth.status, 'authentication_required', JSON.stringify(auth));
      assert.equal(auth.error.code, -32000);
      t.diagnostic(`isolated ACP ${auth.error.code} ${auth.error.message}`);
    }
    const client = new Client({ name: 'sth-native-config-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ ...entry, env, cwd: workspace, stderr: 'pipe' });
    let stderr = '';
    transport.stderr.on('data', chunk => { stderr += chunk; });
    try {
      await client.connect(transport, { timeout: 5_000 });
      assert.equal(client.getServerVersion().name, 'sth-personal-mcp');
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 3);
      assert.ok(tools.tools[0].description.includes(source.sourceId));
      const result = await client.callTool({ name: 'sth_personal_invoke', arguments: {
        operationId: 'source.read', stepId: 'native-read', input: { sourceId: source.sourceId },
      } });
      assert.deepEqual(result.structuredContent.result, source);
    } catch (error) {
      throw new Error(`${error.message} ${stderr}`);
    } finally {
      await client.close();
    }
    await assert.rejects(installHost({ ...options, sourceId: undefined }), /--replace/);
    assert.equal((await installHost({ ...options, sourceId: undefined, replace: true })).changed, true);
    assert.equal((await installHost({ ...options, sourceId: undefined })).changed, false);
  });
}
