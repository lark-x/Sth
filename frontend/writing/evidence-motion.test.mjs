import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';

// The real component and Vue transition runtime, with a read-only empty-evidence
// response. No application service, database, production build, or user data.
const root = resolve(import.meta.dirname, '../..');
async function fixture(t) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'sth-evidence-motion-'));
  const entry = '/@evidence-motion.ts';
  const server = await createServer({
    configFile: false, root, cacheDir, publicDir: false, logLevel: 'error',
    plugins: [vue(), {
      name: 'evidence-motion-fixture',
      resolveId(id) { if (id === entry) return `\0${entry}`; },
      load(id) {
        if (id !== `\0${entry}`) return;
        return `import {createApp,h,nextTick,ref,shallowRef} from 'vue';
          import Evidence from '/frontend/writing/ManuscriptEvidence.vue';
          const body = Array.from({length:80},(_,i)=>'第'+(i+1)+'声钟响后，他仍在渡口等船。').join('\\n');
          const scene = {sceneId:'motion-scene',revision:1,title:'第三声以后',characters:[],sources:[]};
          const draft = {draftId:'motion-draft',revision:1,sceneId:scene.sceneId,sceneRevision:1,title:'未拆开的信',body};
          const component=shallowRef(), shown=ref(true), route=ref(true);
          window.evidenceStates=[];
          document.addEventListener('sth:evidence-state',event=>{
            window.evidenceStates.push(event.detail);
            const toolbar=document.querySelector('#toolbar');
            toolbar?.setAttribute('aria-expanded',String(event.detail.open));
            toolbar?.setAttribute('aria-controls',event.detail.panelId);
          });
          window.evidenceHarness={
            open:()=>component.value.open(document.querySelector('#toolbar')),
            close:()=>component.value.close(),
            unmount:async()=>{shown.value=false;await nextTick();await nextTick()},
            navigate:async()=>{route.value=false;await nextTick();await nextTick();document.querySelector('#destination').focus();window.scrollTo(0,0)},
            tick:nextTick,
          };
          createApp({setup(){return()=>route.value?h('main',[
            h('nav',{class:'toolbar'},h('button',{id:'toolbar',onClick:event=>event.currentTarget.dispatchEvent(new CustomEvent('sth:open-evidence',{bubbles:true}))},'工具栏依据')),
            h('div',{style:'height:28rem'}),
            h('textarea',{id:'editor','aria-label':'稿件正文',value:body}),
            h('div',{id:'reader-scroll',style:'height:180px;overflow:auto'},h('div',{id:'passage-body',tabindex:-1,style:'white-space:pre-wrap'},body)),
            shown.value?h(Evidence,{scene,draft,ref:component}):null,
            h('div',{style:'height:1200px'}),
          ]):h('main',[h('h1',{id:'destination',tabindex:-1},'来源原文')])}}).mount('#app');`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url === '/api/web/invoke') {
            let body = '';
            for await (const chunk of request) body += chunk;
            const call = JSON.parse(body);
            const allowed = call.operationId === 'generations.evidence.list';
            response.statusCode = allowed ? 200 : 400;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(allowed ? { result: { items: [], hasMore: false } } : { error: 'unexpected operation' }));
            return;
          }
          if (!request.url?.startsWith('/motion-fixture')) return next();
          const html = await vite.transformIndexHtml(request.url, `<!doctype html><html lang="zh-CN"><head>
            <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>依据动效验收</title><style>
            :root{font-family:system-ui;--sans:system-ui;--sheet:#fff;--ink:#252525;--muted:#686868;--line:#e5e5e5;--selection:#e7e7e7}
            *{box-sizing:border-box}body{margin:0}main{padding:16px;max-width:720px;margin:auto}
            button,textarea{font:inherit}.toolbar{position:sticky;top:0;background:white}
            textarea{display:block;width:100%;height:100px}#passage-body{font:18px/1.8 system-ui}
            </style></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`);
          response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  t.after(async () => {
    await server.close();
    assert.equal(dirname(resolve(cacheDir)), resolve(tmpdir()));
    assert.match(basename(cacheDir), /^sth-evidence-motion-/);
    await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await server.listen();
  return `http://127.0.0.1:${server.httpServer.address().port}/motion-fixture`;
}

async function settle(page) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('.evidence-panel');
    return !panel || ![...panel.classList].some(name => /evidence-motion-(enter|leave)-/.test(name));
  });
}
async function open(page) {
  await page.locator('#toolbar').click();
  await page.waitForFunction(() => document.activeElement === document.querySelector('.evidence-panel'));
}
async function snapshot(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.evidence-panel');
    const toolbar = document.querySelector('#toolbar');
    return {
      expanded: toolbar?.getAttribute('aria-expanded'), controls: toolbar?.getAttribute('aria-controls'),
      panelId: panel?.id, hidden: panel?.getAttribute('aria-hidden'), inert: panel?.inert,
      role: panel?.getAttribute('role'), modal: panel?.getAttribute('aria-modal'),
      display: panel && getComputedStyle(panel).display, pointer: panel && getComputedStyle(panel).pointerEvents,
      backgroundInert: document.querySelector('.toolbar')?.inert,
      position: document.body.style.position, bodyStyle: document.body.getAttribute('style') ?? '',
      active: document.activeElement?.id, panelFocused: document.activeElement === panel,
      y: window.scrollY,
    };
  });
}
async function readingPosition(page, kind = 'input') {
  return page.evaluate(kind => {
    window.scrollTo(0, 340);
    const editor = document.querySelector('#editor');
    const reader = document.querySelector('#reader-scroll');
    reader.scrollTop = 60;
    if (kind === 'input') {
      editor.focus({ preventScroll: true }); editor.setSelectionRange(3, 12, 'backward'); editor.scrollTop = 35;
    } else {
      const passage = document.querySelector('#passage-body');
      passage.focus({ preventScroll: true });
      const range = document.createRange(); range.setStart(passage.firstChild, 33); range.setEnd(passage.firstChild, 42);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    return { y: window.scrollY, readerTop: reader.scrollTop, editorTop: editor.scrollTop, text: window.getSelection().toString() };
  }, kind);
}
async function assertRestored(page, expected, kind = 'input') {
  const actual = await page.evaluate(() => {
    const editor = document.querySelector('#editor');
    return { active: document.activeElement.id, y: window.scrollY, readerTop: document.querySelector('#reader-scroll').scrollTop,
      editorTop: editor.scrollTop, start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection,
      text: window.getSelection().toString(), bodyPosition: document.body.style.position,
      strandedInert: [...document.querySelectorAll('[inert]')].filter(node => !node.matches('.evidence-panel')).length };
  });
  assert.equal(actual.active, kind === 'input' ? 'editor' : 'passage-body');
  assert.equal(actual.y, expected.y);
  assert.equal(actual.readerTop, expected.readerTop);
  assert.equal(actual.bodyPosition, '');
  assert.equal(actual.strandedInert, 0);
  if (kind === 'input') {
    assert.equal(actual.editorTop, expected.editorTop);
    assert.deepEqual([actual.start, actual.end, actual.direction], [3, 12, 'backward']);
  } else assert.equal(actual.text, expected.text);
}

test('evidence motion preserves logical state and reading position through interruption', async t => {
  const url = await fixture(t);
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      async function run(label, work, options = {}) {
        await t.test(`${name}: ${label}`, async () => {
          const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference', ...options });
          const page = await context.newPage();
          page.setDefaultTimeout(7000);
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          try {
            await page.goto(url); await page.locator('.evidence-trigger').waitFor();
            await work(page); assert.deepEqual(errors, []);
          } finally { await context.close(); }
        });
      }

      await run('exit is visible but inert; focus, selection and scroll return before its end', async page => {
        const before = await readingPosition(page);
        await open(page); await settle(page);
        // Stretch only test timing so assertions cannot race a 180ms production exit.
        await page.addStyleTag({ content: ':root{--motion-normal:800ms}' });
        await page.evaluate(() => window.evidenceHarness.close());
        const closed = await snapshot(page);
        assert.equal(closed.expanded, 'false'); assert.equal(closed.hidden, 'true');
        assert.equal(closed.controls, closed.panelId); assert.equal(closed.modal, null);
        assert.equal(closed.inert, true); assert.equal(closed.pointer, 'none');
        assert.notEqual(closed.display, 'none', 'the surface gets a real exit, not an immediate display toggle');
        await assertRestored(page, before);
        await settle(page); assert.equal((await snapshot(page)).display, 'none');
      });

      await run('same-tick open/close/open ignores stale focus and lock callbacks', async page => {
        const before = await readingPosition(page);
        await page.evaluate(async () => {
          const api = window.evidenceHarness;
          const first = api.open(), close = api.close(), last = api.open();
          await Promise.all([first, close, last]);
        });
        const current = await snapshot(page);
        assert.equal(current.expanded, 'true'); assert.equal(current.panelFocused, true);
        assert.equal(current.inert, false); assert.equal(current.backgroundInert, true);
        assert.equal(current.position, 'fixed');
        assert.deepEqual(await page.evaluate(() => window.evidenceStates.slice(-3).map(state => state.open)), [true, false, true]);
        await page.evaluate(() => window.evidenceHarness.close()); await settle(page);
        await assertRestored(page, before);
      });

      await run('closing during entry cannot refocus or relock after its cancelled deadline', async page => {
        const before = await readingPosition(page);
        await page.addStyleTag({ content: ':root{--motion-panel:800ms}' });
        await open(page);
        await page.waitForFunction(() => document.querySelector('.evidence-panel').getAnimations().length > 0);
        await page.evaluate(() => window.evidenceHarness.close());
        await assertRestored(page, before);
        await settle(page); await page.waitForTimeout(850);
        await assertRestored(page, before);
        assert.equal((await snapshot(page)).display, 'none');
      });

      await run('reopening a leaving panel cancels stale hiding and Escape restores the text range', async page => {
        const before = await readingPosition(page, 'range');
        await open(page); await settle(page);
        await page.addStyleTag({ content: ':root{--motion-normal:800ms}' });
        await page.evaluate(() => window.evidenceHarness.close());
        await page.waitForFunction(() => document.querySelector('.evidence-panel').getAnimations().length > 0);
        await open(page); await settle(page);
        assert.equal((await snapshot(page)).panelFocused, true);
        // Wait beyond the cancelled leave's deadline, so stale callbacks are observable.
        await page.waitForTimeout(850);
        assert.notEqual((await snapshot(page)).display, 'none');
        assert.equal((await snapshot(page)).position, 'fixed');
        await page.keyboard.press('Escape'); await settle(page);
        await assertRestored(page, before, 'range');
      });

      await run('reduced motion has no spatial animation and closes immediately', async page => {
        const before = await readingPosition(page);
        await open(page);
        assert.equal(await page.locator('.evidence-panel').evaluate(node => node.getAnimations().length), 0);
        await page.evaluate(() => window.evidenceHarness.close());
        assert.equal((await snapshot(page)).display, 'none');
        await assertRestored(page, before);
        await open(page); await page.keyboard.press('Escape');
        await assertRestored(page, before);
      }, { reducedMotion: 'reduce' });

      await run('switching to reduced motion during exit hides immediately and allows a clean reopen', async page => {
        const before = await readingPosition(page);
        await open(page); await settle(page);
        await page.addStyleTag({ content: ':root{--motion-normal:800ms}' });
        await page.evaluate(() => window.evidenceHarness.close());
        await page.waitForFunction(() => document.querySelector('.evidence-panel').getAnimations().length > 0);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal((await snapshot(page)).display, 'none');
        await assertRestored(page, before);
        await open(page);
        assert.equal((await snapshot(page)).panelFocused, true);
        await page.evaluate(() => window.evidenceHarness.close());
        await assertRestored(page, before);
      });

      await run('a missing transitionend cannot strand the visible surface', async page => {
        await page.evaluate(() => document.addEventListener('transitionend', event => event.stopImmediatePropagation(), true));
        await open(page); await settle(page);
        await page.evaluate(() => window.evidenceHarness.close()); await settle(page);
        const closed = await snapshot(page);
        assert.equal(closed.display, 'none'); assert.equal(closed.position, '');
        assert.equal(closed.backgroundInert, false); assert.equal(closed.active, 'toolbar');
      });

      await run('crossing the modal breakpoint while leaving cannot relock the reader', async page => {
        await open(page); await settle(page);
        assert.equal((await snapshot(page)).position, '');
        await page.setViewportSize({ width: 639, height: 844 });
        await page.waitForFunction(() => document.body.style.position === 'fixed');
        await page.evaluate(() => window.evidenceHarness.close());
        await page.setViewportSize({ width: 640, height: 844 });
        await page.setViewportSize({ width: 390, height: 844 }); await settle(page);
        assert.equal((await snapshot(page)).position, '');
        assert.equal((await snapshot(page)).backgroundInert, false);
        await open(page);
        assert.equal((await snapshot(page)).role, 'dialog');
        await page.evaluate(() => window.evidenceHarness.close()); await settle(page);
      }, { viewport: { width: 640, height: 844 } });

      await run('unmount during entry restores a surviving reader and body styles', async page => {
        const before = await readingPosition(page);
        await page.evaluate(() => document.body.style.setProperty('overflow', 'auto', 'important'));
        const bodyStyle = await page.locator('body').getAttribute('style');
        await page.addStyleTag({ content: ':root{--motion-panel:800ms}' });
        await open(page);
        await page.evaluate(() => window.evidenceHarness.unmount());
        assert.equal(await page.locator('.evidence-panel').count(), 0);
        assert.equal(await page.locator('body').getAttribute('style'), bodyStyle);
        await assertRestored(page, before);
        assert.equal(await page.evaluate(() => window.evidenceStates.at(-1).open), false);
        await page.waitForTimeout(850);
        await assertRestored(page, before);
      });

      await run('route unmount during exit leaves destination focus and scroll intact', async page => {
        await readingPosition(page); await open(page); await settle(page);
        await page.addStyleTag({ content: ':root{--motion-normal:800ms}' });
        await page.evaluate(async () => {
          void window.evidenceHarness.close();
          await window.evidenceHarness.navigate();
        });
        await page.waitForTimeout(850);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'destination');
        assert.equal(await page.evaluate(() => window.scrollY), 0);
        assert.equal(await page.locator('[inert]').count(), 0);
        assert.equal(await page.locator('body').evaluate(node => node.style.position), '');
      });
    } finally { await browser.close(); }
  }
});
