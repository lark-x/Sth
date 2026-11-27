import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { openDatabase } from '../../src/database.ts';
import { createApp } from '../../src/server.ts';
import { assertFitsViewport } from '../../tests/browser/harness.mjs';
import { installCommand } from '../connections/install.ts';
import { matchesConnectionsRoute } from '../connections/routes.ts';

const root = resolve(import.meta.dirname, '../..');
const desktop = { width: 1280, height: 900 };
const mobile = { width: 320, height: 800 };
const timeout = 40_000;
const defaults = {
  host: 'codex', origin: 'http://127.0.0.1:19321', repository: 'F:\\Sth 本地',
  profile: 'C:\\Sth 测试\\profiles\\author', distribution: 'C:\\Sth 测试\\plugin-new',
  bindingDirectory: 'C:\\Sth 测试\\pair-new', config: 'C:\\Sth 测试\\codex\\config.toml',
  workspace: 'F:\\写作空间', executable: '', binaryDirectory: '',
};

// Mount the domain directly until the coordinating agent registers it in the
// shared shell. Vite's dependency cache, SQLite and all grants are temporary.
async function fixture(t, { viewport = desktop, protectedOwner = false, fallbackClipboard = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sth-connections-'));
  const db = openDatabase(join(directory, 'data'));
  const password = randomUUID();
  const api = createApp(db, protectedOwner ? { publicOrigin: 'https://sth-connections.test', webPassword: password } : {});
  let vite;
  let web;
  let browser;
  t.after(async () => {
    await browser?.close();
    web?.closeAllConnections();
    if (web) await new Promise(done => web.close(done));
    await vite?.close();
    api.closeAllConnections();
    await new Promise(done => api.close(done));
    db.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.match(basename(directory), /^sth-connections-[a-z0-9]+$/i);
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  await new Promise(done => api.listen(0, '127.0.0.1', done));
  const backend = `http://127.0.0.1:${api.address().port}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/web/assets/notebook.css"><link rel="stylesheet" href="/frontend/styles.css"></head><body><div id="app"></div><script type="module">
    import { createApp, h, shallowRef } from 'vue';
    import ConnectionsRoute from '/frontend/connections/ConnectionsRoute.vue';
    import { matchesConnectionsRoute } from '/frontend/connections/routes.ts';
    createApp({ setup() {
      const url = shallowRef(new URL(location.href));
      const refresh = shallowRef(0);
      function navigate(href) { history.pushState(null, '', href); url.value = new URL(location.href); }
      addEventListener('popstate', () => { url.value = new URL(location.href); });
      window.connectionsTestNavigate = navigate;
      return () => h('div', { class: 'sth-app' }, h('div', { class: 'shell sth-shell' }, [
        h('header', { class: 'sidebar sth-sidebar' }, [h('a', { class: 'brand', href: '/' }, 'Sth'), h('nav', { 'aria-label': '应用设置' }, [h('a', { href: '/settings', onClick: e => { e.preventDefault(); navigate('/settings'); } }, '设置')])]),
        h('main', { id: 'main' }, [matchesConnectionsRoute(url.value)
          ? h(ConnectionsRoute, { key: refresh.value, url: url.value, onNavigate: navigate, onRefresh: () => refresh.value++ })
          : h('h1', {}, '交给其他路由')])
      ]));
    }}).mount('#app');
  </script></body></html>`;
  vite = await createViteServer({
    root, configFile: false, cacheDir: join(directory, 'vite-cache'), logLevel: 'error',
    plugins: [vue(), {
      name: 'connections-domain-test',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.headers.accept?.includes('text/html')) return next();
          try {
            response.setHeader('Content-Type', 'text/html');
            response.end(await server.transformIndexHtml(request.url, html));
          } catch (error) { next(error); }
        });
      },
    }],
    server: { middlewareMode: true, hmr: false, proxy: { '/api': {
      target: backend, changeOrigin: true,
      configure(proxy) {
        proxy.on('proxyReq', request => request.setHeader('Origin', backend));
      },
    } } },
    optimizeDeps: { noDiscovery: true, include: ['vue'] },
  });
  web = createHttpServer(vite.middlewares);
  await new Promise(done => web.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${web.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: origin, viewport,
    ...(protectedOwner ? { httpCredentials: { username: 'sth', password } } : {}),
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  if (fallbackClipboard) await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { get() { return undefined; } });
    // Exercise the feature-detected click path as well as the native path.
    delete window.CommandEvent;
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  const offsite = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== origin) offsite.push(request.url()); });
  t.after(() => {
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.deepEqual(offsite, [], 'no external assets, logins or host-service calls');
  });
  return { page, origin, backend };
}

async function capture(page, name) {
  const directory = process.env.STH_CONNECTIONS_ARTIFACTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true, animations: 'disabled' });
}

const pairing = page => page.getByRole('region', { name: '配对码', exact: true });
const records = page => page.getByRole('region', { name: '连接记录', exact: true });

async function generate(page) {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/web/connections/code'),
    pairing(page).getByRole('button', { name: '生成配对码', exact: true }).click(),
  ]);
  assert.equal(response.status(), 200);
  assert.deepEqual(response.request().postDataJSON(), {});
  const result = await response.json();
  await pairing(page).getByText(`sth personal connect ${result.code}`, { exact: true }).waitFor();
  return result.code;
}

async function claim(backend, code, clientName) {
  const response = await fetch(`${backend}/api/v1/personal-operations/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, clientName }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('connections register only the two settings routes, preserving query strings and other settings domains', () => {
  for (const path of ['/settings', '/settings/', '/settings?from=diary#help', '/settings/connections', '/settings/connections/?tab=history']) {
    assert.equal(matchesConnectionsRoute(new URL(path, defaults.origin)), true, path);
  }
  for (const path of ['/', '/settings/providers', '/settings/models', '/settings/connections/new', '/settings/connections-extra', '/settings//connections', '/other/settings', '/settings%2Fconnections']) {
    assert.equal(matchesConnectionsRoute(new URL(path, defaults.origin)), false, path);
  }
});

test('installation commands follow adapter entrypoints, quote paths, and carry no connection code or replacement flags', async () => {
  const installer = await readFile(join(root, 'adapters/scripts/install-agent-host.mjs'), 'utf8');
  const native = await readFile(join(root, 'adapters/hermes_plugin/native.py'), 'utf8');
  const packagePlugin = await readFile(join(root, 'adapters/hermes_plugin/package_plugin.py'), 'utf8');
  const pairingCli = await readFile(join(root, 'adapters/mcp/cli.mjs'), 'utf8');
  const hermesTest = await readFile(join(root, 'adapters/tests/hermes_onboarding.py'), 'utf8');
  assert.match(pairingCli, /positionals\[0\] === 'pair'/);
  assert.match(packagePlugin, /add_argument\("destination"/);
  assert.match(native, /add_parser\("connect"/);
  assert.match(hermesTest, /cli\("plugins", "install", distribution\["installIdentifier"\], "--enable"/);
  for (const flag of ['host', 'config', 'binding', 'workspace', 'executable']) assert.match(installer, new RegExp(`${flag}: \\{ type: 'string' \\}`));
  for (const host of ['hermes', 'codex', 'antigravity']) {
    const { command, error } = installCommand({ ...defaults, host, repository: "F:\\Sth's $data` local", executable: 'C:\\CLI\\codex.cmd', binaryDirectory: 'C:\\CLI\\agy-new' });
    assert.equal(error, '');
    assert.ok(command.startsWith("$ErrorActionPreference = 'Stop'"));
    assert.ok(command.includes("Set-Location -LiteralPath 'F:\\Sth''s $data` local'"));
    assert.match(command, /\$env:STH_PERSONAL_OPERATIONS_ORIGIN = 'http:\/\/127\.0\.0\.1:19321'/);
    assert.doesNotMatch(command, /--replace|STH_PERSONAL_OPERATIONS_TOKEN|STH_WEB_PASSWORD|9322|sth personal connect /);
    if (host === 'hermes') {
      assert.match(command, /hermes plugins install \$package.installIdentifier --enable/);
      assert.match(command, /hermes sth connect --origin 'http:\/\/127\.0\.0\.1:19321'/);
      assert.match(command, /hermes sth status/);
    } else {
      assert.match(command, /Read-Host -MaskInput/);
      assert.match(command, /node adapters\/mcp\/cli\.mjs pair \$bindingDirectory --client-name/);
      assert.ok(command.includes(`--host ${host} --config '${defaults.config}'`));
      assert.match(command, /personal-connection\.json/);
    }
  }
  for (const options of [{ repository: 'relative/path' }, { config: 'C:\\config\nmalicious' }, { origin: 'http://192.168.1.5:9321' }, { origin: 'https://user@sth.test' }]) {
    const result = installCommand({ ...defaults, ...options });
    assert.equal(result.command, '');
    assert.ok(result.error);
  }
  assert.equal(installCommand({ ...defaults, host: 'hermes', profile: 'C:\\production-hermes' }).command, '');
  assert.equal(installCommand({ ...defaults, origin: 'https://sth.test' }).error, '');
});

test('desktop connections pair, copy, cancel and revoke real grants, with history and back links', { timeout }, async t => {
  const { page, backend } = await fixture(t);
  await page.goto('/settings?from=diary');
  await page.getByRole('heading', { name: '连接设置', exact: true }).waitFor();
  await records(page).getByText('还没有连接记录。', { exact: true }).waitFor();
  assert.equal(await page.title(), '连接设置 · Sth');
  await assertFitsViewport(page);
  const code = await generate(page);
  await pairing(page).getByRole('button', { name: '复制命令', exact: true }).click();
  await pairing(page).getByText('配对命令已复制。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `sth personal connect ${code}`);
  const { token } = await claim(backend, code, '作者桌面 Codex');
  await records(page).getByRole('button', { name: '刷新', exact: true }).click();
  const revoke = page.getByRole('button', { name: '撤销连接 作者桌面 Codex', exact: true });
  await revoke.waitFor();
  await capture(page, 'desktop-connections');
  await revoke.click();
  const dialog = page.getByRole('dialog', { name: '撤销连接', exact: true });
  await dialog.getByRole('button', { name: '取消', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  await revoke.click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await dialog.isVisible(), false);
  await revoke.click();
  await dialog.getByRole('button', { name: '撤销连接', exact: true }).click();
  await records(page).getByText('已撤销', { exact: true }).waitFor();
  assert.equal(await revoke.count(), 0);
  const rejected = await fetch(`${backend}/api/v1/personal-operations/catalog`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
  });
  assert.equal(rejected.status, 401);
  await page.getByRole('link', { name: '连接管理', exact: true }).click();
  assert.match(page.url(), /\/settings\/connections$/);
  assert.equal(await pairing(page).locator('code').count(), 0, 'navigation clears the one-time code');
  await page.getByRole('link', { name: '返回设置', exact: true }).click();
  assert.match(page.url(), /\/settings$/);
  await page.goBack();
  await page.getByRole('link', { name: '返回设置', exact: true }).waitFor();
  assert.match(page.url(), /\/settings\/connections$/);
});

test('320px installation guides switch Hermes, Codex and Antigravity with real flags and manual clipboard fallback', { timeout }, async t => {
  const { page, origin } = await fixture(t, { viewport: mobile, fallbackClipboard: true });
  await page.goto('/settings/connections?returnTo=%2Fdiaries');
  const code = await generate(page);
  await pairing(page).getByRole('button', { name: '复制命令', exact: true }).click();
  await pairing(page).getByText('已选中配对命令，请手动复制。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => getSelection().toString()), `sth personal connect ${code}`);
  await pairing(page).getByRole('button', { name: '收起', exact: true }).click();
  assert.equal(await pairing(page).locator('code').count(), 0);
  await page.getByText('安装与连接助手', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Sth 安装目录', exact: true }).fill(defaults.repository);
  await page.getByRole('textbox', { name: 'Hermes 独立 profile 目录', exact: true }).fill(defaults.profile);
  await page.getByRole('textbox', { name: '新的插件分发目录', exact: true }).fill(defaults.distribution);
  const command = page.locator('.install-guide pre');
  assert.ok((await command.innerText()).includes(`hermes sth connect --origin '${origin}'`));
  await assertFitsViewport(page);
  await capture(page, 'mobile-hermes');
  await page.getByRole('combobox', { name: '助手宿主', exact: true }).selectOption('codex');
  await page.getByRole('textbox', { name: '新的私有配对目录', exact: true }).fill(defaults.bindingDirectory);
  await page.getByRole('textbox', { name: '宿主配置文件', exact: true }).fill(defaults.config);
  await page.getByRole('textbox', { name: '宿主本地工作目录', exact: true }).fill(defaults.workspace);
  await page.getByRole('textbox', { name: 'Codex CLI 启动器（可选）', exact: true }).fill('C:\\CLI\\codex.cmd');
  assert.match(await command.innerText(), /--host codex/);
  assert.match(await command.innerText(), /--executable 'C:\\CLI\\codex.cmd'/);
  await page.getByRole('button', { name: '复制安装命令', exact: true }).click();
  await page.getByText('已选中安装命令，请手动复制。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => getSelection().toString()), await command.innerText());
  await assertFitsViewport(page);
  await capture(page, 'mobile-codex');
  await page.getByRole('combobox', { name: '助手宿主', exact: true }).selectOption('antigravity');
  await page.getByRole('textbox', { name: '宿主配置文件', exact: true }).fill('C:\\Sth 测试\\antigravity\\mcp.json');
  await page.getByRole('textbox', { name: 'Antigravity CLI 下载目录（可选）', exact: true }).fill('C:\\CLI\\agy-new');
  assert.match(await command.innerText(), /get-antigravity-cli\.ps1 -Directory 'C:\\CLI\\agy-new'/);
  assert.match(await command.innerText(), /--host antigravity/);
  assert.doesNotMatch(await command.innerText(), /--executable/);
  await assertFitsViewport(page);
  await capture(page, 'mobile-antigravity');
  await page.reload();
  await page.getByText('安装与连接助手', { exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Sth 安装目录', exact: true }).inputValue(), '');
  assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), { local: {}, session: {} });
});

test('connection errors are recoverable, expiry clears secrets, and revoke failures keep the dialog open', { timeout }, async t => {
  const { page, backend } = await fixture(t);
  await page.route('**/api/web/connections', route => route.fulfill({ status: 503, json: { token: 'never-display-server-details' } }));
  await page.goto('/settings');
  await records(page).getByRole('alert').getByText('操作失败，请重试。', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /never-display-server-details/);
  await page.unroute('**/api/web/connections');
  await records(page).getByRole('button', { name: '刷新', exact: true }).click();
  await records(page).getByText('还没有连接记录。', { exact: true }).waitFor();
  await page.route('**/api/web/connections/code', route => route.fulfill({ status: 401, json: {} }));
  await pairing(page).getByRole('button', { name: '生成配对码', exact: true }).click();
  await pairing(page).getByRole('alert').getByText('当前无法访问，请检查 Sth 的访问地址和登录状态。', { exact: true }).waitFor();
  await page.unroute('**/api/web/connections/code');
  const code = await generate(page);
  const connection = await claim(backend, code, '<长名称 & 客户端>');
  await records(page).getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '撤销连接 <长名称 & 客户端>', exact: true }).click();
  await page.route(`**/connections/${connection.connectionId}/revoke`, route => route.fulfill({ status: 503, json: {} }));
  const dialog = page.getByRole('dialog', { name: '撤销连接', exact: true });
  await dialog.getByRole('button', { name: '撤销连接', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.isVisible(), true);
  await page.unroute(`**/connections/${connection.connectionId}/revoke`);
  await dialog.getByRole('button', { name: '撤销连接', exact: true }).click();
  await records(page).getByText('已撤销', { exact: true }).waitFor();
  await page.clock.install();
  await generate(page);
  await page.clock.fastForward(10 * 60_000 + 1);
  await pairing(page).getByText('配对码已过期。', { exact: true }).waitFor();
  assert.equal(await pairing(page).locator('code').count(), 0);
});

test('leaving connections cancels pending responses and delegates every deeper settings route', { timeout }, async t => {
  const { page } = await fixture(t);
  let release;
  const pending = new Promise(done => { release = done; });
  await page.route('**/api/web/connections/code', async route => {
    await pending;
    await route.fulfill({ status: 200, json: { code: 'A'.repeat(22), expiresAt: new Date(Date.now() + 60_000).toISOString() } }).catch(() => {});
  });
  await page.goto('/settings/connections');
  await pairing(page).getByRole('button', { name: '生成配对码', exact: true }).click();
  await pairing(page).getByText('正在生成配对码…', { exact: true }).waitFor();
  await page.getByRole('link', { name: '返回设置', exact: true }).click();
  release();
  await pairing(page).getByRole('button', { name: '生成配对码', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await pairing(page).locator('code').count(), 0);
  for (const route of ['/settings/providers?provider=test', '/settings/models', '/settings/connections/new']) {
    await page.evaluate(href => window.connectionsTestNavigate(href), route);
    await page.getByRole('heading', { name: '交给其他路由', exact: true }).waitFor();
    assert.equal(await pairing(page).count(), 0);
    assert.equal(new URL(page.url()).pathname, new URL(route, 'http://test').pathname);
  }
});

test('owner-protected connection APIs use an isolated browser login and keep credentials out of page content', { timeout }, async t => {
  const { page, backend } = await fixture(t, { protectedOwner: true });
  assert.equal((await fetch(`${backend}/api/web/connections`)).status, 401);
  await page.goto('/settings/connections');
  await records(page).getByText('还没有连接记录。', { exact: true }).waitFor();
  await generate(page);
  assert.doesNotMatch(await page.locator('body').innerText(), /Authorization|Basic [A-Za-z0-9+/=]+/);
});
