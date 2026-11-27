import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createPrivateDirectory } from './credentials.mjs';

export function absoluteLocalPath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
      || (process.platform === 'win32' && /^[\\/]{2}/.test(value) && !/^\\\\\?\\[a-z]:\\/i.test(value))) {
    throw new Error(`Supply an absolute local ${name} path.`);
  }
  return resolve(value);
}

// Deliberately exclude account keys, provider overrides, remote-agent sockets and
// the caller's host settings. Proxy variables carry network routing only.
export function isolatedEnvironment(root, inherited = process.env) {
  root = absoluteLocalPath(root, 'isolated profile');
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|TEMP|TMP|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)));
  const home = join(root, 'home');
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(root, 'codex'),
    // HOME alone does not isolate the Windows credential manager. These switches
    // are present and behavior-tested in Google's signed agy 1.5.18 binary.
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1', ANTIGRAVITY_CREDENTIAL_SCOPE: `sth-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`,
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
  };
}

export async function hostProfile(root, host) {
  root = absoluteLocalPath(root, 'dedicated profile');
  if (!['codex', 'antigravity'].includes(host)) throw new Error('Supply a supported host.');
  const marker = join(root, '.sth-agent-host-profile.json');
  try {
    await createPrivateDirectory(root);
    await writeFile(marker, JSON.stringify({ version: 1, host }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let value;
    try { value = JSON.parse(await readFile(marker, 'utf8')); } catch { throw new Error('An existing profile requires its Sth isolation marker. Use a new directory.'); }
    if (value.version !== 1 || value.host !== host) throw new Error('This profile belongs to a different host or format.');
  }
  return prepareProfile(root);
}

export async function prepareProfile(root) {
  const env = isolatedEnvironment(resolve(root));
  for (const directory of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.CODEX_HOME]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return env;
}

export async function stopHostProcess(child) {
  if (child.pid && child.exitCode === null) {
    if (process.platform === 'win32') {
      // agy ACP starts a language-server child. Killing only its parent leaves
      // that child holding stdio handles and workspace directories open.
      await new Promise(done => {
        const killer = spawn(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, shell: false, stdio: 'ignore',
        });
        const timer = setTimeout(() => { killer.kill(); done(); }, 5_000);
        killer.once('error', () => { clearTimeout(timer); done(); });
        killer.once('close', () => { clearTimeout(timer); done(); });
      });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
    }
    if (child.exitCode === null) child.kill();
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export function runHost(launcher, args, { env, cwd, input, timeout = 15_000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(launcher.command, [...launcher.args, ...args], {
      env, cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let oversized = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void stopHostProcess(child); }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length <= 2_000_000) return;
      stdout = stdout.slice(0, 2_000_000);
      if (!oversized) { oversized = true; void stopHostProcess(child); }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length <= 2_000_000) return;
      stderr = stderr.slice(0, 2_000_000);
      if (!oversized) { oversized = true; void stopHostProcess(child); }
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('Could not execute the host CLI. Supply its native executable path.')); });
    child.once('close', code => { clearTimeout(timer); done({ code, stdout, stderr, timedOut, oversized }); });
    child.stdin.end(input);
  });
}

async function regularFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function launcherFor(host, file) {
  if (!await regularFile(file)) return;
  const path = await realpath(file);
  if (host === 'codex' && /\.(cmd|ps1)$/i.test(path)) {
    // npm's official Windows shim cannot be execFile'd. Run its JavaScript
    // entrypoint with Node, preserving argv without invoking cmd.exe.
    const script = join(dirname(path), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (await regularFile(script)) return { command: process.execPath, args: [script], path };
    throw new Error('Supply codex.exe or the official npm Codex launcher.');
  }
  if (/\.(cmd|bat|ps1)$/i.test(path)) throw new Error('Supply the native host executable, not a shell wrapper.');
  if (host === 'codex' && /\.m?js$/i.test(path)) return { command: process.execPath, args: [path], path };
  return { command: path, args: [], path };
}

export async function detectHost(host, { executable, env = process.env, cwd } = {}) {
  if (!['codex', 'antigravity'].includes(host)) throw new Error('Host must be codex or antigravity.');
  const names = host === 'codex' ? (process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'])
    : (process.platform === 'win32' ? ['agy.exe'] : ['agy']);
  const candidates = executable ? [resolve(executable)] : (env.PATH || env.Path || '').split(delimiter)
    .filter(Boolean).flatMap(directory => names.map(name => join(directory, name)));
  if (!executable && host === 'antigravity') {
    candidates.push(join(process.env.LOCALAPPDATA || join(process.env.HOME || '', '.local'), 'agy', 'bin', names[0]));
    candidates.push(join(process.env.HOME || process.env.USERPROFILE || '', '.local', 'bin', names[0]));
  }
  for (const candidate of candidates) {
    // The desktop Electron application is not the standalone agent CLI.
    if (/antigravity(?:\.exe)?$/i.test(candidate.split(/[\\/]/).at(-1))) continue;
    const launcher = await launcherFor(host, candidate);
    if (!launcher) continue;
    const version = await runHost(launcher, ['--version'], { env, cwd });
    const help = await runHost(launcher, ['--help'], { env, cwd });
    const helpText = help.stdout + help.stderr;
    const capable = host === 'antigravity' ? /\bacp\b/.test(helpText) && /--settings/.test(helpText) && /\bmcp\b/.test(helpText)
      : /\bmcp\b/.test(helpText) && /\bexec\b/.test(helpText);
    if (version.code !== 0 || help.code !== 0 || !capable) throw new Error('The executable is not a supported agent CLI.');
    return { available: true, host, version: version.stdout.trim(), launcher };
  }
  let desktop;
  if (host === 'antigravity' && process.platform === 'win32') {
    for (const directory of [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles].filter(Boolean)) {
      const path = join(directory, 'Antigravity', 'Antigravity.exe');
      try { await access(path); desktop = path; break; } catch { /* absent */ }
    }
  }
  return { available: false, host, ...(desktop ? { desktop } : {}), reason: executable ? 'cli_not_supported_or_missing' : 'cli_not_found' };
}
