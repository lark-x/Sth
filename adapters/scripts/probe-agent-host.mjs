#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { detectHost, hostProfile, runHost } from '../mcp/host-process.mjs';
import { antigravityAuthStatus } from '../mcp/host-probe.mjs';

try {
  const { values } = parseArgs({ options: { host: { type: 'string' }, profile: { type: 'string' }, executable: { type: 'string' } } });
  const env = await hostProfile(values.profile || '', values.host);
  const cwd = join(env.HOME, 'workspace');
  await mkdir(cwd, { recursive: true });
  const host = await detectHost(values.host, { executable: values.executable, env, cwd });
  if (!host.available) {
    process.stdout.write(JSON.stringify(host) + '\n');
    process.exitCode = 2;
  } else {
    const listing = await runHost(host.launcher, ['mcp', 'list', ...(values.host === 'codex' ? ['--json'] : [])], { env, cwd });
    const auth = values.host === 'antigravity' ? await antigravityAuthStatus(host.launcher, { env, cwd }) : undefined;
    process.stdout.write(JSON.stringify({ host: host.host, version: host.version, executable: host.launcher.path,
      configList: { code: listing.code, output: listing.stdout.trim() }, ...(auth ? { auth } : {}),
      profile: values.profile, workspace: cwd }) + '\n');
    if (listing.code !== 0 || (auth && auth.status !== 'authentication_required')) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.code?.startsWith('ERR_PARSE_ARGS') ? 'Invalid probe arguments.' : error.message}\n`);
  process.exitCode = 1;
}
