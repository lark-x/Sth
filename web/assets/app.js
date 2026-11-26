import { catalog, errorText } from './api.js';
import { diaryIndex, diaryPage, newDiary } from './diaries.js';
import { characterPage, charactersPage, newCharacter, newProject, projectsPage } from './library.js';
import { connectionsPage } from './connections.js';
import { domainFor, workspaceRoute } from './workspace.js';
import { workspaceError } from './workspace-actions.js';
import { button, esc, heading, icon, link } from './ui.js';
import { tasksPage } from './tasks.js';
import { researchPage } from './research.js';

const main = document.querySelector('#main');
const navigation = document.querySelector('#navigation');
const settings = document.querySelector('#settings-navigation');
const announcement = document.querySelector('#announcement');
const destinations = [
  ['/', '日记', 'diary'], ['/create', '创作', 'pen'],
  ['/characters', '角色', 'people'], ['/sources', '资料', 'book'],
  ['/jobs', '任务', 'tasks'],
];
const navLink = ([href, name, glyph], section) =>
  `<a href="${href}"${section === href ? ' aria-current="page"' : ''}>${icon(glyph)}<span>${name}</span></a>`;
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
  if (/^\/(create|projects)(\/|$)/.test(path)) return '/create';
  if (/^\/settings(\/|$)/.test(path)) return '/settings';
  if (/^\/research(\/|$)/.test(path)) return '/sources';
  const domain = domainFor(path.split('/')[1]);
  if (domain) return `/${domain.tab}`;
  return destinations.find(([href]) => href !== '/' && (path === href || path.startsWith(`${href}/`)))?.[0];
}

function recordId(parts) {
  try { return decodeURIComponent(parts[1]); } catch { return ''; }
}

function renderRoute(ctx) {
  const parts = ctx.url.pathname.split('/').filter(Boolean);
  const [section, page] = parts;
  if (!section) return diaryIndex(ctx);
  if (section === 'settings' && (!page || page === 'connections') && parts.length <= 2) return connectionsPage(ctx);
  if ((section === 'jobs' || section === 'tasks') && !page) return tasksPage(ctx);
  if (section === 'create' && !page) return workspaceRoute(ctx, domainFor('scenes'));
  if (section === 'research' && parts.length <= 2) return researchPage(ctx, page && recordId(parts));
  const domain = domainFor(section);
  if (domain && (!page || recordId(parts)) && (parts.length <= 2 ||
    (domain.route === 'generations' && parts.length === 3 && ['result', 'prompt'].includes(parts[2])))) {
    return workspaceRoute(ctx, domain, page && recordId(parts), parts[2]);
  }
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
  navigation.innerHTML = destinations.map(item => navLink(item, section)).join('');
  settings.innerHTML = navLink(['/settings', '设置', 'settings'], section);
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
    if (section && section !== '/settings') void catalog().catch(() => {});
    await renderRoute(ctx);
  } catch (error) {
    if (!ctx.show('页面暂时无法打开', `${heading('页面暂时无法打开')}
      <div class="state-body"><p role="alert">${esc(domainFor(url.pathname.split('/')[1]) ? workspaceError(error) : errorText(error))}</p><div class="actions">
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
