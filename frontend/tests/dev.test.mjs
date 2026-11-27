import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { openBrowser, startService } from '../../tests/browser/harness.mjs';
import { pairPersonalClient } from '../../tests/browser/personal-api.mjs';

test('Vite development entry writes through the guarded API and proxies media ranges', { timeout: 40_000 }, async t => {
  const backend = await startService(t);
  const api = await pairPersonalClient(backend);
  const cache = await mkdtemp(join(tmpdir(), 'sth-shell-vite-'));
  const previousOrigin = process.env.STH_DEV_API_ORIGIN;
  process.env.STH_DEV_API_ORIGIN = backend;
  let vite;
  try {
    vite = await createServer({
      configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
      cacheDir: cache,
      logLevel: 'error',
      server: { host: '127.0.0.1', strictPort: false },
    });
  } finally {
    if (previousOrigin === undefined) delete process.env.STH_DEV_API_ORIGIN;
    else process.env.STH_DEV_API_ORIGIN = previousOrigin;
  }
  t.after(async () => { await vite.close(); await rm(cache, { recursive: true, force: true }); });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const page = await openBrowser(t, origin, { width: 1280, height: 900 });
  await page.goto('/');
  await page.getByLabel('此刻想记下什么', { exact: true }).fill('通过 Vite 保存的记录');
  await page.getByRole('button', { name: '记下来', exact: true }).click();
  await page.waitForURL(/\/diaries\/[a-f0-9-]+$/);
  await page.getByRole('heading', { name: '通过 Vite 保存的记录', exact: true }).waitFor();
  assert.equal((await api.invoke('diary.list', {})).items.length, 1);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ4sAAAAASUVORK5CYII=', 'base64');
  const asset = await api.invoke('asset.import', { contentType: 'image/png', name: '媒体回归.png', data: png.toString('base64') });
  const imageResponse = await fetch(`${origin}${asset.href}`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  const range = await fetch(`${origin}${asset.href}`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(0, 8));
  assert.equal((await fetch(`${origin}${asset.href}`, { method: 'HEAD' })).headers.get('content-length'), String(png.length));

  const attack = await fetch(`${origin}/api/web/invoke`, {
    method: 'POST', headers: { Origin: 'https://foreign.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationId: 'diary.list', stepId: 'foreign', input: {} }),
  });
  assert.equal(attack.status, 403);
});
