import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { createManuscriptFixture, startManuscriptWorkspace, writeJson } from '../../scripts/manuscript-fixture.mjs';

const passage = '#passage-body';
const mark = `${passage} mark`;
const backLink = page => page.getByRole('link', { name: '返回原稿', exact: true });
const layouts = [
  [chromium, 'desktop', { width: 1280, height: 800 }],
  [chromium, 'phone', { width: 390, height: 844 }],
  [webkit, 'phone', { width: 390, height: 844 }],
];

test('multi-hop reference history and copied links keep the original reader', { timeout: 120_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  for (const [engine, layout, viewport] of layouts) {
    const browser = await engine.launch();
    try {
      await t.test(`${engine.name()}-${layout}`, async subtest => {
        const page = await openPage(subtest, browser, workspace.origin, viewport, layout === 'phone');
        const readerHref = fixture.links.oldPassage + '#passage-body';
        await page.goto(readerHref);
        await page.waitForFunction(selector => document.activeElement?.matches(selector), mark);
        await settle(page);
        if (layout === 'phone') {
          await page.getByRole('button', { name: '返回文稿列表', exact: true }).click();
          await page.locator('.library-sheet[aria-current="page"]').click();
          await page.locator(mark).waitFor();
          await settle(page);
          assert.equal(new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash, readerHref);
        }
        await page.evaluate(() => {
          history.replaceState({ ...history.state, manuscriptPane: 'editor', navigationFixture: 'multi-hop entry' }, '');
          document.querySelector('#passage-body mark').focus({ preventScroll: true });
          window.scrollBy({ top: -96, behavior: 'instant' });
        });
        const before = await inspect(page);
        await openEvidenceLink(page, fixture.links.character);
        await page.getByRole('heading', { name: fixture.character.name, exact: true, level: 1 }).waitFor();
        await page.locator('.characters-disclosure > summary').click();
        await page.locator('.characters-history').getByRole('link', { name: '第 2 版', exact: true }).click();
        await page.getByText(fixture.characterV2.persona, { exact: true }).waitFor();
        const copiedReference = page.url();
        assert.equal(new URL(copiedReference).searchParams.get('returnTo'), readerHref);
        await page.goBack();
        await page.getByText(fixture.character.persona, { exact: true }).waitFor();
        await page.goForward();
        await page.getByText(fixture.characterV2.persona, { exact: true }).waitFor();
        if (engine === chromium && layout === 'phone') {
          await page.reload();
          await page.getByText(fixture.characterV2.persona, { exact: true }).waitFor();
        }
        const returnCount = await backLink(page).count();
        await page.locator('.characters-back').click();
        await page.locator(mark).waitFor();
        await waitForReadingReturn(page, before);
        const after = await inspect(page);
        assert.equal(after.href, before.href, 'the return skips all reference hops');
        assert.deepEqual(after.scroll, before.scroll, 'multi-hop return restores the exact viewport');
        assert.equal(after.markTop, before.markTop);
        assert.equal(after.focus, before.focus);
        assert.equal(after.fixtureState, before.fixtureState, 'return reuses the original history entry');
        assert.equal(returnCount, 1, 'only the reference toolbar owns the return link');
        // A copied auxiliary URL has no saved reader history. Its real link must
        // still open the exact revision and selected paragraph in a fresh tab.
        const copied = await page.context().newPage();
        try {
          await copied.goto(copiedReference);
          await copied.getByText(fixture.characterV2.persona, { exact: true }).waitFor();
          await backLink(copied).click();
          await copied.locator(mark).waitFor();
          await settle(copied);
          const returned = await inspect(copied);
          assert.equal(returned.href, readerHref);
          assert.equal(returned.revision, '1');
          assert.equal(returned.mark, fixture.target.excerpt);
          assert.equal(returned.fixtureState, null, 'a new tab does not invent original history');
          assert.ok(returned.markTop >= 0 && returned.markTop < viewport.height);
          assert.equal(await copied.locator(passage).textContent(), fixture.bodies.old);
        } finally { await copied.close(); }
      });
    } finally { await browser.close(); }
  }
});

test('return history rejects incomplete state and keeps ordinary library navigation unchanged', { timeout: 60_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await t.test('a depth without a valid reader does not propagate', async subtest => {
    const page = await openPage(subtest, browser, workspace.origin, { width: 1280, height: 800 });
    await page.goto('/settings');
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.evaluate(() => history.replaceState({ sthManuscriptReturnDepth: 1 }, ''));
    await page.locator('#library-navigation').getByRole('link', { name: '任务', exact: true }).click();
    await page.waitForURL('**/jobs');
    assert.equal(await page.evaluate(() => history.state?.sthManuscriptReturnDepth), undefined);
    assert.equal(await backLink(page).count(), 0);
  });
  for (const [name, path] of [['作品角色', '/characters'], ['作品资料', '/sources']]) {
    await t.test(`${name} stays an ordinary index entry`, async subtest => {
      const page = await openPage(subtest, browser, workspace.origin, { width: 1280, height: 800 });
      await page.goto(fixture.links.oldDraft);
      await page.locator(passage).waitFor();
      await page.getByRole('link', { name, exact: true }).click();
      await page.waitForURL(url => url.pathname === path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => history.state?.sthManuscriptReturn), undefined);
      assert.equal(await backLink(page).count(), 0);
    });
  }
  await t.test('a canceled history traversal leaves the next return click usable', async subtest => {
    const page = await openPage(subtest, browser, workspace.origin, { width: 1280, height: 800 });
    await page.goto(fixture.links.oldPassage);
    await page.locator(mark).waitFor();
    await openEvidenceLink(page, fixture.links.character);
    await page.getByRole('heading', { name: fixture.character.name, level: 1, exact: true }).waitFor();
    // Fault injection: a browser may cancel a traversal without a popstate.
    await page.evaluate(() => { window.__returnAttempts = 0; history.go = () => { window.__returnAttempts++; }; });
    await backLink(page).click();
    await page.waitForTimeout(1700);
    await backLink(page).click();
    await page.locator(mark).waitFor({ timeout: 2500 });
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, fixture.links.oldPassage);
    assert.equal(await page.evaluate(() => window.__returnAttempts), 1);
  });
  for (const mode of ['missing-token', 'out-of-range']) {
    await t.test(`${mode} history uses the validated manuscript link`, async subtest => {
      const page = await openPage(subtest, browser, workspace.origin, { width: 1280, height: 800 });
      await page.goto(fixture.links.oldPassage);
      await page.locator(mark).waitFor();
      await openEvidenceLink(page, fixture.links.character);
      await page.getByRole('heading', { name: fixture.character.name, level: 1, exact: true }).waitFor();
      await page.evaluate(mode => {
        const state = { ...history.state };
        if (mode === 'missing-token') delete state.sthManuscriptReturnToken;
        else state.sthManuscriptReturnDepth = history.length;
        history.replaceState(state, '');
        history.go = () => { throw new Error('Unverifiable history must not be traversed'); };
      }, mode);
      await backLink(page).click();
      await page.locator(mark).waitFor({ timeout: 2500 });
      assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, fixture.links.oldPassage);
      assert.equal(await page.locator(passage).textContent(), fixture.bodies.old);
    });
  }
});

function inspect(page) {
  return page.evaluate(({ passage, mark }) => ({
    href: location.pathname + location.search + location.hash,
    revision: document.querySelector('[aria-label="切换稿件版本"]')?.value ?? null,
    scroll: { x: scrollX, y: scrollY },
    mark: document.querySelector(mark)?.textContent ?? null,
    markTop: document.querySelector(mark)?.getBoundingClientRect().top ?? null,
    focus: document.activeElement?.matches(mark) ? mark : document.activeElement?.matches(passage)
      ? passage : document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
    pane: history.state?.manuscriptPane ?? null,
    fixtureState: history.state?.navigationFixture ?? null,
    savedScroll: history.state?.sthManuscriptPosition
      ? { x: history.state.sthManuscriptPosition.x, y: history.state.sthManuscriptPosition.y } : null,
    length: history.length,
    locked: document.body.style.position === 'fixed',
    inert: document.querySelectorAll('[inert]').length,
  }), { passage, mark });
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame);
  });
}

async function waitForReadingReturn(page, before) {
  await page.waitForFunction(({ href, focus, scroll }) =>
    location.pathname + location.search + location.hash === href &&
    document.activeElement?.matches(focus) && window.scrollX === scroll.x && window.scrollY === scroll.y,
  before, { timeout: 3_000 }).catch(error => {
    if (error.name !== 'TimeoutError') throw error;
  });
  await settle(page);
}

async function openEvidenceLink(page, href) {
  const manuscript = new URL(page.url());
  const toolbar = page.getByRole('navigation', { name: '读写工具' });
  await toolbar.getByRole('button', { name: '来源与依据', exact: true }).click();
  const panel = page.locator('.evidence-panel');
  await panel.locator('.evidence-scene-links summary').click();
  const expected = new URL(href, page.url());
  expected.searchParams.set('returnTo', manuscript.pathname + manuscript.search + manuscript.hash);
  const link = panel.locator(`.evidence-scene-links a[href="${expected.pathname + expected.search + expected.hash}"]`);
  assert.equal(new URL(await link.getAttribute('href'), page.url()).href, expected.href,
    'the real revision-pinned evidence link preserves the complete manuscript return URL');
  await link.click();
}

async function capture(page, directory, label, stage) {
  if (directory) await page.screenshot({ path: join(directory, `${label}-${stage}.png`), animations: 'disabled' });
}

async function openPage(t, browser, origin, viewport, phone = false) {
  const context = await browser.newContext({ baseURL: origin, viewport, locale: 'zh-CN',
    isMobile: phone, hasTouch: phone });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
  return page;
}

test('return to the same manuscript revision, passage and viewport from evidence', { timeout: 180_000 }, async t => {
  const workspace = await startManuscriptWorkspace({ ui: 'snapshot' });
  t.after(workspace.close);
  const fixture = await createManuscriptFixture(workspace.invoke);
  const directory = process.env.STH_NAVIGATION_ARTIFACTS;
  const records = [];
  if (directory) {
    await mkdir(directory, { recursive: true });
    t.after(() => writeJson(join(directory, 'manifest.json'), {
      build: workspace.capturedBuild,
      servedBundle: workspaceBundle,
      fixture: { provenance: fixture.provenance, contentSha256: fixture.contentSha256 },
      records,
    }));
  }
  const workspaceBundle = await workspace.inspectServedBundle();
  assert.deepEqual(workspaceBundle, workspace.capturedBuild.bundle);

  for (const [engine, layout, viewport] of layouts) {
    const browser = await engine.launch();
    try {
      const paths = [['character', 'back'], ['source', 'back'], ['character', 'link'], ['source', 'link'],
        ...(engine === chromium && layout === 'phone' ? [['character', 'reload']] : [])];
      for (const [resource, mode] of paths) {
        const label = `${engine.name()}-${layout}-${resource}-${mode}`;
        await t.test(label, async subtest => {
          const page = await openPage(subtest, browser, workspace.origin, viewport, layout === 'phone');

          assert.equal((await page.goto(fixture.links.oldPassage)).status(), 200);
          await page.waitForFunction(selector => document.activeElement?.matches(selector), mark);
          await settle(page);
          const direct = await inspect(page);
          assert.equal(direct.href, fixture.links.oldPassage);
          assert.equal(direct.revision, '1');
          assert.equal(direct.mark, fixture.target.excerpt);
          assert.equal(await page.locator(passage).textContent(), fixture.bodies.old);
          assert.ok(direct.markTop >= 0 && direct.markTop < viewport.height, 'direct link puts its marked passage on screen');

          await page.evaluate(() => {
            history.replaceState({ ...history.state, manuscriptPane: 'editor', navigationFixture: 'original entry' }, '');
            window.scrollBy({ top: -96, behavior: 'instant' });
          });
          await settle(page);
          const before = await inspect(page);
          assert.equal(direct.scroll.y - before.scroll.y, 96, 'the author moved away from the assistant link position');
          await capture(page, directory, label, 'before');

          await openEvidenceLink(page, fixture.links[resource]);
          const title = resource === 'source' ? fixture.source.title : fixture.character.name;
          await page.getByRole('heading', { name: title, level: 1, exact: true }).waitFor();
          if (mode === 'reload') {
            await page.reload();
            await page.getByRole('heading', { name: title, level: 1, exact: true }).waitFor();
          }
          await settle(page);
          const auxiliary = await inspect(page);
          const returnLink = await backLink(page).getAttribute('href');
          await capture(page, directory, label, 'auxiliary');

          if (mode === 'link' || mode === 'reload') await backLink(page).click();
          else await page.goBack();
          await page.locator(mark).waitFor();
          await waitForReadingReturn(page, before);
          const after = await inspect(page);
          await capture(page, directory, label, 'after');
          records.push({ label, viewport, direct, before, auxiliary, returnLink, after });

          const auxiliaryUrl = new URL(auxiliary.href, workspace.origin);
          assert.equal(auxiliaryUrl.searchParams.getAll('returnTo').length, 1);
          assert.equal(auxiliaryUrl.searchParams.get('returnTo'), before.href);
          auxiliaryUrl.searchParams.delete('returnTo');
          assert.equal(auxiliaryUrl.pathname + auxiliaryUrl.search + auxiliaryUrl.hash, fixture.links[resource]);
          assert.equal(new URL(returnLink, workspace.origin).href, workspace.origin + before.href);
          assert.equal(auxiliary.locked, false, 'the modal lock is removed on leaving the manuscript');
          assert.equal(auxiliary.inert, 0);
          assert.equal(after.href, before.href);
          assert.equal(after.revision, before.revision);
          assert.equal(after.mark, before.mark);
          assert.equal(await page.locator(passage).textContent(), fixture.bodies.old);
          assert.equal(after.focus, before.focus, 'focus returns to the reading passage');
          assert.equal(after.pane, before.pane);
          assert.equal(after.fixtureState, before.fixtureState);
          assert.equal(after.length, auxiliary.length, 'returning does not create an entry');
          assert.deepEqual(after.savedScroll, before.scroll, 'the original history entry stores the exact viewport');
          assert.deepEqual(after.scroll, before.scroll, 'restore the exact reading viewport');
          assert.equal(after.markTop, before.markTop, 'restore the marked passage to its original screen position');
        });
      }

      if (layout !== 'desktop') continue;
      await t.test('old version without an excerpt restores focus to the manuscript body', async subtest => {
        const page = await openPage(subtest, browser, workspace.origin, viewport);
        await page.goto(fixture.links.oldDraft);
        await page.locator(passage).waitFor();
        await settle(page);
        await page.evaluate(selector => {
          document.querySelector(selector).focus({ preventScroll: true });
          window.scrollTo({ top: 325, behavior: 'instant' });
        }, passage);
        await settle(page);
        const before = await inspect(page);
        await openEvidenceLink(page, fixture.links.character);
        await backLink(page).click();
        await page.locator(passage).waitFor();
        await waitForReadingReturn(page, before);
        const after = await inspect(page);
        assert.ok(before.scroll.y > 0);
        assert.deepEqual(after, { ...before, length: before.length + 1, savedScroll: before.scroll });
        assert.equal(after.revision, '1');
        assert.equal(after.focus, passage);
        assert.equal(after.mark, null);
        records.push({ label: 'chromium-desktop-old-version', viewport, before, after });
      });

      await t.test('moving forward during a delayed Back leaves the auxiliary page in place', async subtest => {
        const page = await openPage(subtest, browser, workspace.origin, viewport);
        await page.goto(fixture.links.oldPassage);
        await page.waitForFunction(selector => document.activeElement?.matches(selector), mark);
        await openEvidenceLink(page, fixture.links.character);
        const heading = page.getByRole('heading', { name: fixture.character.name, level: 1, exact: true });
        await heading.waitFor();
        const referenceHref = new URL(page.url()).pathname + new URL(page.url()).search;

        const requested = Promise.withResolvers();
        const release = Promise.withResolvers();
        const handled = Promise.withResolvers();
        await page.route('**/api/web/invoke', async route => {
          if (route.request().postDataJSON().operationId !== 'draft.read') return route.continue();
          requested.resolve();
          await release.promise;
          try { await route.continue(); } finally { handled.resolve(); }
        });

        try {
          await page.goBack();
          await requested.promise;
          await page.goForward();
          await heading.waitFor();
          await settle(page);
          const before = await inspect(page);
          release.resolve();
          await handled.promise;
          await settle(page);
          const after = await inspect(page);
          assert.equal(after.href, referenceHref);
          assert.deepEqual(after, before);
          assert.equal(await page.locator(passage).count(), 0);
          assert.equal(await backLink(page).count(), 1);
          records.push({ label: 'chromium-desktop-forward-race', viewport, before, after });
        } finally {
          release.resolve();
          await page.unrouteAll({ behavior: 'wait' });
        }
      });

      await t.test('external entry does not acquire manuscript return context', async subtest => {
        const page = await openPage(subtest, browser, workspace.origin, viewport);
        const external = 'http://external.example/';
        await page.route(external, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
          `<a href="${workspace.origin}${fixture.links.character}">Character</a>` }));
        assert.equal((await page.goto(external)).status(), 200);
        await page.getByRole('link', { name: 'Character', exact: true }).click();
        await page.getByRole('heading', { name: fixture.character.name, level: 1, exact: true }).waitFor();
        assert.equal(page.url(), workspace.origin + fixture.links.character);
        assert.equal(await backLink(page).count(), 0);
        await page.goBack();
        assert.equal(page.url(), external);
        records.push({ label: 'chromium-desktop-external-entry', viewport, after: await inspect(page) });
      });
    } finally {
      await browser.close();
    }
  }
});
