import { catalog, read } from './api.js';
import { button, esc, field, heading, link, path, query, subnav } from './ui.js';
import { bindWrite, errorBox } from './workspace-actions.js';
import { display } from './workspace-fields.js';
import { researchLinks } from './workspace-model.js';
import { anchor, section } from './workspace-view.js';
import { bindPassage, passageView } from './passages.js';

const researchHref = (id, params = {}) => query(id ? path('research', id) : '/research', params);

export async function researchPage(ctx, id) {
  const operations = await catalog();
  const params = ctx.url.searchParams;
  const offset = Number(params.get('offset') ?? 0);
  const docId = params.get('doc');
  const available = operations.has('external.providers');
  const [providerList, recent, job] = available ? await Promise.all([
    read('external.providers', {}, ctx.signal), read('external.list', { limit: 10 }, ctx.signal),
    id && read('external.get', { jobId: id, ...(docId && { docId, offset }) }, ctx.signal),
  ]) : [{ items: [] }, { items: [] }, null];
  const providers = providerList.items;
  const forms = [];
  const command = (operation, input, caption, complete, fields = '') => {
    const key = `research-action-${forms.length}`;
    forms.push({ key, operation, input, complete });
    return `<form id="${key}" class="workspace-inline" method="post" action="/api/web/invoke">${fields}${button(`${key}-submit`, caption, null, 'secondary', 'submit')}${errorBox}</form>`;
  };
  const openJob = result => ctx.go(researchHref(result.jobId));
  const archive = result => ctx.saved(result.href, '原文已归档');
  const continueJob = cursor => command(`external.${job.kind}`, {
    provider: job.provider, ...(job.kind === 'search' ? { query: job.query } : { docId: job.docId }), cursor,
  }, job.kind === 'search' ? '下一页搜索结果' : '读取上游后续上下文', openJob);
  let body = '';
  const passages = [];
  if (job) {
    const result = job.result;
    body = section(job.kind === 'search' ? `检索 · ${job.query}` : '原文读取', `<p role="status">${esc(display(job.status))}</p>
      ${job.error ? `<p class="notice">${esc(job.error.message)}</p>` : ''}
      ${job.error?.retryable ? command('external.retry', { jobId: id }, '重试检索任务', () => ctx.refresh()) : ''}`);
    if (result?.items) body += section('检索结果', result.items.length ? `<ul class="workspace-notes">${result.items.map(item => `<li>
      <h3>${esc(item.title)}</h3><p class="row-meta">${esc(item.origin)}</p>${item.snippet ? `<p>${esc(item.snippet)}</p>` : ''}
      ${command('external.read', { provider: item.provider, docId: item.docId }, `读取原文 · ${item.title}`, openJob)}</li>`).join('')}</ul>` : '<p>没有匹配的资料。</p>');
    if (result?.documents) body += result.documents.map((document, index) => {
      const key = `external-text-${index}`;
      const container = document.offset === 0 && document.totalChars <= 100_000;
      const whole = container ? command('external.archive', { jobId: id, docId: document.docId }, '归档全文', archive) : '';
      const selection = { start: undefined, end: undefined };
      passages.push({ key, document, selection });
      const excerpt = command('external.archive', () => {
        return { jobId: id, docId: document.docId, start: selection.start, end: selection.end };
      }, '归档所选原文', archive);
      selection.formKey = forms.at(-1).key;
      return section(document.title, `<p class="row-meta">${esc(document.origin)}${document.upstreamRevision ? ` · ${esc(document.upstreamRevision)}` : ''}</p>
        <div id="${key}">${passageView([['pick', '选用这段原文']], key)}</div><div class="actions">${whole}${excerpt}
        ${document.offset > 0 ? link(researchHref(id, { doc: document.docId }), '回到原文开头', 'back', 'quiet') : ''}
        ${document.nextOffset ? link(researchHref(id, { doc: document.docId, offset: document.nextOffset }), '下一段原文', 'next', 'secondary') : ''}</div>`);
    }).join('');
    if (result?.nextCursor) body += continueJob(result.nextCursor);
  }
  const search = providers.length ? command('external.search', form => Object.fromEntries(new FormData(form)), '搜索外部资料', openJob,
    `<div class="workspace-filter">${field('provider', '资料来源', { value: job?.provider ?? providers[0].provider, options: providers.map(item => [item.provider, item.label]) })}
      ${field('query', '检索词', { value: job?.query ?? '', type: 'search', schema: operations.get('external.search').inputSchema.properties.query })}</div>`) :
    '<p class="muted">外部资料提供方尚未配置。</p>';
  if (!ctx.show('外部检索', `${heading('外部检索', { actions: id ? button('refresh-research', '刷新状态', 'refresh', 'secondary') : '' })}
    ${subnav('资料工作区', researchLinks, '/research')}${search}${body}
    ${section('最近检索', recent.items.length ? `<ul class="workspace-notes">${recent.items.map(item => `<li>${anchor(researchHref(item.jobId), item.query ?? item.docId)} · ${esc(display(item.status))}</li>`).join('')}</ul>` : '')}`)) return;
  for (const { key, operation, input, complete } of forms) {
    const form = ctx.main.querySelector(`#${key}`);
    bindWrite(ctx, operations, form, operation, () => typeof input === 'function' ? input(form) : input, complete, { key: `${ctx.key}:${key}` });
  }
  for (const { key, document, selection } of passages) {
    const submit = ctx.main.querySelector(`#${selection.formKey} button[type="submit"]`);
    submit.disabled = !submit.textContent.includes('重试');
    bindPassage({ ...ctx, main: ctx.main.querySelector(`#${key}`) }, document.body, undefined, { pick(range) {
      selection.start = document.offset + range.start;
      selection.end = document.offset + range.end;
      submit.disabled = false;
      ctx.main.querySelector(`#${key} [role="status"]`).textContent = `已选原文 ${selection.start}–${selection.end}`;
    } }, key);
  }
  ctx.main.querySelector('#refresh-research')?.addEventListener('click', ctx.refresh);
  if (job && ['queued', 'running'].includes(job.status)) {
    let timer;
    const poll = async () => {
      const next = await read('external.get', { jobId: id }, ctx.signal).catch(() => null);
      if (!ctx.active()) return;
      if (next && !['queued', 'running'].includes(next.status)) ctx.refresh();
      else timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 900);
    ctx.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
}
