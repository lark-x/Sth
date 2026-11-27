/**
 * Repeatable authoring-page baseline using an isolated database and built UI.
 * node scripts/measure-authoring.mjs --out frontend/.artifacts/authoring-metrics
 * Results describe this machine and fixture; they are not field Web Vitals.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createManuscriptFixture, parseOptions, root, startManuscriptWorkspace, writeJson } from './manuscript-fixture.mjs';

async function waitForRequestQuiet(requests, lastActivity, timeout = 15_000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if (![...requests.values()].some(item => item.state === 'pending')
      && performance.now() - Math.max(started, lastActivity()) >= 500) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function requestMetrics(requests) {
  const results = await Promise.all([...requests].map(async ([request, record]) => ({ ...record,
    ...(record.state === 'finished' ? await request.sizes().catch(error => ({ sizeError: String(error) })) : {}),
  })));
  const bytes = request => (request.responseBodySize ?? 0) + (request.responseHeadersSize ?? 0);
  return {
    issued: results.length, completed: results.filter(item => item.state === 'finished').length,
    failed: results.filter(item => item.state === 'failed').length,
    inFlight: results.filter(item => item.state === 'pending').length,
    apiIssued: results.filter(item => item.api).length,
    responseBytes: results.reduce((sum, item) => sum + bytes(item), 0),
    documentResponseBytes: results.filter(item => item.document).reduce((sum, item) => sum + bytes(item), 0),
    sizeErrors: results.filter(item => item.sizeError).map(item => item.sizeError),
  };
}

async function expectLinks(page, selector, expected) {
  await page.waitForFunction(({ selector, expected }) => {
    const actual = [...document.querySelectorAll(selector)].map(item => new URL(item.href).pathname).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
  }, { selector, expected }, { timeout: 15_000 });
}

async function expectLibraryRows(page, expected) {
  await page.waitForFunction(expected => {
    const rows = [...document.querySelectorAll('.library-sheet-list > li[data-sheet-key]')];
    if (rows.length !== expected.length) return false;
    const keys = rows.map(row => row.dataset.sheetKey);
    if (new Set(keys).size !== expected.length) return false;
    return expected.every(item => {
      const row = rows.find(row => row.dataset.sheetKey === item.key);
      const anchor = row?.querySelector('a.library-sheet');
      if (!anchor || row.querySelector('.library-sheet-title')?.textContent.trim() !== item.title) return false;
      const url = new URL(anchor.href);
      const target = new URL(item.href, location.origin);
      const preview = row.querySelector('.library-sheet-preview')?.textContent.trim() ?? '';
      const status = row.querySelector('.library-sheet-meta')?.textContent ?? '';
      const box = row.getBoundingClientRect();
      const clip = row.closest('.library-sheet-scroll')?.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || getComputedStyle(row).visibility === 'hidden') return false;
      const visible = box.width > 0 && box.height > 0 && box.bottom > Math.max(0, clip?.top ?? 0)
        && box.top < Math.min(innerHeight, clip?.bottom ?? innerHeight);
      // Screen-off candidates may still be waiting for visibility. They must
      // retain the same scene identity and may not invent a candidate excerpt.
      const pending = !visible && item.candidate && url.pathname === item.scenePath && !url.searchParams.has('revision')
        && !preview && status.includes('尚无采用稿');
      const exact = url.pathname === target.pathname && url.searchParams.getAll('revision').length === 1
        && url.searchParams.get('revision') === target.searchParams.get('revision')
        && preview === item.preview && status.includes(item.status);
      const returnTo = url.searchParams.get('returnTo');
      if (!returnTo || url.searchParams.getAll('returnTo').length !== 1) return false;
      const expectedReturn = `${item.projectPath}?${new URLSearchParams({ selected: item.sceneId })}`;
      return url.origin === location.origin && (pending || exact) && returnTo === expectedReturn;
    });
  }, expected, { timeout: 15_000 });
}

const options = parseOptions(process.argv.slice(2), ['--out', '--samples']);
const samples = Number(options.samples ?? 3);
if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error('--samples must be an integer from 1 to 10');
const output = resolve(root, options.out ?? 'frontend/.artifacts/authoring-metrics');
await mkdir(output, { recursive: true });

async function platformFonts(page, target) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root: document } = await session.send('DOM.getDocument');
    const fonts = {};
    for (const selector of ['main h1', target]) {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: document.nodeId, selector });
      if (nodeId) fonts[selector] = (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    }
    return fonts;
  } finally { await session.detach(); }
}

const report = {
  format: 2, measuredAt: new Date().toISOString(), status: 'running', samples,
  method: 'Local Chromium; new context per route/sample; no throttling; persisted synthetic fixture. Ready requires expected visible content and fonts. Request counts and bytes include the document and all requests until network idle (500ms without requests, 15s timeout). Font evidence and screenshots use sample 1. Local observations, not field Web Vitals.',
  node: process.version, pages: [], cleanupErrors: [],
};
await writeJson(join(output, 'metrics.json'), report);
let workspace;
let browser;
try {
  workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  const fixture = await createManuscriptFixture(workspace.invoke);
  const preview = await workspace.invoke('scene.read', { sceneId: fixture.prelude.sceneId });
  const recent = await workspace.invoke('manuscript.recent', { limit: 40 });
  const seen = new Set();
  const recentPaths = recent.items.toSorted((a, b) => b.updatedAt - a.updatedAt).filter(item => {
    const key = item.kind === 'diary' ? `diary:${item.id}` : `scene:${item.sceneId ?? item.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 6).map(item => new URL(item.href, workspace.origin).pathname);
  const diaryPaths = [fixture.diary, fixture.personalDiary].map(item => `/diaries/${item.noteId}`);
  const libraryRows = await Promise.all([fixture.prelude, fixture.scene, fixture.unadopted, fixture.bare].map(async item => {
    const scene = await workspace.invoke('scene.read', { sceneId: item.sceneId });
    let draft = scene.adopted;
    if (!draft) {
      const { items: [first] } = await workspace.invoke('draft.list', { sceneId: item.sceneId, limit: 1 });
      if (first) draft = await workspace.invoke('draft.read', { draftId: first.draftId, revision: first.revision });
    }
    assert.ok(draft, `Measurement fixture requires a manuscript for ${item.sceneId}`);
    return {
      key: `scene:${scene.sceneId}`, sceneId: scene.sceneId, title: scene.title, candidate: !scene.adopted,
      scenePath: `/scenes/${scene.sceneId}`, projectPath: `/projects/${fixture.project.projectId}`,
      href: scene.adopted ? `/scenes/${scene.sceneId}?revision=${scene.revision}` : `/drafts/${draft.draftId}?revision=${draft.revision}`,
      preview: draft.body.replace(/\s+/g, ' ').trim().slice(0, 240),
      status: `${scene.adopted ? '采用稿' : '候选稿'} · ${draft.title} · 第 ${draft.revision} 版`,
    };
  }));
  report.build = workspace.capturedBuild;
  report.bundle = await workspace.measureServedBundle();
  report.fixtureSha256 = fixture.contentSha256;
  browser = await chromium.launch();
  report.browser = browser.version();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    for (const route of ['home', 'project', 'oldDraft', 'character', 'source', 'diary']) {
      for (let sample = 1; sample <= samples; sample++) {
        const context = await browser.newContext({ viewport });
        const entry = { route, viewport, sample, status: 'running', errors: [] };
        const requests = new Map();
        report.pages.push(entry);
        try {
          const page = await context.newPage();
          let lastActivity = performance.now();
          page.on('pageerror', error => entry.errors.push(error.message));
          page.on('request', request => { lastActivity = performance.now(); requests.set(request, { api: new URL(request.url()).pathname.startsWith('/api/'),
            document: request.isNavigationRequest() && request.frame() === page.mainFrame(), state: 'pending' }); });
          page.on('requestfinished', request => { lastActivity = performance.now(); const record = requests.get(request); if (record) record.state = 'finished'; });
          page.on('requestfailed', request => { lastActivity = performance.now(); const record = requests.get(request); if (record) record.state = 'failed'; });
          await page.addInitScript(() => {
            window.__sthLayoutShift = 0;
            try {
              new PerformanceObserver(list => {
                for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__sthLayoutShift += entry.value;
              }).observe({ type: 'layout-shift', buffered: true });
            } catch { window.__sthLayoutShift = null; }
          });
          const targets = {
            home: { selector: '#quick-note', kind: 'capture', text: null },
            project: viewport.width < 640 ? { selector: '.library-sheet-list', kind: 'list', text: fixture.scene.title, contains: true }
              : { selector: '#passage-body', kind: 'prose', text: preview.adopted.body },
            oldDraft: { selector: '#passage-body', kind: 'prose', text: fixture.bodies.old },
            character: { selector: '.characters-persona .characters-prose', kind: 'prose', text: fixture.character.persona },
            source: { selector: '#passage-body', kind: 'prose', text: fixture.source.body },
            diary: { selector: '.diary-entry .diary-prose', kind: 'prose', text: fixture.diary.body },
          };
          const target = targets[route];
          const start = performance.now();
          const response = await page.goto(`${workspace.origin}${fixture.links[route]}`);
          assert.ok(response?.ok(), `Unexpected navigation response for ${route}: ${response?.status()}`);
          await page.locator(target.selector).waitFor({ state: 'visible', timeout: 15_000 });
          if (route === 'home') {
            await expectLinks(page, '.sth-manuscript-list a', recentPaths);
            await expectLinks(page, '#diary-list .sth-entry-link', diaryPaths);
          }
          if (route === 'project') await expectLibraryRows(page, libraryRows);
          if (target.text !== null) await page.waitForFunction(({ selector, text, contains }) => {
            const normalize = value => value.replace(/\s+/g, ' ').trim();
            const actual = normalize(document.querySelector(selector)?.textContent ?? '');
            return contains ? actual.includes(normalize(text)) : actual === normalize(text);
          }, target, { timeout: 15_000 });
          await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
          const readyMs = Math.round(performance.now() - start);
          const quiet = await waitForRequestQuiet(requests, () => lastActivity);
          const observationMs = Math.round(performance.now() - start);
          Object.assign(entry, { readyMs, observationMs, quiet, requests: await requestMetrics(requests) });
          const failures = await page.locator('[role=alert],.library-warning,.sources-notice').filter({ visible: true }).allTextContents();
          assert.deepEqual(failures.filter(text => text.trim()), [], `Invalid or degraded ${route} sample`);
          assert.ok(quiet, 'Requests did not reach a new 500ms quiet window');
          assert.equal(entry.requests.failed + entry.requests.inFlight + entry.requests.sizeErrors.length, 0, 'Failed, pending or unmeasured requests invalidate the sample');
          const metrics = await page.evaluate(selector => {
            const visible = element => !!element.getClientRects().length;
            const prose = document.querySelector(selector);
            const nav = performance.getEntriesByType('navigation')[0];
            const style = prose && getComputedStyle(prose);
            return {
              title: document.title,
              headings: [...document.querySelectorAll('main h1,main h2')].filter(visible).map(element => element.textContent.trim()),
              documentWidth: document.documentElement.clientWidth,
              scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
              targetTop: Math.round(prose.getBoundingClientRect().top),
              targetWidth: Math.round(prose.getBoundingClientRect().width),
              targetFont: { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight },
              layoutShiftAtObservationEnd: window.__sthLayoutShift,
              domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
            };
          }, target.selector);
          const screenshot = sample === 1 ? `${viewport.width}-${route}.png` : null;
          if (screenshot) await page.screenshot({ path: join(output, screenshot), animations: 'disabled' });
          const fontTarget = target.kind === 'list' ? '.library-sheet-title' : target.selector;
          Object.assign(entry, { status: 'complete', target: { selector: target.selector, kind: target.kind },
            ...metrics, screenshot, platformFonts: sample === 1 ? await platformFonts(page, fontTarget) : undefined });
          console.log(`${viewport.width}/${route}/${sample}: ${readyMs}ms, ${entry.requests.apiIssued} API requests`);
        } catch (error) { entry.status = 'failed'; entry.error = String(error.stack ?? error); throw error; }
        finally {
          entry.requests ??= await requestMetrics(requests);
          await writeJson(join(output, 'metrics.json'), report);
          await context.close();
        }
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
  if (error.cleanupError) report.cleanupErrors.push(String(error.cleanupError));
  process.exitCode = 1;
} finally {
  for (const close of [() => browser?.close(), () => workspace?.close()]) {
    try { await close(); } catch (error) { report.cleanupErrors.push(String(error)); }
  }
  if (report.cleanupErrors.length) { report.status = 'cleanup-failed'; process.exitCode = 1; }
  await writeJson(join(output, 'metrics.json'), report);
}
