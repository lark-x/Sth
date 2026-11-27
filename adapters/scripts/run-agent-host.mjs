#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { detectHost, hostProfile } from '../mcp/host-process.mjs';

try {
  const divider = process.argv.indexOf('--');
  if (divider < 0) throw new Error('Supply --host HOST --profile ABSOLUTE_DIRECTORY [--executable CLI] -- HOST_ARGUMENTS.');
  const { values } = parseArgs({ args: process.argv.slice(2, divider), options: {
    host: { type: 'string' }, profile: { type: 'string' }, executable: { type: 'string' }, workspace: { type: 'string' },
  } });
  const env = await hostProfile(values.profile || '', values.host);
  let cwd = join(env.HOME, 'workspace');
  if (values.workspace) {
    if (!isAbsolute(values.workspace) || !(await stat(values.workspace)).isDirectory()) throw new Error('Supply an absolute local workspace directory.');
    cwd = await realpath(values.workspace);
  } else await mkdir(cwd, { recursive: true });
  const host = await detectHost(values.host, { executable: values.executable, env, cwd });
  if (!host.available) throw new Error('The native agent CLI is unavailable. Run probe-agent-host.mjs for detection details.');
  const child = spawn(host.launcher.command, [...host.launcher.args, ...process.argv.slice(divider + 1)], {
    env, cwd, windowsHide: true, shell: false, stdio: 'inherit',
  });
  child.once('error', () => { process.stderr.write('Could not launch the isolated host CLI.\n'); process.exitCode = 1; });
  child.once('close', code => { process.exitCode = code ?? 1; });
} catch (error) {
  process.stderr.write(`${error.code?.startsWith('ERR_PARSE_ARGS') ? 'Invalid host launcher arguments.' : error.message}\n`);
  process.exitCode = 1;
}
