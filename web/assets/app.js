import { catalog, errorText } from './api.js';
import { diaryIndex, diaryPage, newDiary } from './diaries.js';
import { characterPage, charactersPage, newCharacter, newProject, projectsPage } from './library.js';
import { connectionsPage } from './connections.js';
import { domainFor, workspaceRoute } from './workspace.js';
import { workspaceError } from './workspace-actions.js';
import { button, esc, heading, link } from './ui.js';
import { tasksPage } from './tasks.js';
import { researchPage } from './research.js';

function recordId(parts) {
  try { return decodeURIComponent(parts[1]); } catch { return ''; }
}

function renderRoute(ctx) {
  const parts = ctx.url.pathname.split('/').filter(Boolean);
  const [section, page] = parts;
  if (!section || (section === 'diaries' && !page)) return diaryIndex(ctx);
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
  ctx.show('找不到页面', `${heading('找不到页面')}<div class="state-body">${link('/', '返回首页', 'back', 'secondary')}</div>`);
}

// The shell owns history and cancellation. Each domain keeps its existing
// editor, operation receipts and revision-pinned links through this seam.
export async function mountLegacyRoute({ main, url, signal, navigate, announce, refresh, focus = false }) {
  main.innerHTML = '<div class="loading" role="status">正在读取…</div>';
  const ctx = {
    main, url, signal, key: url.pathname + url.search, active: () => !signal.aborted,
    go: navigate, announce, refresh,
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
      const shouldFocus = focus && (document.activeElement === main.closest('main') || document.activeElement === main || document.activeElement === document.body || main.contains(document.activeElement));
      document.title = `${title} · Sth`;
      main.innerHTML = markup;
      if (shouldFocus) main.querySelector('h1')?.focus({ preventScroll: true });
      return true;
    },
  };
  try {
    // Connections remain available independently of the domain catalog.
    if (url.pathname.split('/')[1] !== 'settings') void catalog().catch(() => {});
    await renderRoute(ctx);
  } catch (error) {
    if (!ctx.show('页面暂时无法打开', `${heading('页面暂时无法打开')}
      <div class="state-body"><p role="alert">${esc(domainFor(url.pathname.split('/')[1]) ? workspaceError(error) : errorText(error))}</p><div class="actions">
      ${button('retry-page', '重试', 'refresh', 'primary')}${link('/', '返回首页', 'back', 'quiet')}
      </div></div>`)) return;
    main.querySelector('#retry-page').onclick = ctx.refresh;
  }
}
