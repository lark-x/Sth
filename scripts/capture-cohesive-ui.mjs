/** Full-product visual coverage. Real routes, synthetic data, isolated server.
 * node scripts/capture-cohesive-ui.mjs --viewports desktop,phone --only samples --out <directory>
 * --only all includes retained routes; --browsers chromium,webkit; --ui snapshot|built
 * This captures appearance, not semantic end-to-end acceptance. Review the PNGs.
 */
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createManuscriptFixture, inspectManuscriptBuild, parseOptions, startManuscriptWorkspace, viewports, writeJson } from './manuscript-fixture.mjs';

const options = parseOptions(process.argv.slice(2), ['--out', '--viewports', '--browsers', '--only', '--ui']);
const out = resolve(options.out ?? 'frontend/.artifacts/cohesive-ui/pages');
const engines = (options.browsers ?? 'chromium').split(',');
const dimensions = (options.viewports ?? 'desktop,phone').split(',');
assert.ok(engines.every(name => ['chromium', 'webkit'].includes(name)));
assert.ok(dimensions.every(name => viewports.some(view => view.name === name)));
await mkdir(out, { recursive: true });
assert.equal((await readdir(out)).length, 0, 'Choose an empty output directory; never mix candidate builds');
const workspace = await startManuscriptWorkspace({ ui: options.ui ?? 'snapshot' });
const report = { status: 'running', sampledAt: new Date().toISOString(), purpose: 'Visual route coverage; does not replace behavioral tests or human image review', build: workspace.capturedBuild, cases: [], cleanupErrors: [] };
try {
  const f = await createManuscriptFixture(workspace.invoke);
  const authorContext = await workspace.invoke('story.context', { projectId: f.project.projectId, branchId: null });
  const longSource = await workspace.invoke('source.create', {
    title: '北港巡灯手记：从旧码头最后一班渡船到雨夜未拆的信——角色动机、场景顺序与两种结局的讨论记录',
    kind: 'excerpt', body: '钟声越过水面时，林澈还站在北岸。她摸到衣袋里的信，纸角已经被雨水浸软。\n这份合成资料用于验收长标题、原文摘要和次级来源信息的层级，不代表作者的真实资料。',
    origin: '浏览器验收合成资料 · 记录路径 C:/isolated/creative-workspace/north-harbor/notes/session-2026-11-28 · thread-visual-fixture-001',
    projectIds: [f.project.projectId],
  });
  const project = `projectId=${f.project.projectId}`;
  const chapter = f.chapters[0].chapterId;
  const samples = {
    home: '/', directory: f.links.project, reader: f.links.oldPassage,
    edit: `/drafts/${f.drafts[0].draftId}?action=revise&revision=1`,
    compare: f.links.compare, adopt: `/drafts/${f.drafts[1].draftId}?action=adopt&revision=1`,
    diary: f.links.diary, sources: `/sources?${project}`, source: f.links.source,
    settings: '/settings', chapters: `/chapters?${project}`,
  };
  const more = {
    'diary-new': '/diaries/new', 'diary-edit': `${f.links.diary}?edit=1`,
    'project-new': '/projects/new', 'project-overview': `${f.links.project}?view=overview`,
    'scene-new': `/scenes/new?${project}&chapterId=${chapter}`, scene: f.links.scene,
    'chapter-detail': `/chapters/${chapter}`, 'chapter-arrange': `/chapters/${chapter}?action=arrange`,
    'chapter-new': `/chapters/new?${project}`, 'draft-list': `/drafts?sceneId=${f.scene.sceneId}`,
    characters: `/characters?${project}`, character: f.links.character, 'character-new': `/characters/new?${project}`,
    'source-new': `/sources/new?${project}`, 'source-revise': `/sources/${f.source.sourceId}?action=revise`, 'source-long': `/sources/${longSource.sourceId}`,
    prepare: `${f.links.authorContext}&revision=${authorContext.revision}&prepare=1`, decisions: f.links.authorContext,
    branch: f.links.branch, 'branch-detail': f.links.branchBook, branches: `/branches?${project}`,
    research: '/research', judgments: `/judgments?${project}`, events: `/events?${project}`, narratives: `/narratives?${project}`,
    templates: '/templates', 'template-new': '/templates/new', requirements: '/writing-requirements',
    'requirement-new': '/writing-requirements/new', plans: '/generation-plans', 'plan-new': '/generation-plans/new',
    generations: `/generations?${project}`, prompt: f.links.prompt, 'generation-result': `/generations/${f.generations[0].generationId}/result`,
    batches: '/generation-batches', compositions: '/compositions', media: '/media', jobs: '/jobs',
    connections: '/settings/connections', 'alias-candidates': '/candidates', 'alias-requirements': '/requirements', 'alias-plans': '/plans', 'alias-records': '/records',
  };
  const available = { ...samples, ...more };
  const cases = !options.only || options.only === 'samples' ? Object.entries(samples)
    : options.only === 'all' ? Object.entries(available)
      : options.only.split(',').map(name => { assert.ok(available[name], `Unknown case ${name}`); return [name, available[name]]; });
  for (const engine of engines) {
    const browser = await ({ chromium, webkit })[engine].launch();
    try {
      for (const viewport of viewports.filter(view => dimensions.includes(view.name))) {
        const context = await browser.newContext({ baseURL: workspace.origin, viewport: { width: viewport.width, height: viewport.height }, locale: 'zh-CN', reducedMotion: 'reduce' });
        try {
          await context.addInitScript(({ draft, diary }) => {
            localStorage.setItem('sth:manuscripts:recent:v1', JSON.stringify([
              { kind: 'draft', id: draft.draftId, sceneId: draft.sceneId, title: draft.title, href: `/drafts/${draft.draftId}?revision=1`, updatedAt: Date.now() },
              { kind: 'diary', id: diary.noteId, title: diary.title, href: `/diaries/${diary.noteId}`, updatedAt: Date.now() - 1000 },
            ]));
          }, { draft: f.drafts[0], diary: f.diary });
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          for (const [name, href] of cases) {
            const record = { engine, viewport: viewport.name, width: viewport.width, height: viewport.height, name, href, status: 'running', pageErrors: [] };
            const onError = error => record.pageErrors.push(error.message);
            page.on('pageerror', onError);
            try {
              await page.goto(href);
              await page.waitForFunction(() => {
                const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
                const heading = [...document.querySelectorAll('main h1, .library-sheets-heading h2, .library-brand')].some(visible);
                const loading = [...document.querySelectorAll('[aria-busy=true], [role=status]')].some(node => visible(node) &&
                  (node.getAttribute('aria-busy') === 'true' || /^(正在(?:打开|读取|加载)|加载中)/.test(node.textContent.trim())));
                return heading && !loading;
              });
              await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
              record.observation = await page.evaluate(() => {
                const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
                return {
                  title: document.title,
                  headings: [...document.querySelectorAll('main h1, main h2')].filter(visible).map(node => node.textContent.trim()),
                  alerts: [...document.querySelectorAll('[role=alert]')].filter(visible).map(node => node.textContent.trim()),
                  legacy: Boolean(document.querySelector('.legacy-route')),
                  viewportWidth: innerWidth,
                  contentWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
                  smallTouchControls: innerWidth < 640 ? [...document.querySelectorAll('.ui-button,.button')].filter(visible).filter(node => node.getBoundingClientRect().height < 43.5).map(node => ({ text: node.textContent.trim().slice(0, 60), height: node.getBoundingClientRect().height })) : [],
                };
              });
              record.image = `${engine}-${viewport.width}-${name}.png`;
              await page.screenshot({ path: resolve(out, record.image), fullPage: false, animations: 'disabled' });
              assert.ok(record.observation.contentWidth <= viewport.width + 1, 'No horizontal page overflow');
              assert.ok(!/找不到页面|页面暂时无法打开/.test(record.observation.title), 'Route resolves to its actual page');
              assert.deepEqual(record.pageErrors, [], 'No uncaught browser error');
              assert.deepEqual(record.observation.smallTouchControls, [], 'Shared mobile controls have 44px touch height');
              record.status = 'passed';
            } catch (error) {
              record.status = 'failed'; record.error = error.message;
              if (!record.image) { record.image = `${engine}-${viewport.width}-${name}-failed.png`; await page.screenshot({ path: resolve(out, record.image), animations: 'disabled' }).catch(() => {}); }
            } finally {
              page.off('pageerror', onError);
              report.cases.push(record);
              await writeJson(resolve(out, 'manifest.json'), report);
              process.stdout.write(`${record.status} ${engine} ${viewport.width} ${name}${record.error ? `: ${record.error}` : ''}\n`);
            }
          }
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  report.after = await inspectManuscriptBuild('source');
  report.sourceStable = !workspace.capturedBuild || report.after.contentSha256 === workspace.capturedBuild.contentSha256;
  if (workspace.inspectServedBundle) report.servedBuildStable = (await workspace.inspectServedBundle()).sha256 === workspace.capturedBuild.bundle.sha256;
  report.status = report.cases.every(item => item.status === 'passed') && report.sourceStable && report.servedBuildStable !== false ? 'passed' : 'failed';
} finally {
  try { await workspace.close(); } catch (error) { report.cleanupErrors.push(error.message); report.status = 'failed'; }
  await writeJson(resolve(out, 'manifest.json'), report);
}
if (report.status !== 'passed') process.exitCode = 1;
