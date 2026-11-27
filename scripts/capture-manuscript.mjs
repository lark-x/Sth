/**
 * Real-page screenshot acceptance, backed exclusively by a temporary workspace.
 * node scripts/capture-manuscript.mjs --out <directory> --stage final
 * Options: --ui source|built|snapshot --browsers chromium,webkit
 *          --viewports desktop,tablet,phone,compact --only <case,...> --strict
 * Review:  --gallery <capture-directory|manifest.json> [--out <directory>]
 * A baseline run records unavailable new controls as gaps. Every run exits 1
 * when a requested case fails, the served build changes, or browser errors occur.
 * Final stages fail layout/first-screen observations. --strict also enables
 * those checks for a baseline run.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import {
  createManuscriptFixture, inspectManuscriptBuild, parseOptions, root,
  startManuscriptWorkspace, viewports, writeJson,
} from './manuscript-fixture.mjs';

export const screenshotCases = Object.freeze([
  'empty', 'directory', 'passage', 'history', 'focus', 'candidates', 'compare',
  'evidence', 'candidate-evidence', 'no-reference', 'unadopted', 'adopt', 'branch', 'diary', 'edit', 'conflict',
  'receipt', 'loading', 'read-error', 'prompt',
]);
const caseLabels = {
  empty: '空库与首次写作', directory: '书库与章节联动', passage: '助手选段直达', history: '旧稿与新稿',
  focus: '专注阅读与返回', candidates: '三种候选稿', compare: '两稿对照与返回', evidence: '打开引文与返回',
  'candidate-evidence': '两稿各自依据', 'no-reference': '无引用稿件', unadopted: '尚未采用', adopt: '采用指定版本',
  branch: '主线与 IF', diary: '日记读写', edit: '草稿恢复与保存', conflict: '保存冲突与恢复',
  receipt: '保存回执恢复', loading: '读取阶段', 'read-error': '读取失败与重试', prompt: '完整提示词',
};
const actionTimeout = 10_000;
const exact = name => ({ name, exact: true });

function selected(values, available, option) {
  const items = values ? values.split(',') : available;
  assert.ok(items.length && items.every(item => available.includes(item)), `Invalid ${option}: ${values}`);
  return [...new Set(items)];
}

async function settled(page) {
  // Mobile collection routes intentionally keep the editor main hidden.
  await page.locator('main').waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => {
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const main = document.querySelector('main');
    const content = main && visible(main)
      ? [...main.querySelectorAll('h1, [role="alert"]')].some(element => visible(element) && !/^正在/.test(element.textContent.trim()))
      : [...document.querySelectorAll('.library-heading, .library-sheets-heading')].some(visible);
    const pending = [...document.querySelectorAll('[role="status"], [aria-busy="true"]')].some(element => visible(element) &&
      (element.getAttribute('aria-busy') === 'true' || /^(正在(?:打开|读取|加载)|加载中)/.test(element.textContent.trim())));
    return content && !pending;
  }, null, { timeout: actionTimeout });
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const visible = locator.filter({ visible: true });
    for (let index = 0, length = await visible.count(); index < length; index++) {
      const item = visible.nth(index);
      if (await item.isVisible()) return item;
    }
  }
  return undefined;
}

function controls(page, names) {
  return names.flatMap(name => [page.getByRole('button', exact(name)), page.getByRole('link', exact(name))]);
}

async function visibleText(page, text) {
  await page.waitForFunction(text => {
    return document.body.innerText.includes(text);
  }, text, { timeout: actionTimeout });
}

async function evidenceState(page) {
  return page.evaluate(() => {
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
        inViewport: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth };
    };
    const mark = [...document.querySelectorAll('#passage-body mark, .manuscript-prose mark, main mark')].find(visible);
    const active = document.activeElement;
    return {
      title: document.title,
      headings: [...document.querySelectorAll('main h1, main h2')].filter(visible).map(element => element.textContent.trim()).slice(0, 16),
      selected: [...document.querySelectorAll('[aria-current], [aria-selected="true"]')].filter(visible)
        .map(element => ({ text: element.textContent.trim().slice(0, 160), href: element.getAttribute('href'), current: element.getAttribute('aria-current') })).slice(0, 20),
      statuses: [...document.querySelectorAll('[role="status"], [role="alert"]')].filter(visible).map(element => element.textContent.trim()).filter(Boolean),
      passage: mark ? { text: mark.textContent, ...rect(mark) } : null,
      focus: active ? { tag: active.tagName, id: active.id, text: (active.getAttribute('aria-label') || active.textContent || '').slice(0, 120) } : null,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      overflowElements: [...document.querySelectorAll('body *')].filter(visible).map(element => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width && (box.right > innerWidth + 1 || box.left < -1))
        .slice(0, 16).map(({ element, box }) => ({ tag: element.tagName, id: element.id, class: element.getAttribute('class'),
          right: Math.round(box.right), left: Math.round(box.left), width: Math.round(box.width),
          text: element.textContent.trim().slice(0, 80) })),
      overflowContainers: [...document.querySelectorAll('body *')].filter(visible)
        .filter(element => element.scrollWidth > element.clientWidth + 1).slice(-16)
        .map(element => ({ tag: element.tagName, id: element.id, class: element.getAttribute('class'),
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowX: getComputedStyle(element).overflowX,
          closedDetails: Boolean(element.closest('details:not([open])')), text: element.textContent.trim().slice(0, 80) })),
      scroll: { x: scrollX, y: scrollY },
      prose: [...document.querySelectorAll('#passage-body, .manuscript-prose, .wr-prose, .diary-prose')].filter(visible)
        .slice(0, 4).map(element => ({ ...rect(element), font: getComputedStyle(element).fontFamily,
          fontSize: getComputedStyle(element).fontSize, lineHeight: getComputedStyle(element).lineHeight })),
    };
  });
}

async function makeSession(browser, browserName, viewport, origin) {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: viewport.width, height: viewport.height },
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce',
    serviceWorkers: 'block', ...(browserName === 'webkit' ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  page.setDefaultTimeout(actionTimeout);
  page.setDefaultNavigationTimeout(20_000);
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/web/invoke') {
      const call = request.postDataJSON();
      requests.push({ operationId: call.operationId, stepId: call.stepId, input: call.input });
    }
  });
  return { context, page, browser: browserName, browserVersion: browser.version(), viewport, errors, requests };
}

async function holdOperation(page, operationId) {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const active = new Set();
  const errors = [];
  const handler = async route => {
    const work = (async () => {
      if (route.request().postDataJSON().operationId === operationId) { entered(); await gate; }
      await route.continue();
    })();
    active.add(work);
    try { await work; } catch (error) { errors.push(error); }
    finally { active.delete(work); }
  };
  await page.route('**/api/web/invoke', handler);
  return { started, release, close: async () => {
    release();
    // Finish held routes before unregistering them. Playwright can otherwise
    // auto-continue the same request while its original handler is resuming.
    await Promise.allSettled([...active]);
    await page.unroute('**/api/web/invoke', handler);
    if (errors.length) throw new AggregateError(errors, `Failed to resume ${operationId}`);
  } };
}

async function runCase(run, session, id, fixture, execute) {
  if (!run.only.includes(id)) return;
  const { page } = session;
  const actions = [];
  const requestStart = session.requests.length;
  const errorStart = session.errors.length;
  const record = { id, browser: session.browser, viewport: session.viewport, stage: run.stage,
    status: 'running', startedAt: new Date().toISOString(), screenshots: [], actions, assertions: [], observations: [] };
  run.manifest.cases.push(record);
  let screenshotNumber = 0;
  const check = (condition, description, details) => {
    record.assertions.push({ description, passed: Boolean(condition), ...(details === undefined ? {} : { details }) });
    assert.ok(condition, description);
  };
  const goto = async href => {
    actions.push({ type: 'navigate', href });
    const response = await page.goto(href);
    assert.ok(response?.ok() || response?.status() === 304, `Page failed to open: ${response?.status()} ${href}`);
    await settled(page);
  };
  const click = async (locators, description) => {
    const locator = await firstVisible(Array.isArray(locators) ? locators : [locators]);
    assert.ok(locator, `Visible control unavailable: ${description}`);
    const text = await locator.innerText();
    const href = await locator.getAttribute('href');
    await locator.click();
    actions.push({ type: 'click', description, text: text.trim().slice(0, 160), href });
    await settled(page);
  };
  const clickControl = async (names, description = names.join(' / ')) => {
    if (!await firstVisible(controls(page, names))) {
      const more = await firstVisible(controls(page, ['更多']));
      if (more) await click(more, '打开更多稿件操作');
    }
    return click(controls(page, names), description);
  };
  const clickHref = async (href, description) => {
    const next = new URL(href, run.workspace.origin);
    const locator = page.locator('a[href]').filter({ visible: true });
    const handles = await locator.evaluateAll((anchors, target) => anchors.map((anchor, index) => ({ index, url: anchor.href }))
      .filter(item => item.url === target).map(item => item.index), next.href);
    assert.ok(handles.length, `Visible link unavailable: ${description} (${href})`);
    await click(locator.nth(handles[0]), description);
  };
  const fill = async (locator, value, description) => {
    await locator.fill(value);
    actions.push({ type: 'fill', description, value });
  };
  const select = async (locator, value, description) => {
    await locator.selectOption(value);
    actions.push({ type: 'select', description, value });
    await settled(page);
  };
  const scroll = async (locator, description) => {
    await locator.scrollIntoViewIfNeeded();
    actions.push({ type: 'scroll', description });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  };
  const capture = async (state, { settle = true } = {}) => {
    if (settle) await settled(page);
    const observed = await evidenceState(page);
    const name = `${session.browser}-${session.viewport.name}-${id}-${String(++screenshotNumber).padStart(2, '0')}-${state}.png`;
    const path = join(run.output, name);
    await page.screenshot({ path, animations: 'disabled', fullPage: false });
    const image = await readFile(path);
    const entry = { file: name, sha256: createHash('sha256').update(image).digest('hex'), bytes: image.length,
      imageSize: { width: image.readUInt32BE(16), height: image.readUInt32BE(20) },
      capturedAt: new Date().toISOString(), case: id, state, stage: run.stage, status: 'captured',
      url: page.url(), browser: session.browser, browserVersion: session.browserVersion, viewport: session.viewport,
      build: { head: run.manifest.build.head, ui: run.manifest.build.ui, contentSha256: run.manifest.build.contentSha256,
        ...(run.manifest.build.bundle ? { bundleSha256: run.manifest.build.bundle.sha256 } : {}) },
      source: fixture ? { fixture: 'fixture.json', contentSha256: fixture.contentSha256, projectId: fixture.project.projectId,
        resourcePath: new URL(page.url()).pathname, requestedVersionAndRange: Object.fromEntries(new URL(page.url()).searchParams),
        fixtureSourcePins: [fixture.sourcePin, fixture.alternatePin],
        provenance: fixture.provenance } : { fixture: 'empty temporary workspace' },
      actions: structuredClone(actions), observed };
    if (observed.documentWidth > observed.viewport.width + 1) record.observations.push({ state, issue: 'horizontal-overflow', width: observed.documentWidth });
    if (observed.viewport.width !== session.viewport.width || observed.viewport.height !== session.viewport.height) {
      record.observations.push({ state, issue: 'viewport-mismatch', expected: session.viewport, actual: observed.viewport });
    }
    if (['assistant-link', 'returned-to-passage'].includes(state) && !observed.passage?.inViewport) {
      record.observations.push({ state, issue: 'selected-passage-outside-first-screen', passage: observed.passage });
    }
    record.screenshots.push(name);
    run.manifest.screenshots.push(entry);
    await writeJson(join(run.output, 'manifest.json'), run.manifest);
    return observed;
  };
  const back = async () => {
    actions.push({ type: 'history-back' });
    await page.goBack();
    await settled(page);
  };
  try {
    await execute({ page, goto, click, clickControl, clickHref, fill, select, scroll, capture, check, back, actions, record });
    check(session.errors.length === errorStart, 'No uncaught browser errors in this case', session.errors.slice(errorStart));
    if (run.strict) check(record.observations.length === 0, 'Layout and first-screen observations pass', record.observations);
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    await capture('failure', { settle: false }).catch(captureError => { record.captureError = captureError.message; });
  } finally {
    record.operations = session.requests.slice(requestStart);
    record.finishedAt = new Date().toISOString();
    for (const name of record.screenshots) {
      const screenshot = run.manifest.screenshots.find(item => item.file === name);
      screenshot.status = record.status;
    }
    await writeJson(join(run.output, 'manifest.json'), run.manifest);
    console.log(`${session.browser}/${session.viewport.name} ${id}: ${record.status}${record.error ? ` — ${record.error.split('\n')[0]}` : ''}`);
  }
}

async function emptyCase(run, session) {
  await runCase(run, session, 'empty', null, async ({ page, goto, clickControl, capture, check }) => {
    await goto('/');
    await page.getByLabel('此刻想记下什么').waitFor();
    check((await run.workspace.invoke('diary.list')).items.length === 0, 'Empty workspace has no diary');
    await capture('first-writing-entry');
    await clickControl(['文稿库', '资料库', '创作', '作品']);
    await capture('empty-library');
  });
}

async function populatedCases(run, session, fixture) {
  const f = fixture;
  const draft = f.drafts[0];
  const makeCase = (id, execute) => runCase(run, session, id, fixture, execute);
  const textField = page => page.getByRole('textbox', { name: /^正文/ });
  await makeCase('directory', async ({ page, goto, click, clickControl, clickHref, capture, check }) => {
    await goto('/');
    await clickControl(['文稿库', '资料库', '创作', '作品']);
    const openLibrary = await firstVisible(controls(page, ['资料库']));
    if (openLibrary && !await page.locator('.manuscript-library').isVisible()) await click(openLibrary, '在平板上展开资料库');
    await capture('library');
    const project = await firstVisible([page.getByRole('button', exact(f.project.title)), page.getByRole('link', { name: new RegExp(`^${f.project.title}`) })]);
    if (project) await click(project, '选择作品');
    else await clickHref(f.links.project, '打开作品');
    await capture('work-selected');
    const library = await firstVisible(controls(page, ['资料库']));
    if (library) await click(library, '打开作品资料库');
    const expand = await firstVisible([page.getByRole('button', exact(`展开${f.project.title}`))]);
    if (expand) await click(expand, '展开作品章节');
    await click([page.getByRole('link', { name: new RegExp(`^${f.chapters[1].title}`) }),
      page.getByRole('button', exact(f.chapters[1].title))], '选择第二章');
    await capture('chapter-selected');
    await click([page.getByRole('link', { name: new RegExp(`^${f.scene.title}`) }),
      page.getByRole('button', exact(f.scene.title))], '选择章节内场景');
    await capture('scene-selected');
    const candidates = await run.workspace.invoke('draft.list', { sceneId: f.scene.sceneId });
    check(candidates.items.length === 3, 'Three candidates share one scene identity');
    const rows = await page.locator('.library-sheet').evaluateAll((links, sceneId) =>
      links.filter(link => new URL(link.href).pathname === `/scenes/${sceneId}`).length, f.scene.sceneId);
    if (await page.locator('.manuscript-frame').count()) check(rows === 1, 'The scene occupies a single directory row');
  });
  await makeCase('passage', async ({ page, goto, capture, check }) => {
    await goto(f.links.oldPassage);
    const mark = page.locator('#passage-body mark, .manuscript-prose mark').first();
    await mark.waitFor();
    check(await mark.innerText() === f.target.excerpt, 'Assistant link highlights the exact historical UTF-16 passage');
    await capture('assistant-link');
  });
  await makeCase('history', async ({ page, goto, click, clickControl, select, capture, check }) => {
    await goto(f.links.latestDraft);
    const picker = await firstVisible([page.getByRole('combobox', exact('切换稿件版本'))]);
    if (picker) await select(picker, '1', '选择第 1 版');
    else {
      const versions = await firstVisible(controls(page, ['版本历史', '版本', '第 2 版']));
      if (versions) await click(versions, '打开版本选择');
      await click([page.locator(`a[href="${f.links.oldDraft}"]`), page.getByRole('button', exact('第 1 版'))], '打开第 1 版');
    }
    await visibleText(page, f.target.excerpt);
    check(new URL(page.url()).searchParams.get('revision') === '1', 'Old version retains its pinned URL');
    await capture('old-version');
    await clickControl(['查看当前版本', '返回最新版', '查看最新版', '当前版本']);
    await visibleText(page, '第三声钟响以后，她把船票放在掌心，向亮着灯的渡船走去。');
    await capture('new-version');
  });
  await makeCase('focus', async ({ page, goto, click, clickControl, capture, check }) => {
    await goto(f.links.oldDraft);
    if (session.viewport.width < 640 && await page.locator('.manuscript-frame').count()) {
      check(await page.locator('#passage-body').isVisible(), 'Mobile opens the single reading pane');
      await capture('single-screen-reading');
      await clickControl(['返回文稿列表', '文稿列表']);
      await capture('reading-list');
      await click(page.locator('.library-sheet[aria-current="page"]'), '重新打开选中的文稿');
      await capture('focus-returned');
      return;
    }
    await clickControl(['专注阅读', '专注', '进入专注阅读']);
    await capture('focused');
    await clickControl(['显示目录', '退出专注', '退出专注阅读', '返回文稿']);
    await capture('focus-returned');
  });
  await makeCase('candidates', async ({ page, goto, click, select, capture, check }) => {
    await goto(f.links.scene);
    await capture('three-candidates');
    for (const candidate of f.drafts.slice(1)) {
      const picker = await firstVisible([page.getByRole('combobox', { name: /候选|稿件|讲法/ })]);
      if (picker) {
        const options = await picker.locator('option').evaluateAll(options => options.map(option => ({ text: option.text, value: option.value })));
        const option = options.find(option => option.text.includes(candidate.title));
        check(Boolean(option), `Candidate picker contains ${candidate.title}`);
        await select(picker, option.value, `切换到${candidate.title}`);
      } else {
        await click([page.getByRole('link', exact(candidate.title)), page.getByRole('button', exact(candidate.title)),
          page.getByRole('link', { name: new RegExp(`^${candidate.title} · 第`) })], `打开${candidate.title}`);
      }
      await visibleText(page, candidate.title);
      await capture(candidate.draftId === f.drafts[1].draftId ? 'second-candidate' : 'third-candidate');
      if (!picker) await goto(f.links.scene);
    }
  });
  await makeCase('compare', async ({ page, goto, click, clickControl, select, scroll, capture, check }) => {
    await goto(f.links.oldPassage);
    await clickControl(['对照候选稿', '对照', '比稿']);
    const left = await firstVisible([page.getByRole('combobox', exact('左稿'))]);
    const right = await firstVisible([page.getByRole('combobox', exact('右稿'))]);
    if (left && right) {
      await select(left, `${draft.draftId}@1`, '选择左稿第 1 版');
      await select(right, `${f.drafts[1].draftId}@1`, '选择船长稿第 1 版');
      await clickControl(['对照']);
    }
    await page.getByRole('article', exact('左稿')).waitFor();
    const rightTab = await firstVisible([page.getByRole('button', exact('右稿'))]);
    const singleColumn = rightTab && !await page.getByRole('article', exact('右稿')).isVisible();
    if (singleColumn) {
      await capture('comparison-left');
      await click(rightTab, '同段切换至右稿');
      await page.getByRole('article', exact('右稿')).waitFor();
      await capture('comparison-right');
      await clickControl(['左稿'], '同段返回左稿');
    } else await page.getByRole('article', exact('右稿')).waitFor();
    await capture('comparison');
    const changed = await firstVisible([page.locator('.wr-comparison [data-side="left"] [data-compare-row]').filter({ hasText: f.target.excerpt })]);
    if (changed) {
      await scroll(changed, '阅读两稿不同的同一段落');
      await capture('compared-passage-left');
      if (singleColumn) {
        await clickControl(['右稿'], '在原段切换右稿');
        await capture('compared-passage-right');
        await clickControl(['左稿'], '在原段返回左稿');
      }
    }
    const context = page.locator('summary').filter({ hasText: '核对本稿引用上下文' });
    if (await context.count()) {
      await click(context.first(), '展开左稿依据');
      await capture('left-basis');
      if (singleColumn) await clickControl(['右稿'], '切换右稿核对依据');
      await click(context.last(), '展开右稿依据');
      await capture('different-bases');
    }
    const exit = await firstVisible(controls(page, ['结束比稿', '返回原稿', '退出对照', '返回稿件']));
    if (exit) await click(exit, '结束比稿返回原稿');
    else {
      if (singleColumn) await clickControl(['左稿'], '返回左稿');
      const returnLink = await firstVisible([page.locator('.wr-heading > a').filter({ hasText: /返回/ })]);
      if (returnLink) await click(returnLink, '结束比稿回到进入的稿件');
      else await click(page.getByRole('article', exact('左稿')).getByRole('link', { name: new RegExp(draft.title) }), '返回左稿');
    }
    await visibleText(page, draft.title);
    check(new URL(page.url()).pathname === `/drafts/${draft.draftId}`, 'Comparison returns to the original candidate');
    if (await page.locator('.manuscript-frame').count()) {
      check(new URL(page.url()).searchParams.get('start') === String(f.target.range.start), 'Comparison preserves the original passage in its return link');
    }
    await capture('comparison-returned');
  });
  await makeCase('evidence', async ({ page, goto, click, clickControl, scroll, capture, check, back }) => {
    await goto(f.links.oldPassage);
    const entry = page.url();
    await capture('before-basis');
    const toggle = await firstVisible(controls(page, ['AI 本次依据', '本次依据', '查看依据', '依据', '展开依据']));
    if (toggle) await click(toggle, '展开本次依据');
    else {
      const summary = page.locator('summary').filter({ hasText: `${f.character.name} · 第 1 版` });
      await click(summary, '展开固定版本角色设定');
    }
    await visibleText(page, f.sourcePin.excerpt);
    await capture('basis-expanded');
    const quotation = await firstVisible([page.locator('.evidence-content blockquote').filter({ hasText: f.sourcePin.excerpt })]);
    if (quotation) {
      await scroll(quotation, '阅读本次依据中的固定原文');
      await capture('basis-source');
    }
    await click([page.locator(`a[href="${f.links.source}"]`), page.getByRole('link', exact('查看资料原文 · 第 1 版'))], '打开固定版本引文');
    await page.locator('#passage-body mark').waitFor();
    check(await page.locator('#passage-body mark').innerText() === f.sourcePin.excerpt, 'Source opens the recorded excerpt');
    check(new URL(page.url()).searchParams.get('revision') === '1', 'Source revision remains pinned after source has been revised');
    await capture('source-opened');
    await back();
    check(page.url() === entry, 'History returns to the exact draft passage URL');
    await capture('returned-to-passage');
    const trigger = await firstVisible(controls(page, ['AI 本次依据', '本次依据', '依据']));
    if (trigger && await trigger.getAttribute('aria-expanded') === 'false') await click(trigger, '重新展开依据以核对关闭返回');
    const close = await firstVisible(controls(page, ['收起依据', '关闭依据', '关闭本次依据', '返回正文']));
    if (close) await click(close, '收起本次依据');
    else if (toggle) await clickControl(['AI 本次依据', '本次依据', '依据'], '收起本次依据');
    else await click(page.locator('summary').filter({ hasText: `${f.character.name} · 第 1 版` }), '收起角色设定');
    if (trigger) check(await trigger.getAttribute('aria-expanded') === 'false', 'Evidence is actually closed');
    await capture('basis-collapsed');
  });
  await makeCase('candidate-evidence', async ({ page, goto, click, clickControl, select, scroll, capture, check }) => {
    await goto(f.links.oldDraft);
    await clickControl(['AI 本次依据', '本次依据']);
    await visibleText(page, f.sourcePin.excerpt);
    await scroll(page.locator('.evidence-content blockquote').filter({ hasText: f.sourcePin.excerpt }).first(), '阅读林澈稿关联的原句');
    await capture('first-candidate-basis');
    await clickControl(['关闭依据']);
    const picker = page.getByRole('combobox', exact('切换稿件'));
    await select(picker, f.drafts[1].draftId, '切换至船长的讲法');
    await clickControl(['AI 本次依据', '本次依据']);
    await visibleText(page, f.alternatePin.excerpt);
    check((await page.locator('.evidence-content').innerText()).includes(f.alternatePin.excerpt), 'Second candidate uses its own explicitly attached record');
    await scroll(page.locator('.evidence-content blockquote').filter({ hasText: f.alternatePin.excerpt }).first(), '阅读船长稿关联的另一原句');
    await capture('second-candidate-basis');
    const character = page.locator(`.evidence-content a[href="${f.links.character}"]`).first();
    await click(character, '从实际组稿快照打开旧版角色');
    await visibleText(page, f.character.persona);
    check(new URL(page.url()).searchParams.get('revision') === '1', 'Character opens the pinned persona after the character has a newer revision');
    await capture('pinned-character');
  });
  await makeCase('no-reference', async ({ page, goto, click, select, capture, check }) => {
    await goto(`/scenes/${f.bare.sceneId}`);
    const picker = await firstVisible([page.getByRole('combobox', exact('切换稿件'))]);
    if (picker) await select(picker, `${f.bareDraft.draftId}@1`, '选择无引用稿');
    else await click([page.getByRole('link', exact(f.bareDraft.title)), page.getByRole('link', { name: new RegExp(`^${f.bareDraft.title} ·`) })], '打开无引用稿');
    await visibleText(page, f.bareDraft.body);
    const basis = await firstVisible(controls(page, ['AI 本次依据', '本次依据', '依据', '查看依据']));
    if (basis) await click(basis, '查看无引用状态');
    const body = await page.locator('main').innerText();
    check(!body.includes(f.sourcePin.excerpt), 'Unreferenced prose does not inherit another draft source');
    await capture('no-references');
  });
  await makeCase('unadopted', async ({ page, goto, capture, check }) => {
    await goto(f.links.unadopted);
    await visibleText(page, f.unadopted.title);
    check((await run.workspace.invoke('scene.read', { sceneId: f.unadopted.sceneId })).adopted === undefined, 'Scene has no adopted candidate');
    await capture('no-adopted-draft');
  });
  await makeCase('adopt', async ({ page, goto, clickControl, capture, check, record }) => {
    const practice = f.practices[`${session.browser}-${session.viewport.name}`];
    record.resources = practice;
    await goto(`/drafts/${practice.drafts[1].draftId}?revision=1`);
    await capture('before-adoption');
    await clickControl(['采纳此版本', '采用此版本']);
    await page.getByRole('button', exact('采纳候选稿')).waitFor();
    await capture('confirm-version');
    await clickControl(['采纳候选稿']);
    const scene = await run.workspace.invoke('scene.read', { sceneId: practice.scene.sceneId });
    check(scene.adopted.draftId === practice.drafts[1].draftId && scene.adopted.revision === 1, 'Explicit adoption pins the selected candidate version');
    const chapter = await run.workspace.invoke('chapter.read', { chapterId: practice.chapterId });
    const selection = chapter.scenes.find(scene => scene.sceneId === practice.scene.sceneId)?.adopted;
    check(selection?.draftId === practice.drafts[1].draftId && selection?.revision === 1,
      'Chapter points to the explicitly selected draft version');
    check(scene.adopted.body === practice.drafts[1].body, 'The selected version supplies the adopted prose');
    await visibleText(page, practice.drafts[1].body);
    await capture('adopted');
    await page.reload();
    await settled(page);
    await capture('adopted-reopened');
  });
  await makeCase('branch', async ({ page, goto, click, capture, check }) => {
    await goto(f.links.branch);
    await visibleText(page, f.branch.title);
    await capture('if');
    const details = await firstVisible([page.locator('summary').filter({ hasText: '候选稿与场景操作' })]);
    if (details) await click(details, '展开 IF 分歧来源');
    await click([page.getByRole('link', { name: /^原场景 · 第/ }), page.getByRole('link', { name: /返回主线|主线场景/ })], '从 IF 返回分歧前主线');
    await visibleText(page, f.scene.title);
    check((await run.workspace.invoke('scene.read', { sceneId: f.scene.sceneId })).adopted.revision === 1, 'IF does not change the mainline adopted version');
    await capture('mainline');
  });
  await makeCase('diary', async ({ page, goto, clickControl, fill, capture, check }) => {
    await goto(f.links.diary);
    await capture('diary-read');
    await clickControl(['编辑', '编辑日记']);
    const current = await textField(page).inputValue();
    const body = `${current}\n\n${session.browser} ${session.viewport.name}，在网页补记，天亮后继续。`;
    await fill(textField(page), body, '修改一句日记');
    await capture('diary-edit');
    await clickControl(['保存修改', '保存日记', '保存']);
    await visibleText(page, body.split('\n').at(-1));
    await page.reload();
    await settled(page);
    check((await run.workspace.invoke('diary.read', { noteId: f.diary.noteId })).body === body, 'Diary revision persisted through the real API');
    await capture('diary-reopened');
  });
  // Each browser/viewport owns a separate mutable draft to keep old/new, compare
  // and IF references identical throughout the complete screenshot matrix.
  let editable;
  const mutableDraft = async () => editable ??= await run.workspace.invoke('draft.create', {
    sceneId: f.bare.sceneId, sceneRevision: 1, title: `修订练习 · ${session.browser} ${session.viewport.name}`, body: '第一版文字，雨仍未停。',
  });
  const openEditor = async helpers => {
    const draft = await mutableDraft();
    await helpers.goto(`/drafts/${draft.draftId}`);
    await helpers.clickControl(['编辑', '修订候选稿', '编辑稿件']);
    await textField(helpers.page).waitFor();
    return draft;
  };
  await makeCase('edit', async helpers => {
    const { page, fill, capture, clickControl, check, actions } = helpers;
    const draft = await openEditor(helpers);
    const body = '我的未保存文字。\n\n窗外的雨停下来，先把这一句留下。';
    await fill(textField(page), body, '写下尚未保存的句子');
    await capture('unsaved');
    actions.push({ type: 'reload', description: '刷新后恢复本标签页草稿' });
    await page.reload();
    await settled(page);
    check(await textField(page).inputValue() === body, 'Unsaved draft survives reload');
    await capture('draft-restored');
    const held = await holdOperation(page, 'draft.revise');
    try {
      await clickControl(['保存修订', '保存修改', '保存']);
      await page.getByRole('button', exact('正在保存…')).waitFor();
      await capture('saving', { settle: false });
    } finally { await held.close(); }
    await visibleText(page, '窗外的雨停下来，先把这一句留下。');
    await page.reload();
    await settled(page);
    check((await run.workspace.invoke('draft.read', { draftId: draft.draftId })).body === body, 'Saved prose survives reopening');
    await capture('saved-reopened');
  });
  await makeCase('conflict', async helpers => {
    const { page, fill, clickControl, capture, check, actions } = helpers;
    const draft = await openEditor(helpers);
    const current = await run.workspace.invoke('draft.read', { draftId: draft.draftId });
    const mine = '我在网页保留的句子。\n\n这段文字在冲突解决后仍然存在。';
    await fill(textField(page), mine, '编辑当前版本');
    await run.workspace.invoke('draft.revise', { draftId: draft.draftId, expectedRevision: current.revision, body: '另一会话先保存了不同的句子。' });
    actions.push({ type: 'api', operationId: 'draft.revise', description: '第二会话通过真实 API 抢先保存' });
    await clickControl(['保存修订', '保存修改', '保存']);
    await page.getByRole('alert').filter({ hasText: /更新|冲突/ }).first().waitFor();
    check(await textField(page).inputValue() === mine, 'Conflict preserves the authored text');
    await capture('conflict');
    await clickControl(['读取最新版本', '核对最新版', '读取最新版']);
    await visibleText(page, '另一会话先保存了不同的句子。');
    await capture('conflict-latest');
    await clickControl(['保留我的文字，以此版本继续修订', '保留我的修改并采用新版', '保留我的文字']);
    await capture('conflict-rebased');
    await clickControl(['保存修订', '保存修改', '保存']);
    await visibleText(page, '这段文字在冲突解决后仍然存在。');
    const saved = await run.workspace.invoke('draft.read', { draftId: draft.draftId });
    check(saved.body === mine && saved.revision === current.revision + 2, 'Explicit recovery saves the preserved prose as the next revision');
    await capture('conflict-recovered');
  });
  await makeCase('receipt', async helpers => {
    const { page, fill, clickControl, capture, check, actions } = helpers;
    const draft = await openEditor(helpers);
    const current = await run.workspace.invoke('draft.read', { draftId: draft.draftId });
    const body = '保存成功但响应丢失以后，通过原回执找回这一稿。';
    await fill(textField(page), body, '编辑待恢复的稿件');
    let lostStep;
    const route = async route => {
      const call = route.request().postDataJSON();
      if (call.operationId !== 'draft.revise' || lostStep) return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      lostStep = call.stepId;
      await route.fulfill({ status: 503, json: { code: 'capture_response_lost', message: '截图验收主动丢弃已成功的响应。' } });
    };
    await page.route('**/api/web/invoke', route);
    try {
      actions.push({ type: 'network-fault', description: '服务真实保存后，浏览器丢失响应' });
      await clickControl(['保存修订', '保存修改', '保存']);
      await visibleText(page, '保存结果');
      await capture('uncertain-save');
      await page.reload();
      await settled(page);
      await capture('uncertain-reopened');
      await clickControl(['重试同一次提交', '核对并重试', '重试保存']);
      await visibleText(page, body);
      const saved = await run.workspace.invoke('draft.read', { draftId: draft.draftId });
      check(saved.revision === current.revision + 1 && saved.body === body, 'Receipt recovery does not create a duplicate revision');
      check(Boolean(lostStep), 'The actual persisted request was intercepted');
      await capture('receipt-recovered');
    } finally { await page.unroute('**/api/web/invoke', route); }
  });
  await makeCase('loading', async ({ page, goto, capture, actions }) => {
    await goto('/');
    const held = await holdOperation(page, 'draft.read');
    try {
      actions.push({ type: 'network-delay', operationId: 'draft.read', description: '延迟真实读取以观察加载阶段' });
      await page.goto(f.links.oldDraft, { waitUntil: 'domcontentloaded' });
      let timeout;
      try {
        await Promise.race([held.started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Draft read did not start')), actionTimeout); })]);
      } finally { clearTimeout(timeout); }
      await page.getByRole('status').filter({ hasText: /正在|加载/ }).first().waitFor();
      await capture('reading', { settle: false });
      held.release();
      await settled(page);
      await visibleText(page, draft.title);
      await capture('read-complete');
    } finally { await held.close(); }
  });
  await makeCase('read-error', async ({ page, goto, clickControl, capture, actions }) => {
    const route = route => route.request().postDataJSON().operationId === 'draft.read'
      ? route.fulfill({ status: 503, json: { code: 'capture_read_failure', message: '验收中的暂时读取失败。' } }) : route.continue();
    await page.route('**/api/web/invoke', route);
    try {
      actions.push({ type: 'network-fault', operationId: 'draft.read', description: '读取阶段返回 503' });
      await goto(f.links.oldDraft);
      await page.getByRole('alert').first().waitFor();
      await capture('read-failed');
    } finally { await page.unroute('**/api/web/invoke', route); }
    await clickControl(['重试读取', '重试', '重新读取']);
    await visibleText(page, draft.title);
    await capture('read-recovered');
  });
  await makeCase('prompt', async ({ page, goto, click, capture }) => {
    await goto(`/generations/${f.generations[0].generationId}`);
    await click([page.getByRole('link', { name: /提示词/ })], '打开实际保存的提示词与来源');
    await visibleText(page, '提示词');
    await capture('saved-prompt');
  });
}

export async function captureManuscripts(options) {
  assert.ok(options.out, '--out is required');
  const output = resolve(options.out);
  const stage = options.stage ?? 'final';
  assert.match(stage, /^[A-Za-z0-9_-]+$/, 'stage must be a filename-safe label');
  const browserNames = selected(options.browsers, ['chromium', 'webkit'], '--browsers');
  const viewportNames = selected(options.viewports, viewports.map(viewport => viewport.name), '--viewports');
  const only = selected(options.only, screenshotCases, '--only');
  await mkdir(output, { recursive: true });
  // Avoid silently mixing screenshots or a manifest from different builds.
  const { readdir } = await import('node:fs/promises');
  assert.equal((await readdir(output)).length, 0, 'Choose an empty output directory for this capture stage');
  const manifest = { schemaVersion: 1, status: 'running', stage,
    startedAt: new Date().toISOString(), checklist: 'docs/WORKSPACE_ITERATION.md#浏览器截图清单',
    source: { workspace: root, fixtureScript: 'scripts/manuscript-fixture.mjs', api: '/api/web/invoke', isolation: 'harness-owned temporary database; ephemeral service',
      scripts: await Promise.all(['capture-manuscript.mjs', 'manuscript-fixture.mjs'].map(async file => ({ file: `scripts/${file}`,
        sha256: createHash('sha256').update(await readFile(join(root, 'scripts', file))).digest('hex') }))) },
    build: await inspectManuscriptBuild(options.ui), scope: { browsers: browserNames, viewports: viewportNames, cases: only,
      matrix: browserNames.flatMap(browser => viewports.filter(viewport => viewportNames.includes(viewport.name)
        && (browser !== 'webkit' || viewport.width <= 390)).map(viewport => ({ browser, viewport }))) },
    cases: [], screenshots: [], browserErrors: [], startupErrors: [], limitations: [
      'Desktop browser engines with emulated viewport sizes. Physical iOS, keyboards and WKWebView are outside this capture.',
      'Prepared generation records preserve fixture references. Fixture prose is synthetic and does not claim model execution.',
      'Loading and read-error images use recorded browser request delays or faults. Conflict uses a real concurrent API revision.',
    ] };
  const run = { output, stage, only, strict: Boolean(options.strict) || stage !== 'baseline', manifest };
  const browsers = [];
  const sessions = [];
  try {
    run.workspace = await startManuscriptWorkspace({ ui: options.ui });
    if (run.workspace.capturedBuild) manifest.build = run.workspace.capturedBuild;
    manifest.origin = run.workspace.origin;
    manifest.isolation = { dataDir: run.workspace.dataDir, apiOrigin: run.workspace.apiOrigin, removedAfterRun: false };
    for (const name of browserNames) {
      try {
        const browser = await ({ chromium, webkit })[name].launch({ headless: true });
        browsers.push(browser);
        for (const viewport of viewports.filter(item => viewportNames.includes(item.name))) {
          // The required extra WebKit captures cover both mobile widths.
          if (name === 'webkit' && viewport.width > 390) continue;
          sessions.push(await makeSession(browser, name, viewport, run.workspace.origin));
        }
      } catch (error) { manifest.startupErrors.push({ browser: name, message: error.message }); }
    }
    for (const session of sessions) await emptyCase(run, session);
    const fixture = await createManuscriptFixture(run.workspace.invoke);
    await writeJson(join(output, 'fixture.json'), fixture);
    if (sessions.length) {
      manifest.preflight = { status: 'running', path: fixture.links.oldPassage };
      await writeJson(join(output, 'manifest.json'), manifest);
      const probe = sessions[0].page;
      await probe.goto(fixture.links.oldPassage);
      try {
        await probe.locator('#passage-body mark').waitFor();
        await settled(probe);
        assert.equal(await probe.locator('#passage-body mark').innerText(), fixture.target.excerpt);
        manifest.preflight.status = 'passed';
      } catch (error) {
        manifest.preflight.status = 'failed';
        manifest.preflight.error = error.message;
        manifest.preflight.browserErrors = sessions[0].errors.slice();
        await probe.screenshot({ path: join(output, 'preflight-failure.png'), animations: 'disabled' }).catch(() => {});
        throw new Error('The integrated manuscript UI did not load. See preflight and browserErrors in manifest.json.', { cause: error });
      }
    }
    for (const session of sessions) {
      const current = await inspectManuscriptBuild(options.ui);
      if (stage === 'final' && run.workspace.ui !== 'snapshot' && current.contentSha256 !== manifest.build.contentSha256) {
        throw new Error('Application source changed before the next viewport. Repeat this capture stage on the integrated build.');
      }
      await populatedCases(run, session, fixture);
      manifest.browserErrors.push(...session.errors.map(message => ({ browser: session.browser, viewport: session.viewport, message })));
    }
    manifest.fixtureCalls = run.workspace.calls;
  } catch (error) { manifest.startupErrors.push({ message: error.message, stack: error.stack }); }
  finally {
    for (const session of sessions) await session.context.close().catch(error => manifest.startupErrors.push({ cleanup: error.message }));
    for (const browser of browsers) await browser.close().catch(error => manifest.startupErrors.push({ cleanup: error.message }));
    if (run.workspace?.inspectServedBundle) {
      manifest.finalBundle = await run.workspace.inspectServedBundle().catch(error => ({ error: error.message }));
    }
    await run.workspace?.close().catch(error => manifest.startupErrors.push({ cleanup: error.message }));
    if (manifest.isolation) {
      const { access } = await import('node:fs/promises');
      manifest.isolation.removedAfterRun = await access(manifest.isolation.dataDir).then(() => false, () => true);
      if (!manifest.isolation.removedAfterRun) manifest.startupErrors.push({ cleanup: 'Temporary data directory still exists' });
    }
    manifest.finalBuild = await inspectManuscriptBuild(options.ui).catch(error => ({ error: error.message }));
    manifest.sourceStable = manifest.build.contentSha256 === manifest.finalBuild.contentSha256;
    manifest.servedBuildStable = run.workspace?.ui === 'snapshot'
      ? manifest.build.bundle?.sha256 === manifest.finalBundle?.sha256 : manifest.sourceStable;
    manifest.summary = {
      passed: manifest.cases.filter(item => item.status === 'passed').length,
      failed: manifest.cases.filter(item => item.status === 'failed').length,
      observations: manifest.cases.reduce((sum, item) => sum + item.observations.length, 0),
      screenshots: manifest.screenshots.length,
      expectedCases: sessions.length * only.length,
      completedCases: manifest.cases.length,
    };
    manifest.status = manifest.summary.failed || manifest.startupErrors.length || manifest.browserErrors.length || !manifest.servedBuildStable ||
      !sessions.length || manifest.summary.completedCases !== manifest.summary.expectedCases ? 'failed' : 'passed';
    manifest.finishedAt = new Date().toISOString();
    await writeJson(join(output, 'manifest.json'), manifest);
  }
  console.log(JSON.stringify({ manifest: join(output, 'manifest.json'), status: manifest.status,
    sourceStable: manifest.sourceStable, ...manifest.summary }, null, 2));
  return manifest;
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const galleryStyles = `
:root { color-scheme: light; font-family: system-ui, 'Microsoft YaHei UI', 'PingFang SC', sans-serif; color: #23332c; background: #f8faf7; accent-color: #285a46; }
* { box-sizing: border-box; }
body { margin: 0; line-height: 1.6; }
a { color: #285a46; text-underline-offset: .2em; }
button, input, select { font: inherit; color: inherit; }
button, select, input { min-block-size: 2.75rem; border: 1px solid #87968c; border-radius: 4px; background: white; padding: .45rem .7rem; }
button { cursor: pointer; }
button:hover, a:hover { background: #eaf0e9; }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 3px solid #285a46; outline-offset: 3px; }
::selection { background: #d7e6d6; color: #23332c; }
[hidden] { display: none !important; }
header, main, .page-nav { max-inline-size: 96rem; margin-inline: auto; padding: 1.5rem; }
header { border-block-end: 1px solid #d7dfd6; }
h1 { margin: 0 0 .5rem; font-size: clamp(1.6rem, 1.2rem + 1vw, 2.3rem); line-height: 1.3; }
h2 { margin-block: 2rem .75rem; font-size: 1.4rem; }
h3 { margin-block: 1.5rem .75rem; font-size: 1.1rem; }
p { margin-block: .5rem; }
.muted { color: #56665b; }
.warning, .status-failed { color: #8c362c; }
.provenance, .filename { overflow-wrap: anywhere; font-size: .85rem; }
.links, .page-nav, .viewer-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1rem; }
.page-nav { padding-block: .75rem; }
search { display: flex; flex-wrap: wrap; align-items: end; gap: 1rem; padding-block: 1rem; border-block-end: 1px solid #d7dfd6; }
label { display: grid; gap: .25rem; }
input { inline-size: min(100%, 25rem); }
select { max-inline-size: 100%; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr)); align-items: start; gap: 1.5rem; }
figure { margin: 0; min-inline-size: 0; }
.thumbnail { display: block; padding: .5rem; border: 1px solid #d7dfd6; background: white; }
.thumbnail img { display: block; inline-size: 100%; block-size: auto; max-block-size: 26rem; object-fit: contain; object-position: top; }
figcaption { padding-block: .6rem 1rem; overflow-wrap: anywhere; }
figcaption strong { display: block; }
.caption-links { display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
.empty { padding-block: 3rem; }
dialog { inline-size: min(96vw, 96rem); max-inline-size: none; max-block-size: 96dvh; border: 1px solid #87968c; border-radius: 6px; padding: 1.2rem; background: #f8faf7; color: #23332c; }
dialog:modal { overscroll-behavior: contain; }
dialog::backdrop { background: rgb(20 30 24 / .65); overflow: hidden; overscroll-behavior: contain; }
dialog h1 { font-size: 1.2rem; }
dialog form { margin-inline-start: auto; }
.image-view { overflow: auto; max-block-size: 69dvh; background: #eaf0e9; margin-block: 1rem; border: 1px solid #d7dfd6; }
.image-view img { display: block; max-inline-size: 100%; block-size: auto; margin-inline: auto; }
.image-view.native img { max-inline-size: none; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: .85rem/1.6 ui-monospace, Consolas, monospace; }
summary { cursor: pointer; }
.contact-list { display: grid; gap: 2rem; padding: 1.5rem; justify-items: start; overflow-x: auto; }
.contact-page { inline-size: calc(var(--sheet-columns) * var(--thumb-width) + (var(--sheet-columns) - 1) * 20px + 50px); padding: 24px; background: white; border: 1px solid #d7dfd6; }
.contact-page h2 { margin-block: 0 .4rem; }
.contact-grid { display: grid; grid-template-columns: repeat(var(--sheet-columns), var(--thumb-width)); gap: 20px; align-items: start; margin-block-start: 1rem; }
.contact-grid img { display: block; inline-size: 100%; block-size: auto; border: 1px solid #d7dfd6; }
.contact-grid figcaption { font-size: 16px; line-height: 1.5; }
@media (max-width: 40rem) { header, main { padding: 1rem; } search label { inline-size: 100%; } dialog { padding: .7rem; } .viewer-controls { gap: .4rem; } dialog form { margin-inline-start: 0; } }
@media print { @page { size: A3 portrait; margin: 10mm; } header, .page-nav, .no-print { display: none; } .contact-list { display: block; padding: 0; overflow: visible; } .contact-page { break-after: page; break-inside: avoid; border: 0; max-inline-size: 100%; } .contact-grid { grid-template-columns: repeat(var(--sheet-columns), minmax(0, 1fr)); } }
`;

function galleryDocument(title, body, script = '') {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title><style>${galleryStyles}</style></head><body>${body}${script}</body></html>`;
}

function galleryInteractions() {
  const data = JSON.parse(document.querySelector('#gallery-data').textContent);
  const cards = [...document.querySelectorAll('[data-shot-card]')]
    .sort((left, right) => Number(left.dataset.shotCard) - Number(right.dataset.shotCard));
  const dialog = document.querySelector('#viewer');
  const image = document.querySelector('#viewer-image');
  const imageView = document.querySelector('.image-view');
  const previous = document.querySelector('#previous');
  const next = document.querySelector('#next');
  const zoom = document.querySelector('#zoom');
  let current = -1;
  const visibleIndices = () => cards.flatMap((card, index) => card.hidden ? [] : [index]);
  const setShot = index => { location.hash = `shot-${String(index + 1).padStart(4, '0')}`; };
  function showHash() {
    const match = /^#shot-(\d+)$/.exec(location.hash);
    const index = match ? Number(match[1]) - 1 : -1;
    const shot = data[index];
    if (!shot) { if (dialog.open) dialog.close(); return; }
    current = index;
    image.src = shot.src;
    image.width = shot.imageSize.width;
    image.height = shot.imageSize.height;
    image.alt = `${shot.number} · ${shot.caseLabel} · ${shot.state}`;
    imageView.classList.remove('native');
    imageView.scrollTop = 0;
    imageView.scrollLeft = 0;
    zoom.textContent = '原始尺寸';
    zoom.setAttribute('aria-pressed', 'false');
    document.querySelector('#viewer-title').textContent = `${shot.number} / ${data.length} · ${shot.groupLabel} · ${shot.caseLabel}`;
    document.querySelector('#viewer-state').textContent = `${shot.state} · ${shot.status} · ${shot.file}`;
    document.querySelector('#original').href = shot.src;
    document.querySelector('#viewer-record').textContent = JSON.stringify({
      url: shot.url, build: shot.build, source: shot.source, actions: shot.actions,
      statuses: shot.statuses, passage: shot.passage,
    }, null, 2);
    const visible = visibleIndices();
    const position = visible.indexOf(index);
    previous.disabled = position <= 0;
    next.disabled = position < 0 || position === visible.length - 1;
    if (!dialog.open) dialog.showModal();
  }
  function move(direction) {
    const visible = visibleIndices();
    const index = visible[visible.indexOf(current) + direction];
    if (index !== undefined) setShot(index);
  }
  function filter() {
    const group = document.querySelector('#viewport-filter').value;
    const scenario = document.querySelector('#case-filter').value;
    const status = document.querySelector('#status-filter').value;
    const query = document.querySelector('#query').value.trim().toLocaleLowerCase();
    cards.forEach((card, index) => {
      const shot = data[index];
      card.hidden = Boolean((group && shot.group !== group) || (scenario && shot.case !== scenario)
        || (status && shot.status !== status) || (query && !`${shot.file} ${shot.caseLabel} ${shot.state} ${shot.url}`.toLocaleLowerCase().includes(query)));
    });
    for (const section of document.querySelectorAll('[data-case-group], [data-viewport-group]')) {
      section.hidden = !section.querySelector('[data-shot-card]:not([hidden])');
    }
    const count = visibleIndices().length;
    document.querySelector('#result-count').textContent = `显示 ${count} / ${data.length} 张`;
    document.querySelector('#empty-result').hidden = count !== 0;
  }
  document.querySelector('search').addEventListener('input', filter);
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  zoom.addEventListener('click', () => {
    const native = imageView.classList.toggle('native');
    zoom.textContent = native ? '适应宽度' : '原始尺寸';
    zoom.setAttribute('aria-pressed', String(native));
  });
  dialog.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  dialog.addEventListener('close', () => {
    if (/^#shot-\d+$/.test(location.hash)) history.replaceState(null, '', location.href.split('#')[0]);
  });
  addEventListener('hashchange', showHash);
  filter();
  showHash();
}

/** Rebuild review artifacts from an existing capture without starting an API service. */
export async function generateManuscriptGallery({ manifestPath, out } = {}) {
  assert.ok(manifestPath, 'Supply a capture directory or manifest.json');
  let sourcePath = resolve(manifestPath);
  if ((await stat(sourcePath)).isDirectory()) sourcePath = join(sourcePath, 'manifest.json');
  const captureDirectory = dirname(sourcePath);
  const sourceBytes = await readFile(sourcePath);
  const manifest = JSON.parse(sourceBytes);
  assert.ok(Array.isArray(manifest.screenshots) && manifest.screenshots.length, 'The manifest has no screenshots');
  const output = resolve(out ?? join(captureDirectory, 'review'));
  await mkdir(join(output, 'contact-sheets'), { recursive: true });
  const localHref = path => {
    const pathFromOutput = relative(output, path);
    return isAbsolute(pathFromOutput) ? pathToFileURL(path).href : pathFromOutput.split(sep).map(encodeURIComponent).join('/');
  };
  const shots = [];
  const groups = new Map();
  const seenFiles = new Set();
  for (const [index, entry] of manifest.screenshots.entries()) {
    assert.equal(typeof entry.file, 'string', 'Screenshot file must be a relative path');
    const file = resolve(captureDirectory, entry.file);
    const fromCapture = relative(captureDirectory, file);
    assert.ok(fromCapture && fromCapture !== '..' && !fromCapture.startsWith(`..${sep}`) && !isAbsolute(fromCapture), `Screenshot is outside capture directory: ${entry.file}`);
    assert.ok(!seenFiles.has(file), `Duplicate screenshot in manifest: ${entry.file}`);
    seenFiles.add(file);
    const bytes = await readFile(file);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `Expected PNG: ${entry.file}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (entry.sha256) assert.equal(sha256, entry.sha256, `Screenshot hash differs from manifest: ${entry.file}`);
    const imageSize = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (entry.imageSize) assert.deepEqual(imageSize, entry.imageSize, `Screenshot dimensions differ: ${entry.file}`);
    assert.ok(entry.viewport?.width > 0 && entry.viewport?.height > 0 && entry.browser && entry.case, `Missing screenshot metadata: ${entry.file}`);
    const group = `${entry.browser}-${entry.viewport.name ?? `${entry.viewport.width}x${entry.viewport.height}`}`;
    const groupLabel = `${entry.browser} · ${entry.viewport.name ?? ''} · ${entry.viewport.width} × ${entry.viewport.height}`;
    const shot = { number: index + 1, file: entry.file, src: localHref(file), sha256, imageSize, group, groupLabel,
      case: entry.case, caseLabel: caseLabels[entry.case] ?? entry.case, state: entry.state, status: entry.status,
      url: entry.url, build: entry.build ?? manifest.build, source: entry.source, actions: entry.actions ?? [],
      statuses: entry.observed?.statuses ?? [], passage: entry.observed?.passage ?? null };
    shots.push(shot);
    if (!groups.has(group)) groups.set(group, { label: groupLabel, shots: [], viewport: entry.viewport });
    groups.get(group).shots.push(shot);
  }
  const manifestSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const cases = [...new Set(shots.map(shot => shot.case))];
  const hashId = number => `shot-${String(number).padStart(4, '0')}`;
  const header = `<header><h1>文稿截图评阅</h1><p>${shots.length} 张截图 · ${manifest.cases?.length ?? 0} 项检查 · ${escapeHtml(manifest.stage)} · 自动检查 ${escapeHtml(manifest.status)}</p>
<p class="provenance">${escapeHtml(manifest.build?.branch)} · HEAD ${escapeHtml(manifest.build?.head)}<br>源码 ${escapeHtml(manifest.build?.contentSha256)}<br>构建 ${escapeHtml(manifest.build?.bundle?.sha256 ?? manifest.build?.contentSha256)}</p>
${manifest.sourceStable === false ? '<p class="warning">运行期间工作区源码有变化。本图册对应记录中的固定截图构建。</p>' : ''}
<p class="muted">${escapeHtml(manifest.startedAt)} — ${escapeHtml(manifest.finishedAt)} · 构建一致性 ${String(manifest.servedBuildStable ?? manifest.sourceStable)}</p>
<p class="links"><a href="index.html">浏览图册</a><a href="contact-sheet.html">联系表与 PNG</a><a href="${escapeHtml(localHref(sourcePath))}">原始 manifest</a></p></header>`;
  const options = (values, label) => `<option value="">${label}</option>${values.map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('')}`;
  const navigation = `<nav class="page-nav" aria-label="视口目录">${[...groups.values()].map((group, index) => `<a href="#group-${index}">${escapeHtml(group.label)} · ${group.shots.length} 张</a>`).join('')}</nav>`;
  const card = shot => `<figure data-shot-card="${shot.number - 1}" id="thumb-${shot.number}"><a class="thumbnail" href="#${hashId(shot.number)}" aria-label="查看第 ${shot.number} 张 · ${escapeHtml(shot.caseLabel)} · ${escapeHtml(shot.state)}"><img src="${escapeHtml(shot.src)}" width="${shot.imageSize.width}" height="${shot.imageSize.height}" alt="${escapeHtml(shot.state)}" ${shot.number > 4 ? 'loading="lazy"' : ''}></a>
<figcaption><strong>${shot.number} · ${escapeHtml(shot.caseLabel)}</strong>${escapeHtml(shot.state)} · <span class="status-${escapeHtml(shot.status)}">${escapeHtml(shot.status)}</span>
<div class="caption-links"><a href="#${hashId(shot.number)}">评阅本图</a><a href="${escapeHtml(shot.src)}" target="_blank" rel="noopener">打开原图</a></div><div class="filename">${escapeHtml(shot.file)}</div></figcaption></figure>`;
  const sections = [...groups.values()].map((group, index) => `<section data-viewport-group id="group-${index}"><h2>${escapeHtml(group.label)}</h2>${cases.map(scenario => {
    const items = group.shots.filter(shot => shot.case === scenario);
    return items.length ? `<section data-case-group><h3>${escapeHtml(caseLabels[scenario] ?? scenario)} · ${items.length} 张</h3><div class="grid">${items.map(card).join('')}</div></section>` : '';
  }).join('')}</section>`).join('');
  const viewer = `<dialog id="viewer" aria-labelledby="viewer-title"><h1 id="viewer-title">截图</h1><div class="viewer-controls"><button id="previous" type="button">上一张</button><button id="next" type="button">下一张</button><button id="zoom" type="button" aria-pressed="false">原始尺寸</button><a id="original" target="_blank" rel="noopener">打开原图</a><form method="dialog"><button autofocus>关闭</button></form></div>
<p id="viewer-state" class="filename"></p><div class="image-view"><img id="viewer-image" alt=""></div><details><summary>来源、构建与实际操作</summary><pre id="viewer-record" tabindex="0" role="region" aria-label="截图记录"></pre></details></dialog>`;
  const data = JSON.stringify(shots).replaceAll('<', '\\u003c');
  const indexHtml = galleryDocument('文稿截图评阅', `${header}<main><search aria-label="筛选截图"><label>视口<select id="viewport-filter">${options([...groups].map(([key, value]) => [key, value.label]), '全部视口')}</select></label><label>场景<select id="case-filter">${options(cases.map(value => [value, caseLabels[value] ?? value]), '全部场景')}</select></label><label>状态<select id="status-filter">${options([...new Set(shots.map(shot => shot.status))].map(value => [value, value]), '全部状态')}</select></label><label>搜索文件、状态或页面<input id="query" type="search"></label><output id="result-count" aria-live="polite"></output></search>
<p class="muted">选择截图逐张评阅，左右方向键换图。原始尺寸可滚动查看，Esc 关闭。筛选后沿当前结果换图。</p><p id="empty-result" class="empty" hidden>没有符合筛选条件的截图。</p>${navigation}${sections}</main>${viewer}`,
    `<script id="gallery-data" type="application/json">${data}</script><script>(${galleryInteractions.toString()})();</script>`);
  await writeFile(join(output, 'index.html'), indexHtml, 'utf8');
  const sheets = [];
  for (const [groupIndex, group] of [...groups.values()].entries()) {
    const columns = group.viewport.width <= 390 ? 3 : 2;
    const thumbnailWidth = Math.min(group.viewport.width, group.viewport.width >= 1000 ? 640 : 512);
    for (let offset = 0; offset < group.shots.length; offset += 6) {
      const items = group.shots.slice(offset, offset + 6);
      const part = Math.floor(offset / 6) + 1;
      sheets.push({ id: `sheet-${groupIndex}-${part}`, groupIndex, label: group.label, part, columns, thumbnailWidth,
        width: columns * thumbnailWidth + (columns - 1) * 20 + 50,
        file: `contact-sheets/${groupIndex + 1}-${group.shots[0].group.replace(/[^A-Za-z0-9_-]/g, '-')}-${String(part).padStart(2, '0')}.png`,
        numbers: items.map(shot => shot.number), items });
    }
  }
  const contactPages = sheets.map(sheet => `<section class="contact-page" id="${sheet.id}" style="--sheet-columns:${sheet.columns};--thumb-width:${sheet.thumbnailWidth}px"><h2>${escapeHtml(sheet.label)} · 联系表 ${sheet.part}</h2>
<p>图号 ${sheet.numbers.join(' · ')} · ${escapeHtml(manifest.stage)} · ${escapeHtml(manifest.status)}</p><p class="provenance">构建 ${escapeHtml(manifest.build?.bundle?.sha256 ?? manifest.build?.contentSha256)}</p>
<p class="no-print"><a href="${escapeHtml(sheet.file)}" target="_blank" rel="noopener">打开本页 PNG</a></p><div class="contact-grid">${sheet.items.map(shot => `<figure><a href="index.html#${hashId(shot.number)}"><img src="${escapeHtml(shot.src)}" width="${shot.imageSize.width}" height="${shot.imageSize.height}" alt="${shot.number} · ${escapeHtml(shot.caseLabel)} · ${escapeHtml(shot.state)}" loading="lazy"></a><figcaption><strong>${shot.number} · ${escapeHtml(shot.caseLabel)}</strong>${escapeHtml(shot.state)} · ${escapeHtml(shot.status)}<div class="caption-links"><a href="index.html#${hashId(shot.number)}">评阅本图</a><a href="${escapeHtml(shot.src)}" target="_blank" rel="noopener">打开原图</a></div><div class="filename">${escapeHtml(shot.file)}</div></figcaption></figure>`).join('')}</div></section>`).join('');
  const contactNavigation = `<nav class="page-nav" aria-label="联系表视口目录">${[...groups.values()].map((group, index) => `<a href="#sheet-${index}-1">${escapeHtml(group.label)}</a>`).join('')}</nav>`;
  await writeFile(join(output, 'contact-sheet.html'), galleryDocument('文稿截图联系表', `${header}${contactNavigation}<p class="page-nav">按视口与场景顺序排版，每页最多六张。点击缩略图进入评阅，PNG 保留整页图号与状态。</p><main class="contact-list">${contactPages}</main>`), 'utf8');
  const report = { schemaVersion: 1, status: 'rendering', generatedAt: new Date().toISOString(),
    sourceManifest: sourcePath, manifestSha256, captureBuild: manifest.build, sourceStable: manifest.sourceStable,
    servedBuildStable: manifest.servedBuildStable, screenshotCount: shots.length,
    index: join(output, 'index.html'), contactSheet: join(output, 'contact-sheet.html'),
    groups: [...groups.values()].map(group => ({ label: group.label, count: group.shots.length })),
    screenshots: shots.map(shot => ({ number: shot.number, file: shot.file, sha256: shot.sha256, viewer: `index.html#${hashId(shot.number)}` })),
    sheets: sheets.map(({ items, ...sheet }) => ({ ...sheet, status: 'pending' })) };
  const reportPath = join(output, 'gallery.json');
  await writeJson(reportPath, report);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await page.goto(pathToFileURL(join(output, 'contact-sheet.html')).href);
    await page.evaluate(() => document.fonts.ready);
    for (const [index, sheet] of sheets.entries()) {
      const section = page.locator(`#${sheet.id}`);
      await page.setViewportSize({ width: sheet.width + 80, height: 1000 });
      await section.evaluate(async element => {
        const images = [...element.querySelectorAll('img')];
        for (const image of images) image.loading = 'eager';
        await Promise.all(images.map(image => image.decode()));
      });
      const path = join(output, sheet.file);
      await section.screenshot({ path, animations: 'disabled', timeout: 30_000 });
      const bytes = await readFile(path);
      Object.assign(report.sheets[index], { status: 'rendered', sha256: createHash('sha256').update(bytes).digest('hex'),
        imageSize: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } });
    }
    assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), manifestSha256, 'Capture manifest changed while generating the gallery');
    report.status = 'generated';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    throw error;
  } finally {
    await browser?.close();
    await writeJson(reportPath, report);
  }
  console.log(JSON.stringify({ gallery: report.index, contactSheet: report.contactSheet, report: reportPath,
    screenshots: shots.length, contactImages: report.sheets.filter(sheet => sheet.status === 'rendered').length }, null, 2));
  return report;
}

async function main() {
  const options = parseOptions(process.argv.slice(2), ['--out', '--stage', '--ui', '--browsers', '--viewports', '--only', '--strict', '--help', '--gallery']);
  if (options.help) {
    console.log('node scripts/capture-manuscript.mjs --out <empty-directory> [--stage final] [--ui source|built|snapshot] [--browsers chromium,webkit] [--viewports desktop,tablet,phone,compact] [--only case,...] [--strict]');
    console.log('node scripts/capture-manuscript.mjs --gallery <capture-directory|manifest.json> [--out <review-directory>]');
    console.log(`Cases: ${screenshotCases.join(',')}`);
    return;
  }
  if (options.gallery) {
    await generateManuscriptGallery({ manifestPath: options.gallery, out: options.out });
    return;
  }
  const manifest = await captureManuscripts(options);
  if (manifest.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
