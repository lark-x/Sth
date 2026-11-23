import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { request, serviceOrigin } from './http.mjs';

function base64url(value, length) {
  return typeof value === 'string' && value.length === length && !/[^A-Za-z0-9_-]/.test(value);
}

async function createPrivateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  if (process.platform !== 'win32') return;
  try {
    const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = identity.match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new Error('Missing account SID.');
    execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
  } catch {
    throw new Error('Could not restrict the pairing directory to the Windows account.');
  }
}

function accessibleByOthers(state) {
  return process.platform !== 'win32' && (state.uid !== process.getuid() || (state.mode & 0o077) !== 0);
}

export async function openBinding(path) {
  if (!path) {
    const token = process.env.STH_PERSONAL_OPERATIONS_TOKEN;
    if (!base64url(token, 43)) throw new Error('Supply a binding file or set STH_PERSONAL_OPERATIONS_TOKEN.');
    return { origin: serviceOrigin(), token };
  }
  const file = resolve(path);
  const [parent, state] = await Promise.all([lstat(dirname(file)), lstat(file)]).catch(() => []);
  if (!parent?.isDirectory() || !state?.isFile() || state.size > 16384
      || accessibleByOthers(parent) || accessibleByOthers(state)) {
    throw new Error('Read the credential from a regular file in a private pairing directory.');
  }
  let binding;
  try {
    binding = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error('Could not read the Sth pairing file.');
  }
  if (typeof binding?.origin !== 'string' || !base64url(binding.token, 43)) {
    throw new Error('The pairing file requires an Sth origin and token.');
  }
  return { origin: serviceOrigin(binding.origin), token: binding.token };
}

export async function pair(path) {
  if (process.stdin.isTTY) throw new Error('Provide the one-time Sth code as one line on stdin.');
  const origin = serviceOrigin();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const { value: code } = await lines[Symbol.asyncIterator]().next();
  lines.close();
  if (!base64url(code, 22)) throw new Error('Provide a valid one-time Sth code on stdin.');

  const directory = resolve(path);
  await createPrivateDirectory(directory);
  let claim;
  try {
    claim = await request(origin, 'claim', { code, clientName: 'Sth MCP' });
  } catch {
    throw new Error('Sth could not redeem the connection code.');
  }
  if (claim.status < 200 || claim.status >= 300) throw new Error('Sth could not redeem the connection code.');
  const { token, connectionId } = claim.value;
  if (!base64url(token, 43) || typeof connectionId !== 'string' || connectionId.length < 1
      || connectionId.length > 512 || /[\x00-\x1f\x7f]/.test(connectionId)) {
    throw new Error('Sth returned an invalid personal connection.');
  }
  const safeId = connectionId.replaceAll(token, '[redacted]').replaceAll(code, '[redacted]');
  const file = join(directory, 'personal-connection.json');
  const staged = join(directory, '.pending-connection');
  try {
    await writeFile(staged, JSON.stringify({ origin, connectionId, token }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(staged, file);
  } catch {
    await unlink(staged).catch(() => {});
    throw new Error(`Could not store the credential. Revoke connection ${JSON.stringify(safeId)} in Sth.`);
  }
  return { connectionId: safeId, file };
}
