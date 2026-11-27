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
