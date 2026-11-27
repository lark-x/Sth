/**
 * Repeatable authoring-page baseline using an isolated database and built UI.
 * node scripts/measure-authoring.mjs --out frontend/.artifacts/authoring-metrics
 * Results describe this machine and fixture; they are not field Web Vitals.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { createManuscriptFixture, parseOptions, root, startManuscriptWorkspace, writeJson } from './manuscript-fixture.mjs';

const options = parseOptions(process.argv.slice(2), ['--out', '--samples']);
const samples = Number(options.samples ?? 3);
if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error('--samples must be an integer from 1 to 10');
const output = resolve(root, options.out ?? 'frontend/.artifacts/authoring-metrics');
await mkdir(output, { recursive: true });

async function bundleMetrics(directory) {
  const files = [];
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(folder, entry.name), `${name}/`);
      else {
        const bytes = await readFile(join(folder, entry.name));
        files.push({ name, bytes: bytes.length, gzipBytes: gzipSync(bytes).length,
          sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await walk(directory);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalGzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0) };
}

async function platformFonts(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root: document } = await session.send('DOM.getDocument');
    const fonts = {};
    for (const selector of ['main h1', '#passage-body', '.library-sheet-title']) {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: document.nodeId, selector });
      if (nodeId) fonts[selector] = (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    }
    return fonts;
  } finally { await session.detach(); }
}

const report = {
  format: 1, measuredAt: new Date().toISOString(), status: 'running', samples,
  method: 'Local Chromium; new browser context per route/sample; no network or CPU throttling; persisted synthetic fixture; ready after visible content and font readiness. Timings are local observations, not field Web Vitals or a performance guarantee.',
  node: process.version, bundle: await bundleMetrics(join(root, 'frontend/dist')), pages: [],
};
const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
let browser;
try {
  const fixture = await createManuscriptFixture(workspace.invoke);
  report.build = workspace.capturedBuild;
  report.fixtureSha256 = fixture.contentSha256;
  browser = await chromium.launch();
  report.browser = browser.version();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    for (const route of ['home', 'project', 'oldDraft', 'character', 'source', 'diary']) {
      for (let sample = 1; sample <= samples; sample++) {
        const context = await browser.newContext({ viewport });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.addInitScript(() => {
            window.__sthLayoutShift = 0;
            try {
              new PerformanceObserver(list => {
                for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__sthLayoutShift += entry.value;
              }).observe({ type: 'layout-shift', buffered: true });
            } catch { window.__sthLayoutShift = null; }
          });
          const start = performance.now();
          await page.goto(`${workspace.origin}${fixture.links[route]}`);
          await page.waitForFunction(() => {
            const visible = element => !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
            const main = document.querySelector('main');
            const hasContent = main && visible(main)
              ? [...main.querySelectorAll('h1,h2,[role=alert]')].some(element => visible(element) && !/^正在|^加载/.test(element.textContent.trim()))
              : [...document.querySelectorAll('.library-heading,.library-sheets-heading')].some(visible);
            const pending = [...document.querySelectorAll('[role=status],[aria-busy=true]')].some(element => visible(element)
              && (element.getAttribute('aria-busy') === 'true' || /^(正在(?:打开|读取|加载)|加载中)/.test(element.textContent.trim())));
            return hasContent && !pending;
          }, null, { timeout: 15_000 });
          await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
          const readyMs = Math.round(performance.now() - start);
          const metrics = await page.evaluate(() => {
            const visible = element => !!element.getClientRects().length;
            const prose = [...document.querySelectorAll('#passage-body,.manuscript-prose,.diary-body,main textarea')].find(visible);
            const resources = performance.getEntriesByType('resource');
            const nav = performance.getEntriesByType('navigation')[0];
            const style = prose && getComputedStyle(prose);
            return {
              title: document.title,
              headings: [...document.querySelectorAll('main h1,main h2')].filter(visible).map(element => element.textContent.trim()),
              documentWidth: document.documentElement.clientWidth,
              scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
              proseTop: prose ? Math.round(prose.getBoundingClientRect().top) : null,
              proseWidth: prose ? Math.round(prose.getBoundingClientRect().width) : null,
              proseFont: style ? { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight } : null,
              layoutShiftBeforeReady: window.__sthLayoutShift,
              domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
              resources: resources.length,
              transferredBytes: resources.reduce((sum, resource) => sum + resource.transferSize, 0),
              apiRequests: resources.filter(resource => new URL(resource.name).pathname.startsWith('/api/')).length,
            };
          });
          const screenshot = sample === 1 ? `${viewport.width}-${route}.png` : null;
          if (screenshot) await page.screenshot({ path: join(output, screenshot), animations: 'disabled' });
          report.pages.push({ route, viewport, sample, readyMs, ...metrics, errors, screenshot,
            platformFonts: sample === 1 ? await platformFonts(page) : undefined });
          await writeJson(join(output, 'metrics.json'), report);
          console.log(`${viewport.width}/${route}/${sample}: ${readyMs}ms, ${metrics.apiRequests} API requests`);
        } finally { await context.close(); }
      }
    }
  }
  report.servedBundle = await workspace.inspectServedBundle();
  assert.equal(report.servedBundle.sha256, report.build.bundle.sha256, 'Served bundle changed during measurements');
  report.status = report.pages.some(page => page.errors.length) ? 'page-errors' : 'complete';
  if (report.status !== 'complete') process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await workspace.close();
  await writeJson(join(output, 'metrics.json'), report);
}
