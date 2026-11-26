import { entity, invoke, read, step } from './api.js';
import { button, esc, field, link, optionMarkup } from './ui.js';
import { version } from './workspace-model.js';
import { passageHref } from './passages.js';

export const resourceKinds = {
  source: ['sources', '资料', 'sourceId'], scene: ['scenes', '场景', 'sceneId'],
  draft: ['drafts', '候选稿', 'draftId'], diary: ['diaries', '日记', 'noteId'],
  character: ['characters', '角色', 'characterId'], judgment: ['judgments', '判断', 'judgmentId'],
};
const resourceRoutes = { ...Object.fromEntries(Object.entries(resourceKinds).map(([key, [route]]) => [key, route])), event: 'events', narrative: 'narratives', branch: 'branches' };
export const blockLabels = { text: '文本', image: '图片', audio: '音频', reference: '资料链接' };

export function resourceHref(kind, id, revision, range) {
  return Object.hasOwn(resourceRoutes, kind) && id ? passageHref(resourceRoutes[kind], id, revision, range) : '';
}

export const readCharacter = async (characterId, signal, revision) => entity(
  await read('character.read', { characterId, ...(revision ? { revision } : {}) }, signal), 'characterId',
);

export function assetHref(assetId) {
  return `/api/web/assets/${encodeURIComponent(assetId)}/content`;
}

export function assetPreview(type, assetId, label) {
  const href = esc(assetHref(assetId));
  return type === 'image' ? `<img src="${href}" alt="${esc(label)}" loading="lazy">`
    : `<audio src="${href}" controls loading="lazy" preload="none" aria-label="${esc(label)}"></audio>`;
}

function blockPreview(block, label, choices) {
  if (block.type === 'text') return `<div class="prose">${esc(block.text)}</div>`;
  if (block.type === 'reference') {
    const href = resourceHref(block.kind, block.id, block.revision, block.range);
    const title = choices?.[block.kind]?.find(([id]) => id === block.id)?.[2];
    const caption = `${title?.title ?? title?.name ?? resourceKinds[block.kind]?.[1] ?? '资料'} · ${version(block.revision)}`;
    return `${href ? link(href, caption, 'link', 'quiet') : esc(caption)}${block.excerpt ? `<blockquote>${esc(block.excerpt)}</blockquote>` : ''}`;
  }
  return block.assetId ? assetPreview(block.type, block.assetId, label || blockLabels[block.type]) : '';
}

export function entriesView(entries = [], choices) {
  return entries.length ? `<section class="workspace-section"><h2>自定义条目</h2><ol class="workspace-notes character-entries">
    ${entries.map(entry => `<li><h3>${esc(entry.label || '未命名条目')}</h3><ul class="character-blocks">
      ${entry.blocks.map(block => `<li>${blockPreview(block, entry.label, choices)}</li>`).join('')}
    </ul></li>`).join('')}</ol></section>` : '';
}

export function characterBacklinksView(items) {
  return items.length ? `<section class="workspace-section"><h2>引用此记录的角色证据</h2><ul class="workspace-notes">
    ${items.map(item => `<li>${link(resourceHref('character', item.characterId, item.revision),
      `${item.name} · ${version(item.revision)} · ${item.label || '未命名条目'}`, 'people', 'quiet')}
      ${item.reference.excerpt ? `<blockquote>${esc(item.reference.excerpt)}</blockquote>` : ''}</li>`).join('')}</ul></section>` : '';
}

const accept = {
  image: 'image/png,image/jpeg,image/jpg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif',
  audio: 'audio/wav,audio/x-wav,audio/wave,audio/vnd.wave,audio/mpeg,audio/mp3,audio/ogg,audio/flac,audio/x-flac,.wav,.mp3,.ogg,.oga,.flac',
};
const mimeByExtension = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac',
};

function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(new Error('无法读取文件。'));
    reader.readAsDataURL(file);
  });
}

export function bindEntries(holder, value, choices, { canUpload, retain }) {
  let sequence = 0;
  const list = holder.querySelector('.character-entry-list');
  const add = holder.querySelector('#add-character-entry');
  const getters = new WeakMap();
  const getRows = node => [...node.children].map(row => getters.get(row)());

  function sync(rows) {
    const entry = rows === list;
    for (const [index, row] of [...rows.children].entries()) {
      row.querySelector(':scope > .actions [data-move="up"]').disabled = !row.previousElementSibling;
      row.querySelector(':scope > .actions [data-move="down"]').disabled = !row.nextElementSibling;
      if (entry) row.querySelector('legend').textContent = `条目 ${index + 1}`;
    }
  }

  function appendRow(rows, legend, kind, markup, fallback) {
    const id = `character-card-${++sequence}`;
    const row = document.createElement('fieldset');
    row.className = `workspace-fieldset character-${kind}`;
    const name = kind === 'entry' ? '条目' : '内容';
    row.innerHTML = `<legend>${esc(legend)}</legend>${markup(id)}<div class="actions">
      <button class="button quiet" type="button" data-move="up">上移${name}</button>
      <button class="button quiet" type="button" data-move="down">下移${name}</button>
      <button class="button quiet" type="button" data-remove>移除${name}</button></div>`;
    const up = row.querySelector(':scope > .actions [data-move="up"]');
    const down = row.querySelector(':scope > .actions [data-move="down"]');
    up.onclick = () => { row.previousElementSibling.before(row); sync(rows); (up.disabled ? down : up).focus(); retain(); };
    down.onclick = () => { row.nextElementSibling.after(row); sync(rows); (down.disabled ? up : down).focus(); retain(); };
    row.querySelector(':scope > .actions [data-remove]').onclick = () => {
      const neighbor = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      sync(rows);
      (neighbor?.querySelector('input, textarea, select, button') ?? fallback).focus();
      retain();
    };
    rows.append(row);
    sync(rows);
    return { row, id };
  }

  function addEntry({ entryId, label = '', blocks = [] } = {}, focus = false) {
    const { row } = appendRow(list, '条目', 'entry', id => `
      ${field(`${id}-label`, '条目名称', { value: label, required: false, schema: { maxLength: 300 } })}
      <div class="character-block-list"></div><div class="actions character-add-blocks">
      ${Object.entries(blockLabels).filter(([type]) => canUpload || !['image', 'audio'].includes(type))
        .map(([type, label]) => button(`${id}-add-${type}`, `添加${label}`, 'plus', 'secondary')).join('')}</div>`, add);
    const labelInput = row.querySelector('input');
    const blockList = row.querySelector('.character-block-list');
    getters.set(row, () => ({ ...(entryId ? { entryId } : {}), label: labelInput.value, blocks: getRows(blockList) }));
    const buttons = [...row.querySelectorAll('.character-add-blocks button')];
    for (const block of blocks) addBlock(blockList, block, buttons[0]);
    buttons.forEach(control => {
      control.onclick = () => {
        const block = addBlock(blockList, { type: control.id.split('-').at(-1) }, control);
        block.querySelector('textarea, input, select')?.focus();
        retain();
      };
    });
    if (focus) labelInput.focus();
  }

  function addBlock(rows, block, fallback) {
    const { type } = block;
    const { row, id } = appendRow(rows, blockLabels[type], 'block', id => {
      if (type === 'text') return field(`${id}-text`, '文本内容', { type: 'textarea', rows: 3, value: block.text, required: false, schema: { maxLength: 100000 } });
      if (type === 'reference') return referenceFields(id, block, choices);
      return `<div class="field"><label for="${id}-file">${blockLabels[type]}文件</label>
        <input id="${id}-file" name="${id}-file" type="file" accept="${accept[type]}"${block.assetId ? '' : ' required'}>
        <p class="form-note" role="status"></p></div><div class="character-media-preview"></div>`;
    }, fallback);
    const get = type === 'text' ? () => ({ type, text: row.querySelector('textarea').value })
      : type === 'reference' ? bindReference(row, id, block, choices) : bindUpload(row, block, retain);
    getters.set(row, get);
    return row;
  }

  function render(entries) {
    list.replaceChildren();
    for (const entry of entries) addEntry(entry);
  }

  add.onclick = () => { addEntry(undefined, true); retain(); };
  holder.addEventListener('input', retain);
  holder.addEventListener('change', retain);
  render(value);
  return { get: () => getRows(list), render };
}

function resourceOptions(choices, kind, current) {
  const options = choices[kind] ?? [];
  return [['', '请选择'], ...options, ...(current && !options.some(([id]) => id === current) ? [[current, current]] : [])];
}

function referenceFields(id, block, choices) {
  const kind = block.kind ?? 'source';
  return field(`${id}-kind`, '资料类型', { value: kind, options: Object.entries(resourceKinds).map(([key, [, label]]) => [key, label]) }) +
    field(`${id}-resource`, '资料记录', { options: resourceOptions(choices, kind, block.id), value: block.id }) +
    `<div class="field"><label for="${id}-revision">资料版本</label>
    <input id="${id}-revision" name="${id}-revision" type="number" min="1" max="${Number.MAX_SAFE_INTEGER}" required value="${esc(block.revision)}">
    <a class="workspace-reference" target="_blank" rel="noopener" hidden>查看所选版本原文</a></div>` +
    field(`${id}-excerpt`, '引用原文（选填）', { value: block.excerpt, type: 'textarea', rows: 2, required: false, schema: { maxLength: 4000 } });
}

function bindReference(row, id, block, choices) {
  const kind = row.querySelector(`#field-${id}-kind`);
  const resource = row.querySelector(`#field-${id}-resource`);
  const revision = row.querySelector(`#${id}-revision`);
  const excerpt = row.querySelector('textarea');
  const preview = row.querySelector('a');
  const retainedRange = () => block.kind === kind.value && block.id === resource.value && block.revision === revision.valueAsNumber &&
    (block.excerpt ?? '') === excerpt.value ? block.range : undefined;
  function sync() {
    const href = revision.validity.valid && resourceHref(kind.value, resource.value, revision.valueAsNumber, retainedRange());
    preview.hidden = !href;
    if (href) preview.href = href;
  }
  kind.onchange = () => {
    resource.innerHTML = optionMarkup(resourceOptions(choices, kind.value), '');
    revision.value = '';
    excerpt.value = '';
    sync();
  };
  resource.onchange = () => {
    revision.value = choices[kind.value]?.find(([key]) => key === resource.value)?.[2].revision ?? '';
    excerpt.value = '';
    sync();
  };
  revision.oninput = sync;
  excerpt.oninput = sync;
  sync();
  return () => ({ type: block.type, kind: kind.value, id: resource.value, revision: revision.valueAsNumber,
    ...(excerpt.value.trim() ? { excerpt: excerpt.value } : {}), ...(retainedRange() ? { range: retainedRange() } : {}) });
}

function bindUpload(row, block, retain) {
  let { assetId } = block;
  const { type } = block;
  const input = row.querySelector('input');
  const status = row.querySelector('[role="status"]');
  const preview = row.querySelector('.character-media-preview');
  const show = () => { preview.innerHTML = assetId ? assetPreview(type, assetId, blockLabels[type]) : ''; };
  show();
  let upload = 0;
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const current = ++upload;
    const contentType = file.type || mimeByExtension[file.name.split('.').at(-1).toLowerCase()];
    input.setCustomValidity('正在上传文件，请稍候。');
    status.textContent = '正在上传…';
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('文件不能超过 8 MiB。');
      if (!contentType || !accept[type].split(',').includes(contentType)) throw new Error(`请选择受支持的${blockLabels[type]}文件。`);
      const name = file.name.trim();
      const result = await invoke(step('asset.import', { contentType, data: await fileData(file),
        ...(name && name.length <= 240 && !/[\p{Cc}\p{Surrogate}]/u.test(name) ? { name } : {}),
      }));
      if (upload !== current || !row.isConnected) return;
      assetId = entity(result, 'assetId').assetId;
      input.required = false;
      status.textContent = `已上传 ${file.name}`;
      show();
    } catch (error) {
      if (upload !== current || !row.isConnected) return;
      status.textContent = `${error.message || '上传失败。'}${assetId ? ' 已保留原文件。' : ' 请重新选择文件。'}`;
      input.value = '';
    }
    input.setCustomValidity('');
    input.removeAttribute('aria-invalid');
    retain();
  };
  return () => ({ type, ...(assetId ? { assetId } : {}) });
}
