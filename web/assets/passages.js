import { read } from './api.js';
import { button, esc, path, query } from './ui.js';

export function rangeFrom(params) {
  const values = ['start', 'end'].map(key => params.get(key));
  if (values.some(value => !/^\d+$/.test(value ?? ''))) return undefined;
  const [start, end] = values.map(Number);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start ? { start, end } : undefined;
}

export const passageHref = (route, id, revision, range) => query(path(route, id), {
  revision, start: range && String(range.start), end: range?.end,
});

export const validRange = (body, range) => range && range.start >= 0 && range.end <= body.length && range.end > range.start;

export function passageView(actions = [], prefix = 'passage') {
  return `<div class="prose passage-body" id="${prefix}-body" tabindex="-1"></div>${actions.length ? `<div class="actions passage-actions">
    ${actions.map(([key, caption]) => button(`${prefix}-${key}`, caption, null, 'secondary')).join('')}</div>
    <p class="row-meta" id="${prefix}-status" role="status"></p>` : ''}`;
}

export function bindPassage(ctx, body, range, actions = {}, prefix = 'passage') {
  const prose = ctx.main.querySelector(`#${prefix}-body`);
  if (!prose) return;
  if (validRange(body, range)) {
    const mark = document.createElement('mark');
    mark.textContent = body.slice(range.start, range.end);
    prose.replaceChildren(body.slice(0, range.start), mark, body.slice(range.end));
    mark.scrollIntoView({ block: 'nearest' });
  } else prose.textContent = body;
  for (const [key, callback] of Object.entries(actions)) {
    ctx.main.querySelector(`#${prefix}-${key}`).onclick = () => {
      const selection = window.getSelection();
      let chosen = range;
      if (selection.rangeCount && !selection.isCollapsed) {
        const selected = selection.getRangeAt(0);
        if (prose.contains(selected.startContainer) && prose.contains(selected.endContainer)) {
          const before = selected.cloneRange();
          before.selectNodeContents(prose);
          before.setEnd(selected.startContainer, selected.startOffset);
          const start = before.toString().length;
          chosen = { start, end: start + selected.toString().length };
        }
      }
      const status = ctx.main.querySelector(`#${prefix}-status`);
      if (!validRange(body, chosen) || !body.slice(chosen.start, chosen.end).trim()) {
        status.textContent = '请先选中一段原文。';
        prose.focus();
        return;
      }
      callback(chosen);
    };
  }
}

export async function sourcePin(params, signal) {
  const sourceId = params.get('sourceId');
  const revision = Number(params.get('sourceRevision'));
  const range = rangeFrom(params);
  if (!sourceId || !Number.isSafeInteger(revision) || revision < 1 || !range) return undefined;
  const source = await read('source.read', { sourceId, revision, range, contextChars: 0 }, signal);
  return { sourceId, revision, range, excerpt: source.body };
}

export function pinFromSelection(sourceId, revision, range) {
  return { sourceId, sourceRevision: revision, start: String(range.start), end: range.end };
}

export const rangeLabel = range => range ? `原文位置 ${range.start}–${range.end}` : '';

export function contextText(body, start, end) {
  const left = Math.max(0, start - 30);
  const right = Math.min(body.length, end + 30);
  return `${left ? '…' : ''}${esc(body.slice(left, start))}<mark>${esc(body.slice(start, end))}</mark>${esc(body.slice(end, right))}${right < body.length ? '…' : ''}`;
}
