import { ApiError, listAll, read } from './api.js';
import { bindWrite, errorBox } from './workspace-actions.js';
import { anchor, prose, section } from './workspace-view.js';
import { back, button, empty, field, heading, link, path } from './ui.js';
import { passageHref, rangeFrom, validRange } from './passages.js';
import { version } from './workspace-model.js';

export async function adoptEntries(ctx, operations, kind, id, record, text) {
  const range = rangeFrom(ctx.url.searchParams);
  if (!validRange(text, range) || !text.slice(range.start, range.end).trim()) throw new ApiError(400, 'selection_required', '请从正文选中一段原文。');
  const route = { draft: 'drafts', source: 'sources', judgment: 'judgments' }[kind];
  const from = passageHref(route, id, record.revision, range);
  const [characters, judgments] = await Promise.all([listAll('character.list', {}, ctx.signal),
    kind === 'draft' && operations.has('judgment.list') ? listAll('judgment.list', {}, ctx.signal) : []]);
  const title = '采纳为角色条目';
  const excerpt = text.slice(range.start, range.end);
  if (!ctx.show(title, `${heading(title, { trail: back(from, '返回原文') })}${section('所选原文', prose(excerpt))}
    ${characters.length ? `<form class="editor" id="adopt-entry" method="post" action="/api/web/invoke">
      ${field('characterId', '采纳到角色', { options: [['', '请选择'], ...characters.map(item => [item.characterId, item.name])] })}
      ${field('label', '条目名称', { schema: { maxLength: 300 } })}
      ${field('text', '条目补充文字', { type: 'textarea', required: false })}
      ${judgments.length ? field('judgment', '同时引用判断', { required: false, options: [['', '未指定'], ...judgments.map(item => [item.judgmentId, `${item.title} · ${version(item.revision)}`])] }) : ''}
      <div id="adoption-judgment"></div>${errorBox}<div class="form-actions">${button('adopt-submit', '采纳条目', null, 'primary', 'submit')}</div></form>` :
    empty('people', '还没有可采纳此条目的角色', '', link('/characters/new', '新建角色', 'plus', 'secondary'))}`)) return;
  const form = ctx.main.querySelector('#adopt-entry');
  if (!form) return;
  const judgmentField = form.elements.namedItem('judgment');
  const selected = () => judgments.find(item => item.judgmentId === judgmentField?.value);
  if (judgmentField) judgmentField.onchange = async () => {
    const item = selected();
    const preview = form.querySelector('#adoption-judgment');
    preview.textContent = '';
    if (!item) return;
    const detail = await read('judgment.read', { judgmentId: item.judgmentId, revision: item.revision }, ctx.signal).catch(() => null);
    if (detail && item === selected() && ctx.active()) preview.innerHTML = anchor(detail.href, detail.title) + prose(detail.statement);
  };
  bindWrite(ctx, operations, form, 'character.adopt-entries', () => {
    const { characterId, label, text } = Object.fromEntries(new FormData(form));
    const judgment = selected();
    return { characterId, entries: [{ label: label.trim(), ...(text.trim() && { text }), references: [
      { kind, id, revision: record.revision, excerpt, range },
      ...(judgment ? [{ kind: 'judgment', id: judgment.judgmentId, revision: judgment.revision }] : []),
    ] }] };
  }, result => ctx.saved(path('characters', result.characterId), '已采纳角色条目'));
}
