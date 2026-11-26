import { catalog, mediaProvider, read } from './api.js';
import { button, empty, esc, heading, link, query, subnav, time } from './ui.js';
import { display } from './workspace-fields.js';
import { internalHref, taskLinks } from './workspace-model.js';
import { anchor } from './workspace-view.js';

const kinds = { writing: '文字', batch: '文字批量', media: '媒体', research: '资料' };

export async function tasksPage(ctx) {
  const operations = await catalog();
  const params = ctx.url.searchParams;
  const requested = Number(params.get('offset'));
  const offset = Number.isSafeInteger(requested) && requested > 0 ? requested : 0;
  const limit = 20;
  const [{ items, nextOffset }, provider] = await Promise.all([
    operations.has('tasks.list') ? read('tasks.list', { limit, offset }, ctx.signal) : Promise.resolve({ items: [] }),
    mediaProvider(ctx.signal).catch(() => null),
  ]);
  const providerName = { ready: '可用', unconfigured: '未配置', invalid_config: '配置无效', unreachable: '无法连接' }[provider?.status];
  const actions = (operations.has('jobs.create') ? link(query('/jobs/new', { projectId: params.get('projectId') }), '新建任务', 'plus', 'primary') : '') +
    button('refresh-tasks', '刷新状态', 'refresh', 'secondary');
  if (!ctx.show('任务', `${heading('任务', { actions, meta: providerName ? `<p class="masthead-meta">图片供应商 · ${providerName}${provider.provider ? ` · ${esc(provider.provider)}` : ''}</p>` : '' })}
    ${subnav('任务视图', taskLinks, '/jobs')}
    ${items.length ? `<ul class="rows" role="list">${items.map(item => `<li class="task-row"><div><h2>${anchor(internalHref(item.href), item.title)}</h2>
      <p class="row-meta">${esc(kinds[item.kind] ?? item.kind)} · ${esc(display(item.status))} · ${time(item.createdAt, 'stamp')}</p></div></li>`).join('')}</ul>` : empty('tasks', '暂无任务')}
    ${offset || nextOffset ? `<div class="actions load-more">${offset ? link(query('/jobs', { offset: Math.max(0, offset - limit) }), '上一页', 'back', 'secondary') : ''}
      ${nextOffset ? link(query('/jobs', { offset: nextOffset }), '下一页', 'next', 'secondary') : ''}</div>` : ''}`)) return;
  ctx.main.querySelector('#refresh-tasks').onclick = ctx.refresh;
}

export function taskProgress(counts = {}) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const settled = (counts.succeeded ?? 0) + (counts.failed ?? 0) + (counts.canceled ?? counts.cancelled ?? 0);
  return total ? `<div class="task-progress"><p class="row-meta">${settled} / ${total} 项已结束</p><progress max="${total}" value="${settled}" aria-label="已结束任务项"></progress></div>` : '';
}
