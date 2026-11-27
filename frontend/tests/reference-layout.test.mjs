import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startManuscriptWorkspace } from '../../scripts/manuscript-fixture.mjs';
import { manuscriptReturn } from '../manuscript/return-link.ts';

const artifacts = resolve(process.env.STH_REFERENCE_ARTIFACTS ?? 'frontend/.artifacts/reference-pages/layout');
const returnTarget = '/drafts/original?revision=1&start=3&end=12#passage-body';
const link = (page, name) => page.getByRole('link', { name, exact: true });

test('return links accept only an unambiguous same-origin writing reader URL', () => {
  const url = value => new URL(`/sources/id?returnTo=${encodeURIComponent(value)}`, 'https://sth.test');
  for (const value of [returnTarget, `https://sth.test${returnTarget}`, '/scenes/scene_1?revision=2#passage-body']) {
    assert.equal(manuscriptReturn(url(value)), value.replace('https://sth.test', ''));
  }
  for (const value of ['https://outside.test/drafts/id', '//outside.test/drafts/id',
    'https://sth.test.outside.test/drafts/id', 'https://user@sth.test/drafts/id',
    'javascript:alert(1)', 'data:text/html,test', '/drafts/new', '/drafts/id?action=revise',
    '/drafts/id?action=adopt', '/scenes/id?action=compare', '/scenes/id?action=branch',
    '/drafts/id?action=&action=', '/drafts/id?narrativeId=other', '/sources/id', '/diaries/id',
    '/drafts/%2fother', '/drafts/%ZZ', '/drafts/id/deeper', '/\\outside.test/drafts/id',
    '\n/drafts/id', '/drafts/id\t', '']) {
    assert.equal(manuscriptReturn(url(value)), undefined, value);
  }
  assert.equal(manuscriptReturn(new URL('https://sth.test/characters/id')), undefined);
  const duplicate = url(returnTarget);
  duplicate.searchParams.append('returnTo', '/scenes/other');
  assert.equal(manuscriptReturn(duplicate), undefined);
});

test('native reference hrefs retain manuscript return context when copied or opened in a new tab', { timeout: 90_000 }, async t => {
  const output = resolve(artifacts, '..', 'native-hrefs');
  await mkdir(output, { recursive: true });
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  const report = { status: 'running', build: workspace.capturedBuild, cases: [], pageErrors: [] };
  let browser;
  try {
    const body = '🚢 第一处：末班十点。\n第二处：末班十点。';
    const excerpt = '末班十点';
    const start = body.lastIndexOf(excerpt);
    const range = { start, end: start + excerpt.length };
    const source = await workspace.invoke('source.create', { title: '新标签页原文', kind: 'excerpt', body });
    await workspace.invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '新版改为末班九点。' });
    const other = await workspace.invoke('character.create', { name: '另一位巡灯人', persona: '第一版设定。' });
    await workspace.invoke('character.revise', { characterId: other.characterId, expectedRevision: 1, persona: '第二版设定。' });
    const character = await workspace.invoke('character.create', { name: '原稿中的巡灯人', persona: '旧版巡灯设定。', entries: [
      { label: '同行角色', blocks: [{ type: 'reference', kind: 'character', id: other.characterId, revision: 2 }] },
      { label: '第二次通知', blocks: [{ type: 'reference', kind: 'source', id: source.sourceId, revision: 1, excerpt, range }] },
    ] });
    await workspace.invoke('character.revise', { characterId: character.characterId, expectedRevision: 1, persona: '新版巡灯设定。' });
    const pin = { sourceId: source.sourceId, revision: 1, excerpt, range };
    const diary = await workspace.invoke('diary.create', { title: '有位置的引用', diaryDate: '2026-11-28', body: '按第二处通知等船。', sourcePins: [pin] });
    await workspace.invoke('diary.create', { title: '整条原文引用', diaryDate: '2026-11-28', body: '保留整条通知。', sourcePins: [{ sourceId: source.sourceId, revision: 1, excerpt }] });
    const scene = await workspace.invoke('scene.create', { title: '原稿场景' });
    const originalBody = '她在北岸听见第三声钟响，仍旧等在栈桥。';
    const draft = await workspace.invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '需返回的旧稿', body: originalBody });
    await workspace.invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: '新版已经登上渡船。' });
    const original = `/drafts/${draft.draftId}?revision=1&start=3&end=12#passage-body`;
    const contextual = path => {
      const url = new URL(path, workspace.origin);
      url.searchParams.set('returnTo', original);
      return url.pathname + url.search + url.hash;
    };
    const characterPath = `/characters/${character.characterId}?revision=1`;
    const sourcePath = `/sources/${source.sourceId}?revision=1&start=${range.start}&end=${range.end}`;
    report.fixture = { characterPath, sourcePath, original, range, excerpt };
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: workspace.origin, viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    context.on('page', page => {
      page.setDefaultTimeout(10_000);
      page.on('pageerror', error => report.pageErrors.push(error.message));
    });
    const page = await context.newPage();
    for (const [name, fromDomain, from, label, targetDomain, target, mode] of [
      ['character-reference', 'character', characterPath, '角色 · 第 2 版', 'character', `/characters/${other.characterId}?revision=2`, 'control'],
      ['character-source-range', 'character', characterPath, '资料 · 第 1 版', 'source', sourcePath, 'copied'],
      ['source-original-range', 'source', sourcePath, `原文位置 ${range.start}–${range.end}`, 'source', sourcePath, 'middle'],
      ['source-original-record', 'source', sourcePath, '原文 · 第 1 版', 'source', `/sources/${source.sourceId}?revision=1`, 'copied'],
      ['source-character-evidence', 'source', sourcePath, '原稿中的巡灯人 · 第 1 版 · 第二次通知', 'character', characterPath, 'control'],
    ]) {
      await t.test(name, async () => {
        await page.goto(contextual(from));
        await settled(page, fromDomain);
        if (fromDomain === 'source') await expand(page, '引用这条资料的内容');
        const anchor = link(page, label);
        const copiedHref = await anchor.getAttribute('href');
        const destination = new URL(copiedHref, workspace.origin);
        assert.deepEqual(destination.searchParams.getAll('returnTo'), [original], 'the href itself contains exactly one validated return target');
        assert.equal(destination.href, new URL(contextual(target), workspace.origin).href, 'revision and source range remain exact');
        const record = { name, mode, from: page.url(), href: copiedHref };
        report.cases.push(record);
        let opened;
        try {
          if (mode === 'copied') {
            opened = await context.newPage();
            await opened.goto(destination.href);
          } else {
            [opened] = await Promise.all([context.waitForEvent('page'), anchor.click(mode === 'middle' ? { button: 'middle' } : { modifiers: ['Control'] })]);
            await opened.waitForURL(destination.href);
          }
          await settled(opened, targetDomain);
          assert.equal(await link(opened, '返回原稿').getAttribute('href'), original);
          assert.deepEqual(new URL(opened.url()).searchParams.getAll('returnTo'), [original]);
          if (targetDomain === 'source') {
            assert.equal(await opened.locator('#passage-body').textContent(), body);
            if (target === sourcePath) assert.equal(await opened.locator('#passage-body mark').textContent(), excerpt);
            else assert.equal(await opened.locator('#passage-body mark').count(), 0);
          } else assert.equal(await opened.locator('.characters-persona .characters-prose').textContent(), name === 'character-reference' ? '第二版设定。' : '旧版巡灯设定。');
          await opened.reload();
          await settled(opened, targetDomain);
          assert.equal(await link(opened, '返回原稿').getAttribute('href'), original);
          record.screenshot = `${name}.png`;
          await opened.screenshot({ path: resolve(output, record.screenshot), animations: 'disabled' });
          const returnHref = await link(opened, '返回原稿').getAttribute('href');
          await opened.goto(new URL(returnHref, workspace.origin).href);
          await opened.locator('#passage-body').waitFor();
          const returned = new URL(opened.url());
          assert.equal(returned.pathname + returned.search + returned.hash, original);
          assert.equal(await opened.locator('#passage-body').textContent(), originalBody, 'the copied return href reads the old draft, not its latest revision');
          record.returned = returned.href;
          record.passed = true;
        } finally { await opened?.close(); }
      });
    }
    await t.test('invalid context and unrelated or external destinations remain unchanged', async () => {
      for (const [domain, path, label, expected] of [
        ['character', characterPath, '角色 · 第 2 版', `/characters/${other.characterId}?revision=2`],
        ['source', sourcePath, `原文位置 ${range.start}–${range.end}`, sourcePath],
      ]) {
        for (const query of [
          `returnTo=${encodeURIComponent('https://outside.test/drafts/id')}`,
          `returnTo=${encodeURIComponent(original)}&returnTo=${encodeURIComponent(original)}`,
        ]) {
          await page.goto(`${path}&${query}`);
          await settled(page, domain);
          if (domain === 'source') await expand(page, '引用这条资料的内容');
          assert.equal(await link(page, '返回原稿').count(), 0);
          assert.equal(await link(page, label).getAttribute('href'), expected);
        }
        await page.goto(contextual(path));
        await settled(page, domain);
        // Exercise the existing delegated-click boundary without leaving the isolated service.
        const external = 'https://outside.test/sources/notice?revision=2#location';
        const observed = await page.evaluate(({ domain, external }) => {
          const root = document.querySelector(domain === 'character' ? '.characters-route > section' : '.sources-route');
          const anchor = document.createElement('a');
          anchor.href = external;
          root.append(anchor);
          let result;
          document.addEventListener('click', event => {
            result = { href: anchor.getAttribute('href'), defaultPrevented: event.defaultPrevented };
            event.preventDefault();
          }, { once: true });
          anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          anchor.remove();
          return result;
        }, { domain, external });
        assert.deepEqual(observed, { href: external, defaultPrevented: false });
      }
      await expand(page, '引用这条资料的内容');
      assert.equal(await link(page, '日记 · 有位置的引用 · 第 1 版').getAttribute('href'), `/diaries/${diary.noteId}?revision=1`);
      report.boundaries = 'passed';
    });
    assert.deepEqual(await workspace.inspectServedBundle(), report.build.bundle);
    assert.deepEqual(report.pageErrors, []);
    report.status = report.cases.length === 5 && report.cases.every(record => record.passed) && report.boundaries === 'passed' ? 'passed' : 'failed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    throw error;
  } finally {
    await browser?.close();
    await workspace.close();
    await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
});

test('source child native hrefs and read-error entries preserve the verified manuscript return', { timeout: 90_000 }, async t => {
  const output = resolve(artifacts, '..', 'child-hrefs-errors');
  await mkdir(output, { recursive: true });
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  const report = { status: 'running', build: workspace.capturedBuild, cases: [], checks: [], pageErrors: [] };
  let browser;
  try {
    const body = '🚢 第一处：末班十点。\n第二处：末班十点。';
    const excerpt = '末班十点';
    const range = { start: body.lastIndexOf(excerpt), end: body.lastIndexOf(excerpt) + excerpt.length };
    const source = await workspace.invoke('source.create', { title: '子页面链接原文', kind: 'excerpt', body });
    const pin = { sourceId: source.sourceId, revision: 1, excerpt, range };
    const character = await workspace.invoke('character.create', { name: '资料影响中的角色', persona: '保留这条旧通知。', entries: [
      { label: '第二处通知', blocks: [{ type: 'reference', kind: 'source', id: source.sourceId, revision: 1, excerpt, range }] },
    ] });
    for (let index = 0; index < 21; index++) await workspace.invoke('diary.create', { title: `分页引用 ${index}`, body: '等在栈桥。', diaryDate: '2026-11-28', sourcePins: [pin] });
    const scene = await workspace.invoke('scene.create', { title: '子页面返回的原稿场景', sources: [pin] });
    const originalBody = '她在北岸听见第三声钟响，仍旧等在栈桥。';
    const draft = await workspace.invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '子页面需返回的旧稿', body: originalBody });
    await workspace.invoke('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: '新版已经登船。' });
    const original = `/drafts/${draft.draftId}?revision=1&start=3&end=12#passage-body`;
    const sourcePath = `/sources/${source.sourceId}`;
    const selected = `${sourcePath}?revision=1&start=${range.start}&end=${range.end}`;
    const impact = `${selected}&action=impact`;
    const contextual = path => {
      const url = new URL(path, workspace.origin);
      url.searchParams.set('returnTo', original);
      return url.pathname + url.search + url.hash;
    };
    report.fixture = { sourcePath, original, range, characterId: character.characterId };
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: workspace.origin, viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    context.on('page', page => {
      page.setDefaultTimeout(8_000);
      page.on('pageerror', error => report.pageErrors.push(error.message));
    });
    const page = await context.newPage();
    const impactReady = target => target.locator('[aria-label="资料影响"][aria-busy="false"]').waitFor();
    async function copied(anchor, expected, domain = 'source') {
      const href = await anchor.getAttribute('href');
      assert.equal(href, contextual(expected), 'the rendered native href preserves the destination and verified context');
      assert.deepEqual(new URL(href, workspace.origin).searchParams.getAll('returnTo'), [original]);
      const opened = await context.newPage();
      try {
        await opened.goto(href);
        await settled(opened, domain);
        assert.equal(opened.url(), new URL(href, workspace.origin).href);
        assert.deepEqual(new URL(opened.url()).searchParams.getAll('returnTo'), [original]);
        assert.equal(await link(opened, '返回原稿').getAttribute('href'), original);
        report.cases.push({ href, copiedTo: opened.url() });
      } finally { await opened.close(); }
    }
    async function copiedReturn(anchor) {
      assert.equal(await anchor.count(), 1, 'the page exposes exactly one native manuscript return link');
      const href = await anchor.getAttribute('href');
      assert.equal(href, original);
      const opened = await context.newPage();
      try {
        await opened.goto(href);
        await opened.locator('#passage-body').waitFor();
        const url = new URL(opened.url());
        assert.equal(url.pathname + url.search + url.hash, original);
        assert.equal(await opened.locator('#passage-body').textContent(), originalBody);
      } finally { await opened.close(); }
    }
    async function check(name, run) {
      const result = { name, passed: false };
      report.checks.push(result);
      await t.test(name, async () => { await run(); result.passed = true; });
    }
    for (const [name, path, destination] of [
      ['new source editor return', '/sources/new', '/sources'],
      ['revision editor return', `${sourcePath}?action=revise`, sourcePath],
    ]) await check(name, async () => {
      await page.goto(contextual(path));
      await settled(page, 'source');
      await copied(link(page, '返回'), destination);
    });
    await check('completed save recovered after unmount has a contextual native result link', async () => {
      await page.goto(contextual('/sources/new'));
      await settled(page, 'source');
      let received;
      let release;
      const seen = new Promise(resolve => { received = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/web/invoke', async route => {
        if (route.request().postDataJSON().operationId !== 'source.create') return route.continue();
        const response = await route.fetch();
        received();
        await gate;
        await route.fulfill({ response });
      });
      try {
        await page.getByLabel('标题', { exact: true }).fill('已保存结果的真实链接');
        await page.getByLabel('正文', { exact: true }).fill('保存结果只引用这份新资料。');
        await page.getByRole('button', { name: '新建资料', exact: true }).click();
        await seen;
        await link(page, '返回').click();
        await settled(page, 'source');
        const response = page.waitForResponse(response => response.url().endsWith('/api/web/invoke') && response.request().postDataJSON().operationId === 'source.create');
        release();
        await response;
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('sth:sources:draft:v1:new:') ?? 'null')?.saved);
        const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('sth:sources:draft:v1:new:')).saved);
        await page.goto(contextual('/sources/new'));
        await settled(page, 'source');
        await copied(link(page, '查看已保存资料'), saved);
      } finally { release(); await page.unroute('**/api/web/invoke'); }
    });
    await check('impact next and previous native hrefs retain submitted filters, revision and range', async () => {
      const filtered = `${impact}&kind=diary&currentOnly=1`;
      await page.goto(contextual(filtered));
      await impactReady(page);
      assert.equal(await page.locator('[aria-label="资料影响"] h2 a').count(), 20);
      await page.getByLabel('资源类型', { exact: true }).selectOption('character');
      await copied(link(page, '下一页'), `${filtered}&offset=20`);
      await page.goto(contextual(`${filtered}&offset=20`));
      await impactReady(page);
      assert.equal(await page.locator('[aria-label="资料影响"] h2 a').count(), 1);
      await copied(link(page, '上一页'), `${filtered}&offset=0`);
    });
    await check('impact resource anchors carry context only to auxiliary pages', async () => {
      await page.goto(contextual(impact));
      await impactReady(page);
      await copied(link(page, character.name), `/characters/${character.characterId}?revision=1`, 'character');
      await page.goto(contextual(`${impact}&kind=draft`));
      await impactReady(page);
      assert.deepEqual(await link(page, '场景 · 第 1 版').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href'))),
        Array(2).fill(`/scenes/${scene.sceneId}?revision=1`));
    });
    await check('impact native via rendering applies the verified contextual function', async () => {
      // Isolate the supported character-via rendering branch; this is a link contract fixture, not a persisted relation.
      await page.route('**/api/web/invoke', async route => {
        if (route.request().postDataJSON().operationId !== 'source.impact') return route.continue();
        const response = await route.fetch();
        const data = await response.json();
        data.result.items[0].via = [{ kind: 'character', id: character.characterId, revision: 1 }];
        await route.fulfill({ response, json: data });
      });
      try {
        await page.goto(contextual(`${impact}&kind=character`));
        await impactReady(page);
        await copied(link(page, '角色 · 第 1 版'), `/characters/${character.characterId}?revision=1`, 'character');
      } finally { await page.unroute('**/api/web/invoke'); }
    });
    for (const [domain, path, operation, listLabel, list] of [
      ['source', selected, 'source.read', '返回资料', '/sources'],
      ['character', `/characters/${character.characterId}?revision=1`, 'character.read', '返回角色', '/characters'],
    ]) {
      await check(`${domain} read errors expose a native manuscript return`, async () => {
        for (const status of [403, 404, 503]) {
          await page.route('**/api/web/invoke', route => route.request().postDataJSON().operationId === operation
            ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable' } }) }) : route.continue());
          try {
            await page.goto(contextual(path));
            await page.getByRole('heading', { name: '页面暂时无法打开', exact: true }).waitFor();
            await copiedReturn(link(page, '返回原稿'));
            assert.equal(await link(page, listLabel).count(), 0);
            if (status === 503) await page.screenshot({ path: resolve(output, `${domain}-read-error.png`), animations: 'disabled' });
            report.cases.push({ domain, status, returnHref: original });
          } finally { await page.unroute('**/api/web/invoke'); }
        }
      });
      await check(`${domain} read errors retain the original list fallback for absent or invalid context`, async () => {
        await page.route('**/api/web/invoke', route => route.request().postDataJSON().operationId === operation
          ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable' } }) }) : route.continue());
        try {
          for (const suffix of ['', `&returnTo=${encodeURIComponent('https://outside.test/drafts/id')}`, `&returnTo=${encodeURIComponent(original)}&returnTo=${encodeURIComponent(original)}`]) {
            await page.goto(path + suffix);
            await page.getByRole('heading', { name: '页面暂时无法打开', exact: true }).waitFor();
            assert.equal(await link(page, '返回原稿').count(), 0);
            assert.equal(await link(page, listLabel).getAttribute('href'), list);
          }
        } finally { await page.unroute('**/api/web/invoke'); }
      });
      await check(`${domain} list errors keep the existing toolbar return visible`, async () => {
        await page.route('**/api/web/invoke', route => route.request().postDataJSON().operationId === operation.replace('.read', '.list')
          ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable' } }) }) : route.continue());
        try {
          await page.goto(contextual(list));
          await settled(page, domain);
          await page.getByRole('alert').first().waitFor();
          assert.equal(await link(page, '返回原稿').isVisible(), true);
          await copiedReturn(link(page, '返回原稿'));
        } finally { await page.unroute('**/api/web/invoke'); }
      });
    }
    assert.deepEqual(await workspace.inspectServedBundle(), report.build.bundle);
    assert.deepEqual(report.pageErrors, []);
    report.status = report.checks.length === 12 && report.checks.every(check => check.passed) ? 'passed' : 'failed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    throw error;
  } finally {
    await browser?.close();
    await workspace.close();
    await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
});

async function expand(page, name) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${name}$`) });
  if (!await summary.evaluate(element => element.parentElement.open)) await summary.click();
}

async function settled(page, domain) {
  await page.locator(domain === 'character'
    ? '.characters-route > section[aria-busy="false"]'
    : '.sources-route[aria-busy="false"]').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await page.getByRole('heading', { name: '页面暂时无法打开', exact: true }).count(), 0);
}

function geometry(selector) {
  const body = document.querySelector(selector);
  const rect = body.getBoundingClientRect();
  const style = getComputedStyle(body);
  const toolbar = document.querySelector('.characters-toolbar, .sources-toolbar');
  return {
    viewport: innerWidth, document: document.documentElement.scrollWidth,
    top: rect.top, left: rect.left, right: rect.right, width: rect.width,
    font: style.fontFamily, size: style.fontSize, leading: style.lineHeight, color: style.color,
    toolbarHeight: toolbar?.getBoundingClientRect().height,
    visibleOverflow: [...document.querySelectorAll('main *')].filter(element => {
      if (!element.getClientRects().length) return false;
      const box = element.getBoundingClientRect();
      return box.left < -1 || box.right > innerWidth + 1;
    }).map(element => ({ tag: element.tagName, className: element.className })),
  };
}

test('real reference pages preserve historical identity, ranges and return context at every reading width', { timeout: 180_000 }, async t => {
  await mkdir(artifacts, { recursive: true });
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  const report = { status: 'running', build: workspace.capturedBuild, cases: [] };
  const writeReport = () => writeFile(resolve(artifacts, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  try {
    const project = await workspace.invoke('project.create', { title: '第三声以后' });
    const persona = '北港巡灯人。每到雨夜都会把一封未拆的信收进衣袋。只知道自己看见与听见的事情。';
    const character = await workspace.invoke('character.create', {
      projectId: project.projectId, name: '林澈', persona,
      entries: [{ label: '值夜习惯', blocks: [{ type: 'text', text: '听见第三声钟响时，先望向北岸。' }] }],
    });
    await workspace.invoke('character.revise', {
      characterId: character.characterId, expectedRevision: 1, persona: `${persona}\n后续设定补记，她在对岸学会修船。`,
    });
    const body = '🚢 北港值夜簿\n第一声钟响，收起北岸的缆绳。\n第三声钟响，末班渡船离开北岸。\n第三声钟响，末班渡船离开北岸。\n旧值夜簿没有写明她在等待谁。';
    const excerpt = '第三声钟响，末班渡船离开北岸。';
    const start = body.lastIndexOf(excerpt);
    const range = { start, end: start + excerpt.length };
    const source = await workspace.invoke('source.create', {
      title: '北港值夜簿 · 雨夜抄本', kind: 'excerpt', body,
      projectIds: [project.projectId], origin: '北岸灯房，十一月雨夜抄本。',
    });
    await workspace.invoke('source.revise', {
      sourceId: source.sourceId, expectedRevision: 1, body: `${body}\n后附校订，渡船改在第二声后离港。`,
    });
    const scene = await workspace.invoke('scene.create', { title: '栈桥尽头' });
    const draft = await workspace.invoke('draft.create', {
      sceneId: scene.sceneId, sceneRevision: 1, title: '第三声以后',
      body: '她站在栈桥尽头，听见第三声钟响。\n\n她把信放回衣袋，走向渡船。',
    });
    const original = `/drafts/${draft.draftId}?revision=1&start=0&end=8#passage-body`;
    const contextual = path => `${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(original)}`;
    const characterPath = `/characters/${character.characterId}`;
    const sourcePath = `/sources/${source.sourceId}`;
    const oldSource = contextual(`${sourcePath}?revision=1&start=${range.start}&end=${range.end}`);
    report.fixture = { characterId: character.characterId, sourceId: source.sourceId, original, body, range, excerpt };

    for (const [engineName, engine, sizes] of [
      ['chromium', chromium, [[1280, 800], [768, 1024], [390, 844], [320, 640]]],
      ['webkit', webkit, [[390, 844], [320, 640]]],
    ]) {
      const browser = await engine.launch();
      try {
        for (const [width, height] of sizes) {
          await t.test(`${engineName} ${width}px`, async () => {
            const context = await browser.newContext({ baseURL: workspace.origin, viewport: { width, height }, locale: 'zh-CN' });
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);
            const record = { engine: engineName, browser: browser.version(), width, height, pageErrors: [], captures: [] };
            report.cases.push(record);
            page.on('pageerror', error => record.pageErrors.push(error.message));
            async function capture(name, selector, reading = false) {
              await page.evaluate(() => window.scrollTo(0, 0));
              const measured = await page.evaluate(geometry, selector);
              const screenshot = `${engineName}-${width}-${name}.png`;
              record.captures.push({ name, url: page.url(), ...measured, screenshot });
              await page.screenshot({ path: resolve(artifacts, screenshot), animations: 'disabled' });
              assert.equal(measured.document, width, 'the whole page fits without clipping');
              assert.deepEqual(measured.visibleOverflow, []);
              assert.equal(measured.color, 'rgb(37, 37, 37)');
              if (reading) {
                assert.equal(measured.size, '18px');
                assert.ok(Math.abs(parseFloat(measured.leading) - 32.4) < .001, measured.leading);
                assert.ok(measured.toolbarHeight <= 85, `toolbar ${measured.toolbarHeight}px`);
                if (width < 640) assert.ok(measured.top < 280, `first text starts at ${measured.top}px`);
              } else if (width < 640) assert.ok(measured.top < 340, `first list item starts at ${measured.top}px`);
            }
            try {
              await page.goto(contextual(`${characterPath}?revision=1`));
              await settled(page, 'character');
              assert.equal(await page.locator('.characters-persona .characters-prose').textContent(), persona);
              assert.match(await page.locator('.characters-title').innerText(), /历史版本 · 第 1 版/);
              assert.equal(await link(page, '返回原稿').getAttribute('href'), original);
              assert.equal(await page.locator('details[open]').count(), 0);
              await capture('character-old', '.characters-persona .characters-prose', true);
              await expand(page, '更多');
              assert.equal(await link(page, '编辑设定').count(), 0);
              await capture('character-actions', '.characters-persona .characters-prose', true);
              await link(page, '查看当前版本').click();
              await settled(page, 'character');
              assert.equal(new URL(page.url()).searchParams.get('returnTo'), original);
              assert.match(await page.locator('.characters-title').innerText(), /当前版本 · 第 2 版/);
              assert.match(await page.locator('.characters-persona .characters-prose').textContent(), /学会修船/);
              await capture('character-current', '.characters-persona .characters-prose', true);
              await expand(page, '版本历史');
              await link(page, '第 1 版').click();
              await settled(page, 'character');
              await page.reload();
              await settled(page, 'character');
              assert.equal(await page.locator('.characters-persona .characters-prose').textContent(), persona);
              assert.equal(await link(page, '返回原稿').getAttribute('href'), original);

              await page.goto(oldSource);
              await settled(page, 'source');
              assert.equal(await page.locator('#passage-body').textContent(), body);
              assert.equal(await page.locator('#passage-body mark').textContent(), excerpt);
              assert.match(await page.locator('.sources-title').innerText(), /历史版本 · 第 1 版/);
              assert.equal(await page.locator('details[open]').count(), 0);
              await capture('source-old-range', '#passage-body', true);
              await page.reload();
              await settled(page, 'source');
              assert.equal(await page.locator('#passage-body mark').textContent(), excerpt);
              assert.equal(new URL(page.url()).searchParams.get('start'), String(range.start));
              await expand(page, '更多');
              assert.equal(await link(page, '修订资料').count(), 0);
              await capture('source-actions', '#passage-body', true);
              await link(page, '查看当前版本').click();
              await settled(page, 'source');
              assert.equal(new URL(page.url()).searchParams.get('returnTo'), original);
              assert.equal(await page.locator('#passage-body mark').count(), 0, 'an old range never transfers to a newer revision');
              assert.match(await page.locator('.sources-title').innerText(), /当前版本 · 第 2 版/);
              await capture('source-current', '#passage-body', true);
              await expand(page, '资料信息');
              await page.getByText(source.origin, { exact: true }).waitFor();
              await capture('source-information', '#passage-body', true);
              await expand(page, '版本历史');
              await link(page, '第 1 版').click();
              await settled(page, 'source');
              assert.equal(await link(page, '返回原稿').getAttribute('href'), original);
              assert.equal(await page.locator('#passage-body').textContent(), body);
              await page.goto(oldSource);
              await settled(page, 'source');
              await page.getByRole('button', { name: '采纳为角色条目', exact: true }).click();
              await page.getByRole('heading', { name: '采纳为角色条目', exact: true }).waitFor();
              assert.equal(new URL(page.url()).searchParams.get('returnTo'), original);
              assert.equal(new URL(page.url()).searchParams.get('start'), String(range.start));
              assert.equal(new URL(page.url()).searchParams.get('end'), String(range.end));
              await link(page, '返回原稿').click();
              await page.waitForURL(url => url.pathname === `/drafts/${draft.draftId}` && url.hash === '#passage-body');
              await page.locator('#passage-body').waitFor();
              assert.equal(new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash, original);

              await page.goto(contextual(`/characters?projectId=${project.projectId}`));
              await settled(page, 'character');
              assert.equal(await page.locator('.characters-filter select').isVisible(), false);
              await capture('character-index', '.characters-list > li');
              await expand(page, '筛选');
              await page.getByLabel('项目', { exact: true }).selectOption('');
              await settled(page, 'character');
              assert.equal(new URL(page.url()).searchParams.get('returnTo'), original);
              await page.goto(contextual(`/sources?projectId=${project.projectId}`));
              await settled(page, 'source');
              assert.equal(await page.getByLabel('关键词', { exact: true }).isVisible(), false);
              await capture('source-index', '#workspace-list li');
              await page.locator('.sources-filter-disclosure > summary').click();
              await page.getByLabel('关键词', { exact: true }).fill('北港');
              await page.getByRole('button', { name: '搜索', exact: true }).click();
              await settled(page, 'source');
              assert.equal(new URL(page.url()).searchParams.get('returnTo'), original);
              await link(page, source.title).click();
              await settled(page, 'source');
              assert.equal(await link(page, '返回原稿').getAttribute('href'), original);
              assert.deepEqual(record.pageErrors, []);
              record.passed = true;
            } finally { await context.close(); }
          });
        }
      } finally { await browser.close(); }
    }

    await t.test('invalid return links stay absent and internal saves retain valid context', async () => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ baseURL: workspace.origin, viewport: { width: 390, height: 844 } });
        page.setDefaultTimeout(10_000);
        for (const [domain, path] of [['character', characterPath], ['source', sourcePath]]) {
          for (const value of ['https://outside.test/drafts/id', '/drafts/id?action=revise', '/sources/id']) {
            await page.goto(`${path}?returnTo=${encodeURIComponent(value)}`);
            await settled(page, domain);
            assert.equal(await link(page, '返回原稿').count(), 0);
          }
          await page.goto(contextual(path));
          await settled(page, domain);
          await expand(page, '更多');
          await link(page, domain === 'character' ? '编辑设定' : '修订资料').click();
          await page.getByRole('heading', { name: domain === 'character' ? '编辑角色' : '修订资料', exact: true }).waitFor();
          const content = domain === 'character' ? `${persona}\n保存后的角色补记。` : `${body}\n保存后的资料补记。`;
          await page.getByLabel(domain === 'character' ? '角色设定' : '正文', { exact: true }).fill(content);
          await page.getByRole('button', { name: domain === 'character' ? '保存设定' : '保存修订', exact: true }).click();
          await page.waitForURL(url => !url.searchParams.has(domain === 'character' ? 'edit' : 'action'));
          await settled(page, domain);
          assert.equal(await link(page, '返回原稿').getAttribute('href'), original);
          const saved = await workspace.invoke(domain === 'character' ? 'character.read' : 'source.read', domain === 'character' ? { characterId: character.characterId } : { sourceId: source.sourceId });
          assert.equal(saved.revision, 3);
          assert.equal(domain === 'character' ? saved.persona : saved.body, content);
          await page.reload();
          await settled(page, domain);
          assert.equal(new URL(page.url()).searchParams.get('returnTo'), original);
        }
        await page.goto(contextual(`${sourcePath}?revision=1&start=999999&end=1000000`));
        await settled(page, 'source');
        assert.equal(await page.locator('#passage-body mark').count(), 0);
        await page.getByRole('button', { name: '采纳为角色条目', exact: true }).click();
        assert.equal(await page.locator('#passage-status').textContent(), '请先选中一段原文。');
        report.returnValidation = 'passed';
      } finally { await browser.close(); }
    });
    assert.deepEqual(await workspace.inspectServedBundle(), report.build.bundle);
    report.status = report.cases.every(record => record.passed) && report.returnValidation === 'passed' ? 'passed' : 'failed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    throw error;
  } finally {
    await writeReport();
    await workspace.close();
  }
});
