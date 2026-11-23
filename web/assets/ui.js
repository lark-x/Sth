// Lucide icon paths, see lucide-LICENSE.txt.
const icons = {
  diary: '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4M2 6h4m-4 4h4m-4 4h4m-4 4h4M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  people: '<path d="M18 21a8 8 0 0 0-16 0M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/><circle cx="10" cy="8" r="5"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2m6 0h2a5 5 0 1 1 0 10h-2m-7-5h8"/>',
  pen: '<path d="M13 21h8M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  back: '<path d="m12 19-7-7 7-7m7 7H5"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8m0-5v5h-5m5 4a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16m5 0H3v5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
};

export const icon = name => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);
export const path = (section, id) => `/${section}/${encodeURIComponent(id)}`;
export const query = (url, params) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value));
  return search.size ? `${url}?${search}` : url;
};

export const link = (href, label, glyph, style = '') =>
  `<a class="button ${style}" href="${esc(href)}">${glyph ? icon(glyph) : ''}${esc(label)}</a>`;
export const button = (id, label, glyph, style = '', type = 'button') =>
  `<button class="button ${style}" id="${id}" type="${type}">${glyph ? icon(glyph) : ''}${esc(label)}</button>`;
export const back = (href, label) => `<a class="back" href="${esc(href)}">${icon('back')}${esc(label)}</a>`;

export function heading(title, { actions = '', meta = '', trail = '' } = {}) {
  return `${trail}<header class="masthead"><div class="heading-copy"><h1 tabindex="-1">${esc(title)}</h1>${meta}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</header>`;
}

export function empty(glyph, title, text = '', action = '') {
  return `<div class="empty">${icon(glyph)}<p class="empty-title">${esc(title)}</p>${text ? `<p class="muted">${esc(text)}</p>` : ''}${action}</div>`;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function today() {
  const now = new Date();
  const two = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

export function time(value, mode = 'date') {
  if (!value) return '';
  const date = new Date(mode === 'date' ? `${value}T12:00:00` : value);
  const format = mode === 'date' ? dateFormat : mode === 'time' ? timeFormat : dateTimeFormat;
  return Number.isFinite(+date) ? `<time datetime="${esc(value)}">${format.format(date)}</time>` : '';
}

export function field(name, label, { value = '', type = 'text', required = true, options, rows = 6, schema } = {}) {
  const attributes = `id="field-${name}" name="${name}"${required ? ' required' : ''}`;
  const max = Number.isInteger(schema?.maxLength) ? ` maxlength="${schema.maxLength}"` : '';
  const min = Number.isInteger(schema?.minLength) ? ` minlength="${schema.minLength}"` : '';
  let control;
  if (options) {
    control = `<select ${attributes}>${optionMarkup(options, value)}</select>`;
  } else if (type === 'textarea') {
    control = `<textarea ${attributes}${max}${min} rows="${rows}">\n${esc(value)}</textarea>`;
  } else {
    control = `<input ${attributes}${max}${min} type="${type}" value="${esc(value)}"${type === 'date' ? ' min="0001-01-01" max="9999-12-31"' : ''}>`;
  }
  return `<div class="field"><label for="field-${name}">${esc(label)}${required ? '<span class="required" aria-hidden="true"> *</span>' : ''}</label>${control}</div>`;
}

export const optionMarkup = (options, selected) => options.map(([value, label]) =>
  `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');

export const projectOptions = (projects, first) => [['', first], ...projects.map(project => [project.projectId, project.title])];

export function rows(items, row) {
  return `<ul class="rows">${items.map(item => `<li>${row(item)}</li>`).join('')}</ul>`;
}

export function rowLink(href, title, detail = '', lead = '') {
  return `<a class="row" href="${esc(href)}">${lead}<div class="row-text"><h3>${esc(title)}</h3>${detail}</div>${icon('next')}</a>`;
}
