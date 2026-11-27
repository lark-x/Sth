import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), 'work/ulysses-prototype');
const requested = process.argv.slice(2);
const run = requested.find(arg => arg.startsWith('--run='))?.slice(6) || `review-${new Date().toISOString().replaceAll(/[^0-9]/g, '')}`;
assert.match(run, /^[a-zA-Z0-9-]+$/, 'Run name must stay within the artifact directory');
const artifactRoot = join(root, 'frontend/.artifacts/prototype-20261128');
await mkdir(artifactRoot, { recursive: true });
const output = join(artifactRoot, run);
await mkdir(output);
const entry = pathToFileURL(join(root, 'docs/prototypes/ulysses-workspace.html')).href;
const report = { at: new Date().toISOString(), root, entry, headAtRun: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files: {}, cases: [], captures: [], fonts: [], errors: [], externalRequests: [] };
for (const name of ['ulysses-workspace.html', 'ulysses-workspace-style.css', 'ulysses-workspace-app.js']) {
  report.files[name] = createHash('sha256').update(await readFile(join(root, 'docs/prototypes', name))).digest('hex');
}
const fixture = await readFile(join(root, 'scripts/manuscript-fixture.mjs'), 'utf8');
const sample = await readFile(join(root, 'docs/prototypes/ulysses-workspace-app.js'), 'utf8');
for (const text of ['第三声钟响以后，她终于松开了攥住船票的手。', '第三声钟响以后，她把船票放在掌心，向亮着灯的渡船走去。', '第三声钟响以后，船长看见她把船票递了过来。', '第三声钟响以后，岸上的人只看见一盏灯慢慢远去。', '第三声钟响，末班渡船离开北岸。', '第三声钟响，巡灯人仍在岸边等待。']) {
  assert.ok(fixture.includes(text) && sample.includes(text), `Fixture text preserved: ${text}`);
}
const viewports = [ { width: 1280, height: 800 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 640 } ];
const engines = requested.includes('--webkit-only') ? [['webkit', webkit]] : requested.includes('--chromium-only') ? [['chromium', chromium]] : [['chromium', chromium], ['webkit', webkit]];
const picked = requested.find(arg => arg.startsWith('--width='));
async function runViewport(browser, engine, viewport) {
  const label = `${engine}-${viewport.width}`;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => { pageErrors.push(error.message); report.errors.push({ label, type: 'pageerror', message: error.message }); });
  page.on('request', request => { if (/^https?:/.test(request.url())) report.externalRequests.push(request.url()); });
  const click = selector => page.locator(selector).click();
  const openVersions = () => click('#draft-switch');
  const chooseDraft = async draft => { await openVersions(); await click(`#version-menu [data-action="draft"][data-value="${draft}"]`); };
  const chooseRevision = async revision => { await openVersions(); await click(`#version-menu [data-action="revision"][data-value="${revision}"]`); };
  async function shot(name) {
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => ({
      document: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      regions: [...document.querySelectorAll('.library, .sheets, .main, .reading-scroll, .evidence[open]')].filter(element => element.getBoundingClientRect().width).map(element => ({ className: element.className, width: element.clientWidth, scroll: element.scrollWidth })),
      firstParagraphTop: document.querySelector('.prose p')?.getBoundingClientRect().top,
      toolbarHeight: document.querySelector('.toolbar')?.getBoundingClientRect().height,
      excerptRows: [...document.querySelectorAll('.sheet-excerpt')].filter(element => element.getBoundingClientRect().width).map(element => ({ height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight) })),
    }));
    assert.ok(layout.document.scroll <= viewport.width + 1, `${label}/${name} document overflow ${JSON.stringify(layout)}`);
    for (const region of layout.regions) assert.ok(region.scroll <= region.width + 1, `${label}/${name} region overflow ${JSON.stringify(region)}`);
    for (const excerpt of layout.excerptRows) assert.ok(excerpt.height <= excerpt.lineHeight * 2 + 1, `${label}/${name} excerpt limited to two lines`);
    const filename = `${label}-${name}.png`;
    await page.screenshot({ path: join(output, filename), animations: 'disabled' });
    const sha256 = createHash('sha256').update(await readFile(join(output, filename))).digest('hex');
    report.captures.push({ filename, viewport, layout, sha256 });
  }
  async function fonts(name) {
    if (engine !== 'chromium') return;
    const session = await context.newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root: documentRoot } = await session.send('DOM.getDocument');
    const results = {};
    for (const selector of ['.prose p', '.nav-row', '.draft-switch', '.sheet-title']) {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector });
      if (nodeId) results[selector] = (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    }
    report.fonts.push({ label, name, results, computed: await page.locator('.prose').first().evaluate(element => ({ family: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize, lineHeight: getComputedStyle(element).lineHeight })) });
    await session.detach();
  }
  async function visit(hash = '') {
    await page.goto(entry + hash);
    await page.reload();
    if (['#workspace', '#read'].includes(hash)) await page.locator('.prose p').first().waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
  }
  try {
    await visit();
    await shot('home');
    const firstRecent = await page.locator('.recent-row').first().boundingBox();
    assert.ok(firstRecent.y + firstRecent.height <= viewport.height, `${label} first recent item fully visible`);
    await page.locator('#quick-text').fill('雨停以后，想再听一遍北岸的钟声。');
    assert.equal(await page.locator('#quick-save').isEnabled(), true);
    await shot('home-active-note');
    await click('#quick-save');
    await page.getByRole('heading', { name: '速记 · 此页样例' }).waitFor();
    assert.match(await page.locator('#toast').textContent(), /刷新页面后还原/);
    await click('[data-action="continue"]');
    const target = await page.locator('#target-paragraph').boundingBox();
    assert.ok(target.y > 80 && target.y + target.height < viewport.height - 30, `${label} target sentence visible ${JSON.stringify(target)}`);
    await shot('read-target');
    await fonts('sans');
    await openVersions();
    await shot('versions');
    await click('#version-menu [data-action="revision"][data-value="2"]');
    assert.match(await page.locator('.prose').textContent(), /把船票放在掌心/);
    assert.match(await page.locator('.identity-meta').textContent(), /候选稿/);
    await click('#evidence-button');
    assert.match(await page.locator('#evidence-content').textContent(), /这一版还没有确认的依据/);
    await shot('evidence-revision2-empty');
    await click('[data-action="evidence-close"]');
    await chooseRevision(1);
    await page.locator('#target-paragraph').evaluate(element => {
      const text = element.querySelector('mark').firstChild;
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    const selection = await page.evaluate(() => getSelection().toString());
    const before = await page.locator('.reading-scroll').evaluate(element => element.scrollTop);
    await click('#evidence-button');
    assert.match(await page.locator('#evidence-content').textContent(), /末班渡船离开北岸/);
    assert.equal(await page.locator('#evidence').evaluate(element => element.matches(':modal')), viewport.width < 640);
    assert.equal(await page.locator('#evidence').evaluate(element => Math.round(element.getBoundingClientRect().height)), viewport.height);
    assert.equal(await page.locator('#evidence-button').getAttribute('aria-expanded'), 'true');
    await shot('evidence');
    await page.locator('#evidence').evaluate(element => { element.scrollTop = 180; });
    const heading = await page.locator('.evidence-header').boundingBox();
    assert.ok(Math.abs(heading.y) < 1, `${label} evidence heading stays visible`);
    await shot('evidence-scrolled');
    await click('[data-action="evidence-source"]');
    assert.match(await page.locator('#evidence-content').textContent(), /旧值夜簿没有写明她在等待谁/);
    await shot('evidence-source');
    await click('[data-action="evidence-back"]');
    await click('[data-action="evidence-character"]');
    assert.doesNotMatch(await page.locator('#evidence-content').textContent(), /对岸学会修船/);
    assert.match(await page.locator('#evidence-subtitle').textContent(), /固定修订 1/);
    await shot('evidence-character');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#evidence').open && document.activeElement.id === 'evidence-button');
    assert.equal(await page.locator('#evidence').evaluate(element => element.open), false);
    assert.equal(await page.locator('.reading-scroll').evaluate(element => element.scrollTop), before);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'evidence-button');
    assert.equal(await page.evaluate(() => getSelection().toString()), selection);
    await chooseDraft('captain');
    assert.match(await page.locator('.prose').textContent(), /船长看见她把船票递了过来/);
    assert.match(await page.locator('.identity-meta').textContent(), /尚未采用/);
    await click('#evidence-button');
    assert.match(await page.locator('#evidence-content').textContent(), /巡灯人仍在岸边等待/);
    assert.doesNotMatch(await page.locator('#evidence-content').textContent(), /末班渡船离开北岸/);
    await shot('evidence-captain');
    await click('[data-action="evidence-close"]');
    await chooseDraft('shore');
    await click('#evidence-button');
    assert.match(await page.locator('#evidence-content').textContent(), /这一版还没有确认的依据/);
    await shot('evidence-shore-empty');
    await click('[data-action="evidence-close"]');
    await chooseDraft('lin');
    await click('#more-button');
    await click('[data-action="compare"]');
    await shot('compare');
    if (viewport.width < 640) { await click('[data-action="compare-side"][data-value="right"]'); await shot('compare-right'); }
    await click('[data-action="compare-close"]');
    await visit('#workspace');
    const firstParagraph = await page.locator('.prose p').first().boundingBox();
    if (viewport.width < 640) assert.ok(firstParagraph.y < 250, `${label} ordinary reading begins promptly ${firstParagraph.y}`);
    await shot('read-start');
    await fonts('read-start');
    await page.evaluate(() => document.documentElement.style.setProperty('--reading', '"Songti SC", "SimSun", serif'));
    await shot('read-serif');
    await fonts('serif');
    await page.evaluate(() => document.documentElement.style.setProperty('--reading', 'var(--ui)'));
    if (viewport.width < 1060) { await click('.toolbar > [data-action="back-list"]'); if (viewport.width < 640) await click('.list-heading [data-action="library"]'); }
    await click('#library-nav [data-action="scope"][data-value="characters"]');
    if (viewport.width < 640) await click('.sheet[data-value="character"]');
    assert.equal(await page.locator('[data-action="return-reader"]').count(), 1);
    assert.equal(await page.locator('#search-label').textContent(), '搜索角色');
    assert.equal(await page.locator('#sort-label').textContent(), '按名称排序');
    await shot('character');
    await click('[data-action="return-reader"]');
    assert.match(await page.locator('#draft-switch').textContent(), /林澈的讲法/);
    assert.equal(await page.locator('#list-title').textContent(), '第三声以后');
    if (viewport.width < 1060) { await click('.toolbar > [data-action="back-list"]'); if (viewport.width < 640) await click('.list-heading [data-action="library"]'); }
    await click('#library-nav [data-action="scope"][data-value="sources"]');
    if (viewport.width < 640) await click('.sheet[data-value="source"]');
    assert.equal(await page.locator('#search-label').textContent(), '搜索资料');
    assert.equal(await page.locator('#sort-label').textContent(), '按标题排序');
    await shot('source');
    await click('[data-action="return-reader"]');
    assert.equal(await page.locator('#list-title').textContent(), '第三声以后');
    if (viewport.width < 1060) { await click('.toolbar > [data-action="back-list"]'); if (viewport.width < 640) await click('.list-heading [data-action="library"]'); }
    await shot('library');
    await click('#library-nav [data-action="scope"][data-value="ch3"]');
    if (viewport.width < 640) await shot('sheets');
    await click('.sheet[data-value="bare"]');
    await click('#evidence-button');
    assert.match(await page.locator('#evidence-content').textContent(), /没有已确认的来源记录/);
    await shot('bare-empty');
    await click('[data-action="evidence-close"]');
    await visit('#read');
    await chooseDraft('captain');
    await openVersions();
    assert.match(await page.locator('#version-menu [data-action="draft"][data-value="lin"]').textContent(), /章节采用修订 1/);
    await click('#version-menu [data-action="adopt"]');
    assert.match(await page.locator('.identity-meta').textContent(), /本章采用/);
    assert.match(await page.locator('.sheet[data-value="main"] .sheet-meta').textContent(), /船长的讲法/);
    await shot('explicit-adopt');
    await page.evaluate(() => { location.hash = 'workspace'; });
    await page.waitForFunction(() => document.querySelector('#draft-switch').textContent.includes('林澈的讲法'));
    assert.match(await page.locator('.identity-meta').textContent(), /尚未采用/);
    await visit('#read');
    assert.match(await page.locator('#draft-switch').textContent(), /林澈的讲法/);
    await click('#more-button');
    await click('[data-action="conflict-demo"]');
    const edit = page.locator('#edit-area');
    await edit.fill((await edit.inputValue()) + '\n\n这是当前页面的恢复练习。');
    await click('[data-action="save-edit"]');
    assert.match(await page.locator('.conflict').textContent(), /保存冲突样例/);
    await shot('edit-conflict');
    await click('[data-action="resolve-conflict"]');
    assert.match(await page.locator('.prose').textContent(), /当前页面的恢复练习/);
    assert.match(await page.locator('#toast').textContent(), /刷新后还原/);
    await shot('edit-restored');
    await openVersions();
    assert.match(await page.locator('#version-menu').textContent(), /此页暂存的样例修订/);
    await page.reload();
    assert.doesNotMatch(await page.locator('.prose').textContent(), /当前页面的恢复练习/);
    if (viewport.width === 1280) {
      await click('#evidence-button');
      for (const width of [639, 640, 768, 390, 1280]) {
        await page.setViewportSize({ width, height: viewport.height });
        await page.waitForFunction(mobile => document.querySelector('#evidence').open && document.querySelector('#evidence').matches(':modal') === mobile, width < 640);
        assert.equal(await page.locator('#app').evaluate(element => element.classList.contains('with-evidence')), true);
      }
      await click('[data-action="evidence-close"]');
      await page.waitForFunction(() => document.activeElement.id === 'evidence-button');
    }
    assert.equal(pageErrors.length, 0);
    report.cases.push({ label, status: 'passed', assertions: ['home-first-viewport', 'note-active-and-memory-only', 'target-visible', 'three-drafts', 'revision-specific-evidence', 'evidence-missing', 'source-old-revision', 'character-old-revision', 'panel-sticky', 'panel-height', 'escape-focus-selection-scroll-restored', 'font-comparison', 'comparison', 'character-single-return', 'source-return', 'mobile-navigation', 'explicit-adoption-only', 'conflict-retains-text', 'reload-restores-sample', 'no-horizontal-overflow'] });
    console.log(`${label} passed`);
  } catch (error) {
    report.errors.push({ label, type: 'test-failure', message: error.stack });
    report.cases.push({ label, status: 'failed', message: error.message });
    await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {});
    console.error(label, error.stack);
  } finally { await context.close(); }
}
async function runRegression(browser, engine, viewport, regression) {
  const label = `${engine}-${viewport.width}-${regression}`;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const observations = [];
  const pageErrors = [];
  page.on('pageerror', error => { pageErrors.push(error.message); report.errors.push({ label, type: 'pageerror', message: error.message }); });
  page.on('request', request => { if (/^https?:/.test(request.url())) report.externalRequests.push(request.url()); });
  const click = selector => page.locator(selector).click();
  const chooseRevision = async revision => {
    await click('#draft-switch');
    await click(`#version-menu [data-action="revision"][data-value="${revision}"]`);
  };
  async function capture(name) {
    await page.evaluate(() => document.fonts.ready);
    const reading = await page.evaluate(() => {
      const scroller = document.querySelector('.reading-scroll');
      const target = document.querySelector('#target-paragraph');
      return {
        scroll: scroller.scrollTop, scrollHeight: scroller.scrollHeight, height: scroller.clientHeight,
        targetTop: target?.getBoundingClientRect().top, targetReading: !!document.querySelector('.target-reading'),
        identity: document.querySelector('.identity-meta')?.textContent,
        text: document.querySelector('.prose')?.textContent,
        evidenceOpen: document.querySelector('#evidence').open,
        evidenceSubtitle: document.querySelector('#evidence-subtitle').textContent,
        evidenceText: document.querySelector('#evidence-content').textContent,
        evidenceExpanded: document.querySelector('#evidence-button')?.getAttribute('aria-expanded'),
      };
    });
    const filename = `${label}-${name}.png`;
    await page.screenshot({ path: join(output, filename), animations: 'disabled' });
    const sha256 = createHash('sha256').update(await readFile(join(output, filename))).digest('hex');
    observations.push({ name, ...reading });
    report.captures.push({ filename, viewport, sha256, reading });
    return reading;
  }
  try {
    await page.goto(entry + '#read');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.querySelector('.reading-scroll')?.scrollTop > 0);
    if (regression === 'p1a-open-evidence-version') {
      await click('#evidence-button');
      const original = await capture('revision1');
      assert.match(original.evidenceSubtitle, /修订 1/);
      assert.match(original.evidenceText, /末班渡船离开北岸/);
      await chooseRevision(2);
      const changed = await capture('revision2');
      assert.match(changed.identity, /修订 2/);
      assert.match(changed.text, /把船票放在掌心/);
      assert.equal(changed.evidenceOpen, true);
      assert.match(changed.evidenceSubtitle, /修订 2/, 'Open evidence must follow the selected revision');
      assert.match(changed.evidenceText, /这一版还没有确认的依据/);
      assert.doesNotMatch(changed.evidenceText, /作者已确认关联/);
      assert.equal(changed.evidenceExpanded, 'true');
      await chooseRevision(1);
      const restored = await capture('revision1-again');
      assert.match(restored.evidenceSubtitle, /修订 1/);
      assert.match(restored.evidenceText, /末班渡船离开北岸/);
      assert.equal(restored.evidenceExpanded, 'true');
      await click('#draft-switch');
      await click('#version-menu [data-action="draft"][data-value="captain"]');
      const captain = await capture('captain');
      assert.match(captain.evidenceSubtitle, /船长的讲法 · 修订 1/);
      assert.match(captain.evidenceText, /巡灯人仍在岸边等待/);
      assert.doesNotMatch(captain.evidenceText, /末班渡船离开北岸/);
      assert.equal(captain.evidenceExpanded, 'true');
      await click('[data-action="evidence-close"]');
      await page.waitForFunction(() => document.activeElement.id === 'evidence-button');
      assert.equal(await page.locator('#evidence-button').getAttribute('aria-expanded'), 'false');
    } else if (regression === 'p1b-immutable-revision') {
      const original = await capture('original-revision1');
      await click('[data-action="edit"]');
      const editor = page.locator('#edit-area');
      const originalText = await editor.inputValue();
      const changedText = originalText.replace('第三声钟响以后，她终于松开了攥住船票的手。', '独立审查标记');
      assert.notEqual(changedText, originalText);
      await editor.fill(changedText);
      await chooseRevision(2);
      assert.match(await page.locator('#edit-area').inputValue(), /把船票放在掌心/);
      await chooseRevision(1);
      assert.equal(await page.locator('#edit-area').inputValue(), changedText, 'Unsubmitted buffer must survive version browsing');
      await click('[data-action="save-edit"]');
      const saved = await capture('saved-revision3');
      assert.match(saved.identity, /修订 3/);
      assert.doesNotMatch(saved.identity, /本章采用/);
      assert.match(saved.text, /独立审查标记/);
      await chooseRevision(1);
      const old = await capture('returned-revision1');
      assert.equal(old.text, original.text, 'Saving revision 3 must preserve the immutable revision 1 body');
      assert.match(old.identity, /修订 1.*本章采用/);
      assert.match(await page.locator('.sheet[data-value="main"] .sheet-meta').textContent(), /林澈的讲法 · 修订 1/);
      await chooseRevision(2);
      assert.match(await page.locator('.prose').textContent(), /把船票放在掌心/);
      assert.doesNotMatch(await page.locator('.prose').textContent(), /独立审查标记/);
      await chooseRevision(3);
      assert.equal(await page.locator('.prose').textContent(), saved.text);
      await chooseRevision(1);
      await click('[data-action="edit"]');
      await page.locator('#edit-area').fill(originalText.replace('第三声钟响以后，她终于松开了攥住船票的手。', '第二次独立审查标记'));
      await click('[data-action="save-edit"]');
      assert.match(await page.locator('.identity-meta').textContent(), /修订 4/);
      await chooseRevision(3);
      assert.equal(await page.locator('.prose').textContent(), saved.text, 'Saving again from revision 1 must preserve revision 3');
      await chooseRevision(1);
      assert.equal(await page.locator('.prose').textContent(), original.text);
      await capture('revision1-after-second-save');
    } else {
      for (const scope of ['characters', 'sources']) {
        const before = await capture(`before-${scope}`);
        assert.equal(before.targetReading, true);
        if (viewport.width < 1060) await click('.toolbar > [data-action="back-list"]');
        await click(`#library-nav [data-action="scope"][data-value="${scope}"]`);
        await page.locator('.detail-page').waitFor({ state: 'visible' });
        await click('[data-action="return-reader"]');
        const after = await capture(`after-${scope}`);
        assert.equal(after.text, before.text);
        assert.equal(after.identity, before.identity);
        assert.equal(after.targetReading, before.targetReading, 'Returning must restore the target reading layout');
        assert.ok(Math.abs(after.scroll - before.scroll) <= 1, `Returning must restore scroll ${before.scroll} -> ${after.scroll}`);
        assert.ok(Math.abs(after.targetTop - before.targetTop) <= 1, `Returning must restore target position ${before.targetTop} -> ${after.targetTop}`);
        assert.equal(after.scrollHeight, before.scrollHeight, 'Returning must preserve the full reading extent');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
      }
    }
    assert.equal(pageErrors.length, 0);
    report.cases.push({ label, status: 'passed', regression, observations });
    console.log(`${label} passed`);
  } catch (error) {
    report.errors.push({ label, type: 'test-failure', message: error.stack });
    report.cases.push({ label, status: 'failed', regression, message: error.message, observations });
    console.error(label, error.stack);
  } finally { await context.close(); }
}
for (const [engine, driver] of engines) {
  const browser = await driver.launch({ headless: true });
  try {
    for (const viewport of viewports.filter(item => !picked || item.width === Number(picked.split('=')[1]))) {
      if (!requested.includes('--regressions-only')) await runViewport(browser, engine, viewport);
      if (viewport.width === 1280) {
        await runRegression(browser, engine, viewport, 'p1a-open-evidence-version');
        await runRegression(browser, engine, viewport, 'p1b-immutable-revision');
      }
      if (viewport.width >= 768) await runRegression(browser, engine, viewport, 'p2-target-return');
    }
  } finally { await browser.close(); }
}
assert.equal(report.externalRequests.length, 0);
report.passed = report.cases.every(item => item.status === 'passed');
const suffix = requested.join('-').replaceAll(/[^a-zA-Z0-9-]/g, '') || 'all';
await writeFile(join(output, `manifest-${suffix}.json`), JSON.stringify(report, null, 2));
await writeFile(join(output, 'manifest.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(({ label, status, message }) => ({ label, status, message })), screenshots: report.captures.length, output }, null, 2));
if (!report.passed) process.exitCode = 1;
