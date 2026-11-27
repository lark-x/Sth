import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { openBinding, restrictWindowsPath } from './credentials.mjs';
import { request } from './http.mjs';
import { detectHost, prepareProfile, runHost } from './host-process.mjs';
import { updateAntigravityConfig } from './host-json.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));

function absolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Supply an absolute local ${name} path.`);
  }
  return resolve(value);
}

async function configuration(path) {
  let state;
  try { state = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!state) return { text: undefined, state };
  if (!state.isFile() || state.nlink !== 1 || state.size > 2_000_000) throw new Error('The configuration must be a regular, unlinked file smaller than 2 MB.');
  return { text: await readFile(path, 'utf8'), state };
}

function matchingCodex(server, entry) {
  return server?.enabled === true && server.transport?.type === 'stdio'
    && server.transport.command === entry.command && isDeepStrictEqual(server.transport.args, entry.args)
    && !server.transport.cwd && !Object.keys(server.transport.env || {}).length && !(server.transport.env_vars || []).length
    && !server.startup_timeout_sec && !server.tool_timeout_sec;
}

async function codexConfig(text, name, entry, replace, scratch, executable) {
  const env = await prepareProfile(scratch);
  const host = await detectHost('codex', { executable, env, cwd: scratch });
  if (!host.available) throw new Error('Codex CLI was not found. Supply --executable with its installed launcher.');
  const staged = join(env.CODEX_HOME, 'config.toml');
  if (text !== undefined) await writeFile(staged, text, { mode: 0o600 });
  async function list() {
    const result = await runHost(host.launcher, ['mcp', 'list', '--json'], { env, cwd: scratch });
    if (result.code !== 0) throw new Error('Codex could not parse the selected configuration. No configuration was installed.');
    try {
      const value = JSON.parse(result.stdout);
      if (!Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new Error('Codex returned an invalid MCP server list.'); }
  }
  const before = await list();
  const previous = before.find(server => server.name === name);
  if (matchingCodex(previous, entry)) return text;
  if (previous && !replace) throw new Error('The selected MCP entry already exists. Review it and pass --replace to change it.');
  const added = await runHost(host.launcher, ['mcp', 'add', name, '--', entry.command, ...entry.args], { env, cwd: scratch });
  if (added.code !== 0) throw new Error('Codex could not register the selected MCP entry.');
  const after = await list();
  if (!matchingCodex(after.find(server => server.name === name), entry)
      || !isDeepStrictEqual(before.filter(server => server.name !== name), after.filter(server => server.name !== name))) {
    throw new Error('Codex changed an unrelated MCP entry. No configuration was installed.');
  }
  return readFile(staged, 'utf8');
}

async function preservePermissions(from, to, state) {
  if (process.platform !== 'win32' || !state) return;
  const script = '$ErrorActionPreference="Stop"; [IO.File]::SetAccessControl($env:STH_HOST_ACL_TO,[IO.File]::GetAccessControl($env:STH_HOST_ACL_FROM))';
  const command = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await runHost({ command, args: [] }, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, STH_HOST_ACL_FROM: from, STH_HOST_ACL_TO: to },
  });
  if (result.code !== 0) throw new Error('Could not preserve the configuration ACL.');
}

export async function installHost({ host, config, binding, workspace, sourceId, name = 'sth-personal', replace = false, executable }) {
  if (!['codex', 'antigravity'].includes(host)) throw new Error('Host must be codex or antigravity.');
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Use an MCP name of 1 to 64 letters, digits, underscores or hyphens.');
  config = absolute(config, 'configuration');
  binding = absolute(binding, 'binding');
  workspace = await realpath(absolute(workspace, 'workspace'));
  if (!(await lstat(workspace)).isDirectory()) throw new Error('The workspace must be a local directory.');
  if (sourceId !== undefined && (typeof sourceId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(sourceId))) throw new Error('Supply a valid selected source ID.');
  const credential = await openBinding(binding);
  if (config.toLowerCase() === (await realpath(binding)).toLowerCase() || config.toLowerCase() === cli.toLowerCase()) {
    throw new Error('The configuration must be separate from the credential and server files.');
  }
  const entry = { command: await realpath(process.execPath), args: [cli, 'stdio', binding, '--workspace', workspace,
    ...(sourceId ? ['--source-id', sourceId] : [])] };
  await mkdir(dirname(config), { recursive: true });
  // Reject redirected directories as well as symlink files. This also prevents
  // aliases from bypassing the per-target lock.
  if ((await realpath(dirname(config))).toLowerCase() !== dirname(config).toLowerCase()) {
    throw new Error('Use the real configuration directory, without symlink or junction ancestors.');
  }
  const lock = `${config}.sth-install-lock`;
  let handle;
  try { handle = await open(lock, 'wx', 0o600); } catch { throw new Error('The selected configuration is locked by another installation.'); }
  let scratch;
  let staged;
  try {
    const before = await configuration(config);
    scratch = await mkdtemp(join(tmpdir(), 'sth-host-config-'));
    restrictWindowsPath(scratch, true);
    if (host === 'antigravity' && executable) {
      const env = await prepareProfile(scratch);
      const detected = await detectHost(host, { executable, env, cwd: scratch });
      if (!detected.available) throw new Error('Antigravity CLI was not found at the selected executable path.');
    }
    const next = host === 'antigravity' ? updateAntigravityConfig(before.text ?? '{}\n', name, entry, replace)
      : await codexConfig(before.text, name, entry, replace, scratch, executable);
    if (sourceId) {
      const result = await request(credential.origin, 'invoke', {
        operationId: 'source.read', stepId: `sth.mcp.v1:host-select:${randomUUID()}`, input: { sourceId },
      }, credential.token);
      if (result.status !== 200 || result.value.result?.sourceId !== sourceId) throw new Error('The selected Sth source could not be read with this pairing.');
    }
    if (before.text === next) return { host, config, name, changed: false, workspace, ...(sourceId ? { sourceId } : {}) };
    staged = join(dirname(config), `.sth-host-${randomUUID()}.pending`);
    const file = await open(staged, 'wx', before.state ? before.state.mode & 0o777 : 0o600);
    await file.close();
    restrictWindowsPath(staged);
    await writeFile(staged, next);
    await preservePermissions(config, staged, before.state);
    const current = await configuration(config);
    if (current.text !== before.text || current.state?.ino !== before.state?.ino || current.state?.mtimeMs !== before.state?.mtimeMs) {
      throw new Error('The selected configuration changed during installation. Retry after reviewing it.');
    }
    await rename(staged, config);
    staged = undefined;
    return { host, config, name, changed: true, workspace, ...(sourceId ? { sourceId } : {}) };
  } finally {
    if (staged) await unlink(staged).catch(() => {});
    if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    await handle.close();
    await unlink(lock);
  }
}
