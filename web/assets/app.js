import { catalog, errorText } from './api.js';
import { diaryIndex, diaryPage, newDiary } from './diaries.js';
import { characterPage, charactersPage, newCharacter, newProject, projectsPage } from './library.js';
import { connectionsPage } from './connections.js';
import { button, esc, heading, icon, link } from './ui.js';

const main = document.querySelector('#main');
const navigation = document.querySelector('#navigation');
const announcement = document.querySelector('#announcement');
const destinations = [
  ['/', '日记', 'diary'], ['/projects', '项目', 'folder'],
  ['/characters', '角色', 'people'], ['/settings/connections', '连接', 'link'],
];
let routeController;
let announcementTimer;

function announce(message) {
  clearTimeout(announcementTimer);
  announcement.textContent = message;
  announcementTimer = setTimeout(() => { announcement.textContent = ''; }, 4200);
}

function navigate(href, { replace = false } = {}) {
  const url = new URL(href, location.origin);
  if (url.href === location.href) return;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  void render(true);
}

function currentSection(path) {
  if (path === '/' || path.startsWith('/diaries')) return '/';
  return destinations.find(([href]) => href !== '/' && (path === href || path.startsWith(`${href}/`)))?.[0];
}

function recordId(parts) {
  try { return decodeURIComponent(parts[1]); } catch { return ''; }
}

function renderRoute(ctx) {
  const parts = ctx.url.pathname.split('/').filter(Boolean);
  const [section, page] = parts;
  if (!section) return diaryIndex(ctx);
  if (parts.length <= 2) {
    if (section === 'diaries' && page === 'new') return newDiary(ctx);
    if (section === 'diaries' && recordId(parts) && page) return diaryPage(ctx, recordId(parts));
    if (section === 'projects' && !page) return projectsPage(ctx);
    if (section === 'projects' && page === 'new') return newProject(ctx);
    if (section === 'characters' && !page) return charactersPage(ctx);
    if (section === 'characters' && page === 'new') return newCharacter(ctx);
    if (section === 'characters' && recordId(parts) && page) return characterPage(ctx, recordId(parts));
    if (section === 'settings' && page === 'connections') return connectionsPage(ctx);
  }
  ctx.show('找不到页面', `${heading('找不到页面')}<div class="state-body">${link('/', '返回日记', 'back', 'secondary')}</div>`);
}

async function render(focus = false) {
  routeController?.abort();
  const controller = new AbortController();
  routeController = controller;
  const { signal } = controller;
  const url = new URL(location.href);
  const section = currentSection(url.pathname);
  navigation.innerHTML = destinations.map(([href, name, glyph]) =>
    `<a href="${href}"${section === href ? ' aria-current="page"' : ''}>${icon(glyph)}<span>${name}</span></a>`).join('');
  main.innerHTML = '<div class="loading" role="status">正在读取…</div>';
  if (focus) {
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }
  const ctx = {
    main, url, signal, key: url.pathname + url.search, active: () => !signal.aborted,
    go: navigate, announce, refresh: () => void render(true),
    saved(href, message) {
      if (!signal.aborted) navigate(href, { replace: true });
      announce(message);
    },
    async fields(operation) {
      const operations = await catalog();
      return operations.get(operation)?.inputSchema?.properties ?? {};
    },
    show(title, markup) {
      if (signal.aborted) return false;
      const shouldFocus = focus && (document.activeElement === main || document.activeElement === document.body);
      document.title = title === '我的日记' ? 'Sth · 我的日记' : `${title} · Sth`;
      main.innerHTML = markup;
      if (shouldFocus) main.querySelector('h1')?.focus({ preventScroll: true });
      return true;
    },
  };
  try {
    // Connections remain available independently of the domain catalog.
    if (section && section !== '/settings/connections') void catalog().catch(() => {});
    await renderRoute(ctx);
  } catch (error) {
    if (!ctx.show('页面暂时无法打开', `${heading('页面暂时无法打开')}
      <div class="state-body"><p role="alert">${esc(errorText(error))}</p><div class="actions">
      ${button('retry-page', '重试', 'refresh', 'primary')}${link('/', '返回日记', 'back', 'quiet')}
      </div></div>`)) return;
    main.querySelector('#retry-page').onclick = ctx.refresh;
  }
}

document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target.closest('a[href]');
  if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
  const url = new URL(anchor.href);
  if (url.origin !== location.origin || url.hash || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/api/')) return;
  event.preventDefault();
  navigate(url.href);
});
window.addEventListener('popstate', () => void render(true));
void render();
