import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { openDatabase } from '../../src/database.ts';
import { startJobsWorker } from '../../src/jobs/index.ts';
import { createManuscriptFixture, startManuscriptWorkspace, writeJson } from '../../scripts/manuscript-fixture.mjs';

const viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
const artifacts = resolve(process.env.STH_SECONDARY_ARTIFACTS ?? 'frontend/.artifacts/secondary-pages');

async function waitForJob(invoke, jobId) {
  const deadline = Date.now() + 10_000;
  do {
    const job = await invoke('jobs.read', { jobId });
    if (job.progress.succeeded === 1 && job.progress.failed === 1) return job;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail('The isolated media worker did not settle both fixture items');
}

async function prepareJob(workspace, fixture, page, t) {
  // A locally drawn PNG exercises the real persisted media route without a supplier.
  const image = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 400;
    const context = canvas.getContext('2d');
    context.fillStyle = '#e7e7e7';
    context.fillRect(0, 0, 640, 400);
    context.fillStyle = '#686868';
    context.font = '24px sans-serif';
    context.fillText('北港 · 隔离媒体样本', 40, 70);
    context.fillRect(40, 300, 560, 2);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const provider = {
    name: 'secondary-layout-fixture', key: 'secondary-layout-fixture',
    parameters: { width: 640, height: 400, seed: 17 },
    async submit({ prompt, requestId }) {
      return prompt === '失败详情'
        ? { state: 'failed', message: '隔离样本失败说明。请检查配置后重试。request_identifier_abcdefghijklmnopqrstuvwxyz_0123456789' }
        : { state: 'submitted', providerJobId: requestId };
    },
    async lookup({ requestId }) { return { state: 'succeeded', providerJobId: requestId, bytes: image }; },
  };
  const items = [];
  for (const title of ['北港雨夜 · 已完成媒体', '失败详情']) {
    const composition = await workspace.invoke('composition.create', {
      projectId: fixture.project.projectId, sceneId: fixture.scene.sceneId,
      sceneRevision: fixture.scene.revision, candidates: [{ title, prompt: title }],
    });
    const selection = { compositionId: composition.compositionId, candidateId: composition.candidates[0].candidateId };
    await workspace.invoke('composition.select', { ...selection, expectedSelectionRevision: composition.selectionRevision });
    items.push(selection);
  }
  const job = await workspace.invoke('jobs.create', { projectId: fixture.project.projectId, title: '北港雨夜 · 出图与失败记录', items });
  const db = openDatabase(workspace.dataDir);
  const worker = startJobsWorker(db, { provider, pollIntervalMs: 15 });
  t.after(async () => { await worker.stop(); db.close(); });
  const settled = await waitForJob(workspace.invoke, job.jobId);
  await worker.stop();
  return { job: settled, imageSha256: createHash('sha256').update(image).digest('hex') };
}

async function seedConnection(workspace) {
  const issue = await fetch(`${workspace.apiOrigin}/api/web/connections/code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: workspace.apiOrigin }, body: '{}',
  });
  assert.equal(issue.status, 200);
  const { code } = await issue.json();
  const claim = await fetch(`${workspace.apiOrigin}/api/v1/personal-operations/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, clientName: '隔离验收 · Codex 中文工作区' }),
  });
  assert.equal(claim.status, 200);
}

async function metrics(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const visible = element => element.checkVisibility() && element.getBoundingClientRect().width > 0;
    const style = element => {
      const value = getComputedStyle(element);
      return { font: value.fontFamily, size: value.fontSize, weight: value.fontWeight,
        color: value.color, background: value.backgroundColor, border: value.borderColor,
        radius: value.borderRadius, lineHeight: value.lineHeight };
    };
    const content = [...main.querySelectorAll('button, a.button, .ce-button, input:not([type="hidden"]), select, textarea')].filter(visible);
    const mainBox = rect(main);
    const visibleWidth = Math.max(0, Math.min(innerWidth, mainBox.x + mainBox.width) - Math.max(0, mainBox.x));
    const visibleHeight = Math.max(0, Math.min(innerHeight, mainBox.y + mainBox.height) - Math.max(0, mainBox.y));
    return {
      main: mainBox, mainVisiblePixels: visibleWidth * visibleHeight,
      mainViewportFraction: visibleWidth * visibleHeight / (innerWidth * innerHeight),
      documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
      body: style(document.body), heading: style(main.querySelector('h1')),
      headingFocus: { active: document.activeElement === main.querySelector('h1'),
        outline: getComputedStyle(main.querySelector('h1')).outlineStyle },
      library: style(document.querySelector('.manuscript-library')),
      projectTitle: main.querySelector('.ce-book-heading h2') ? style(main.querySelector('.ce-book-heading h2')) : null,
      prose: main.querySelector('.ce-prose') ? style(main.querySelector('.ce-prose')) : null,
      controls: content.map(element => ({ text: (element.getAttribute('aria-label') || element.textContent || element.id).trim().slice(0, 70),
        tag: element.tagName, box: rect(element), ...style(element) })),
      overflow: [...main.querySelectorAll('*')].filter(visible).filter(element => {
        const box = element.getBoundingClientRect();
        return box.right > innerWidth + 1 || box.left < -1;
      }).slice(0, 15).map(element => ({ tag: element.tagName, class: element.className, text: element.textContent.slice(0, 80), box: rect(element) })),
    };
  });
}

async function keyboard(page, capturePath) {
  // Focus the existing main landmark, then use real Tab events in DOM order.
  await page.locator('main').focus();
  const stops = [];
  for (let index = 0; index < 120; index++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const element = document.activeElement;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return { tag: element.tagName, name: (element.getAttribute('aria-label') || element.textContent || element.id).trim().slice(0, 100),
        inMain: Boolean(element.closest('main')), focusVisible: element.matches(':focus-visible'),
        outline: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor,
        x: box.x, right: box.right, y: box.y, bottom: box.bottom };
    });
    // Reaching BODY after the final control is normal browser traversal.
    if (stop.tag === 'BODY' || !stop.inMain) break;
    stops.push(stop);
    if (index === 0) await page.screenshot({ path: capturePath, animations: 'disabled' });
  }
  return stops;
}

async function pixels(page, png, layout) {
  return page.evaluate(async ({ base64, main }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const sample = (x, y) => [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    const library = document.querySelector('.manuscript-library');
    const libraryBox = library?.getBoundingClientRect();
    const libraryVisible = library && library.checkVisibility() && libraryBox && libraryBox.width > 0 && libraryBox.height > 0;
    return { main: sample(main.x + 4, main.y + 4), library: libraryVisible ? sample(libraryBox.x + 4, libraryBox.y + 4) : null,
      width: image.width, height: image.height };
  }, { base64: png.toString('base64'), main: layout.main });
}

async function renderedFonts(page, session) {
  const { root } = await session.send('DOM.getDocument');
  const fonts = {};
  for (const selector of ['main h1', '.ce-book-heading h2', '.ce-prose', '.prompt-text', '.connection-record h4']) {
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (nodeId) fonts[selector] = (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  }
  return fonts;
}

test('secondary business pages inherit the shared theme and remain usable at desktop and narrow widths', { timeout: 180_000 }, async t => {
  await mkdir(artifacts, { recursive: true });
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  const cleanup = [];
  // Worker and browser must close before the fixture removes its temporary DB.
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
    await workspace.close();
  });
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const context = await browser.newContext({ baseURL: workspace.origin });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  page.setDefaultTimeout(10_000);
  const browserErrors = [];
  const offsite = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== workspace.origin) {
      offsite.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const fixture = await createManuscriptFixture(workspace.invoke);
  const media = await prepareJob(workspace, fixture, page, { after: action => cleanup.push(action) });
  await seedConnection(workspace);
  const emptyProject = await workspace.invoke('project.create', { title: '尚未落笔的作品' });
  const pages = [
    { name: 'project-overview', path: `${fixture.links.project}?view=overview`, ready: '.ce-book .ce-manuscript', kind: 'seeded business page' },
    { name: 'chapter-arrange', path: `/chapters/${fixture.chapters[1].chapterId}?action=arrange`, ready: '#workspace-editor button[type="submit"]', kind: 'seeded legacy business page' },
    { name: 'tasks', path: '/tasks', ready: '.task-row', kind: 'seeded business page' },
    { name: 'task-failure', path: `/tasks/${media.job.jobId}`, ready: '.task-items details', kind: 'seeded failure details',
      prepare: () => page.locator('.task-items details').evaluateAll(elements => elements.forEach(element => { element.open = true; })) },
    { name: 'media', path: `/media/${media.job.items.find(item => item.mediaId).mediaId}`, ready: '.task-media img', kind: 'persisted synthetic PNG from local fixture worker',
      prepare: () => page.locator('.task-media img').evaluate(image => image.decode()) },
    { name: 'settings', path: '/settings', ready: '.connection-record', kind: 'seeded connection record' },
    { name: 'connections', path: '/settings/connections', ready: '.connection-record', kind: 'seeded connection record and install form',
      prepare: async () => {
        await page.locator('.install-guide summary').click();
        await page.locator('#connection-distribution').fill('C:\\Downloads\\Sth 完整插件分发包\\sth-hermes-win32-x64');
        await page.getByRole('button', { name: '复制安装命令', exact: true }).waitFor();
      } },
    { name: 'prompt', path: fixture.links.prompt, ready: '.prompt-text', kind: 'persisted synthetic generation prompt; no model executed' },
    { name: 'project-empty', path: `/projects/${emptyProject.projectId}?view=overview`, ready: '.ce-book section[aria-label="开始写作品"]', kind: 'empty project state' },
  ];
  const report = { workspace: resolve('.'), origin: workspace.origin, apiOrigin: workspace.apiOrigin,
    build: workspace.capturedBuild, mediaSha256: media.imageSha256, cases: [], violations: [],
    isolation: 'Existing manuscript fixture, temporary DB, random local ports, stopped local stub media worker, no external requests or host installation' };
  await writeJson(join(artifacts, 'fixture.json'), { links: fixture.links, pages: pages.map(({ prepare, ...page }) => page) });
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const target of pages) {
      await page.goto(target.path);
      await page.locator(target.ready).first().waitFor();
      await target.prepare?.();
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => scrollTo(0, 0));
      const name = `${viewport.width}-${target.name}`;
      const screenshot = join(artifacts, `${name}.png`);
      const png = await page.screenshot({ path: screenshot, animations: 'disabled' });
      await page.screenshot({ path: join(artifacts, `${name}-full.png`), animations: 'disabled', fullPage: true });
      const layout = await metrics(page);
      const stops = await keyboard(page, join(artifacts, `${name}-keyboard.png`));
      const result = { name, viewport, path: target.path, kind: target.kind, screenshot, ...layout,
        pixels: await pixels(page, png, layout), renderedFonts: await renderedFonts(page, session), keyboard: stops };
      report.cases.push(result);
      if (layout.documentWidth > viewport.width + 1 || layout.overflow.length) report.violations.push(`${name}: horizontal overflow`);
      if (layout.body.color !== 'rgb(37, 37, 37)' || layout.library.background !== 'rgb(242, 242, 242)') report.violations.push(`${name}: shared neutral theme missing`);
      if (!stops.length || !stops.every(stop => stop.focusVisible && stop.outline !== 'none' && parseFloat(stop.outlineWidth) >= 2)) report.violations.push(`${name}: missing keyboard focus`);
      if (stops.some(stop => stop.x < -1 || stop.right > viewport.width + 1 || stop.bottom <= 0 || stop.y >= viewport.height)) report.violations.push(`${name}: keyboard focus outside the viewport`);
      if (layout.projectTitle && layout.projectTitle.font !== layout.body.font) report.violations.push(`${name}: project title overrides the shared UI font`);
      if (layout.prose && (layout.prose.font !== layout.body.font || layout.prose.size !== '18px' || layout.prose.lineHeight !== '32.4px')) report.violations.push(`${name}: summary overrides shared manuscript typography`);
      if (target.name.startsWith('project-') && layout.controls.find(control => control.text === '新建作品')?.size !== '14px') report.violations.push(`${name}: project action overrides shared control size`);
      await writeJson(join(artifacts, 'manifest.json'), report);
    }
    const atWidth = report.cases.filter(item => item.viewport.width === viewport.width);
    const sharedHeading = atWidth.find(item => item.name.endsWith('-tasks')).heading;
    for (const item of atWidth.filter(item => /-(project-overview|project-empty|settings|connections)$/.test(item.name))) {
      if (item.heading.size !== sharedHeading.size || item.heading.lineHeight !== sharedHeading.lineHeight) report.violations.push(`${item.name}: heading differs from shared business pages`);
    }
  }
  report.servedBundle = await workspace.inspectServedBundle();
  report.browserErrors = browserErrors;
  report.offsite = offsite;
  await writeJson(join(artifacts, 'manifest.json'), report);
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(offsite, []);
  assert.equal(report.servedBundle.sha256, report.build.bundle.sha256);
  assert.deepEqual(report.violations, []);
});
