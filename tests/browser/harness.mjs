import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const artifacts = join(import.meta.dirname, '.artifacts');

export async function startService(t) {
  const tempRoot = resolve(tmpdir());
  const dataDir = await mkdtemp(join(tempRoot, 'sth-browser-'));
  const server = spawn(process.execPath, ['src/main.ts'], {
    cwd: root,
    env: {
      ...process.env,
      STH_PORT: '0',
      STH_DATA_DIR: dataDir,
      STH_PUBLIC_ORIGIN: '',
      STH_WEB_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let stdout = '';
  let closed = false;
  let startError;
  const serverClosed = new Promise((resolve) => {
    server.once('close', () => {
      closed = true;
      resolve();
    });
  });
  server.once('error', (error) => { startError = error; });
  server.stdout.setEncoding('utf8').on('data', (text) => {
    stdout = (stdout + text).slice(-5000);
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8').on('data', (text) => {
      output = (output + text).slice(-5000);
    });
  }
  t.after(async () => {
    if (!closed) server.kill();
    await serverClosed;
    assert.equal(dirname(resolve(dataDir)), tempRoot);
    assert.match(basename(dataDir), /^sth-browser-[a-z0-9]+$/i);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const deadline = Date.now() + 15_000;
  while (!startError && !closed && server.exitCode === null && Date.now() < deadline) {
    const origin = stdout.match(/^Sth ready at (http:\/\/127\.0\.0\.1:\d+)\r?\n/m)?.[1];
    if (origin) {
      const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null);
      if (health?.name === 'Sth' && health.status === 'ok' && !closed && server.exitCode === null) return origin;
    }
    await delay(100);
  }
  throw new Error(`The isolated Sth service did not become healthy.\n${startError ?? ''}\n${output}`);
}

export async function openBrowser(t, origin, viewport) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ baseURL: origin, viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.setDefaultNavigationTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
  return page;
}

export async function screenshot(page, viewport, name) {
  if (process.env.STH_BROWSER_ARTIFACTS !== '1') return;
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: join(artifacts, `${viewport}-${name}.png`), animations: 'disabled' });
}

export async function assertFitsViewport(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert.equal(dimensions.viewport, page.viewportSize().width, 'page uses the configured viewport width');
  assert.ok(dimensions.content <= dimensions.viewport + 1,
    `page content is ${dimensions.content}px wide in a ${dimensions.viewport}px viewport`);
}
