import { errorText, invoke, step } from './api.js';
import { button, esc, link } from './ui.js';

const drafts = new Map();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function warn(event) {
  event.preventDefault();
  event.returnValue = true;
}

function dirty(draft) {
  return draft.busy || Boolean(draft.call) || !same(draft.values, draft.initial);
}

function updateWarning() {
  if ([...drafts.values()].some(dirty)) window.addEventListener('beforeunload', warn);
  else window.removeEventListener('beforeunload', warn);
}

export function getDraft(key, record, values, character) {
  if (!drafts.has(key)) {
    drafts.set(key, { record, values, initial: values, character });
  }
  return drafts.get(key);
}

export function editor(fields, { label, cancel, required = true }) {
  return `<form class="editor" id="editor" action="/api/web/invoke" method="post" aria-label="${esc(label)}">
    ${required ? '<p class="form-note">带 * 的字段为必填项。</p>' : ''}
    ${fields}
    <p id="save-error" class="notice" role="alert" hidden></p>
    <section id="conflict" class="notice" aria-label="版本冲突" hidden></section>
    <div class="form-actions">
      ${button('save', label, null, 'primary', 'submit')}
      ${link(cancel, '返回', null, 'quiet')}
      ${button('discard', '清除草稿', null, 'quiet')}
      <span id="save-progress" class="muted" role="status"></span>
    </div>
  </form>`;
}

export function bindEditor(ctx, draft, config) {
  const form = ctx.main.querySelector('#editor');
  const save = form.querySelector('#save');
  const discard = form.querySelector('#discard');
  const progress = form.querySelector('#save-progress');
  const errorBox = form.querySelector('#save-error');
  const conflictBox = form.querySelector('#conflict');
  const controls = Object.keys(draft.initial).map(name => form.elements.namedItem(name));

  function sync() {
    const locked = draft.busy || draft.uncertain;
    for (const control of controls) control.disabled = Boolean(locked);
    save.disabled = Boolean(draft.busy || draft.conflict);
    save.textContent = draft.busy ? '正在保存…' : draft.call ? '重试保存' : config.label;
    discard.hidden = Boolean(locked) || !dirty(draft);
    progress.textContent = draft.busy ? '保存中' : dirty(draft) ? '有未保存的修改' : '';
    errorBox.hidden = !draft.error;
    errorBox.textContent = draft.error ?? '';
    if (!dirty(draft)) drafts.delete(ctx.key);
    else drafts.set(ctx.key, draft);
    updateWarning();
  }

  function retainValues() {
    draft.values = Object.fromEntries(controls.map(control => [control.name, control.value]));
    if (draft.error && !draft.conflict) draft.error = '';
    sync();
  }

  function applyLatest(latest, replace) {
    if (config.latestValues) {
      const latestValues = config.latestValues(latest);
      const values = { ...latestValues };
      if (!replace) {
        for (const key of Object.keys(values)) {
          if (draft.values[key] !== draft.initial[key]) values[key] = draft.values[key];
        }
      }
      draft.initial = latestValues;
      draft.values = values;
      draft.record = latest;
      for (const control of controls) control.value = values[control.name];
    } else {
      draft.character = latest;
    }
    draft.conflict = false;
    draft.error = '';
    conflictBox.hidden = true;
    sync();
    save.focus();
  }

  async function showConflict() {
    conflictBox.hidden = false;
    conflictBox.innerHTML = '<p role="status">正在读取最新版本…</p>';
    try {
      const latest = await config.readLatest(draft, ctx.signal);
      if (!ctx.active()) return;
      conflictBox.innerHTML = `<p role="alert">${esc(config.conflictText)}</p>
        ${config.preview(latest)}
        <div class="actions">${button('apply-latest', config.latestValues ? '保留我的修改并采用新版' : '采用最新角色设定', null, 'secondary')}
        ${config.latestValues ? button('replace-draft', '改用最新版', null, 'quiet') : ''}</div>`;
      conflictBox.querySelector('#apply-latest').onclick = () => applyLatest(latest, false);
      conflictBox.querySelector('#replace-draft')?.addEventListener('click', () => applyLatest(latest, true));
    } catch (error) {
      if (!ctx.active()) return;
      conflictBox.innerHTML = `<p role="alert">${esc(errorText(error))}</p>${button('reload-latest', '重新读取最新版', 'refresh', 'secondary')}`;
      conflictBox.querySelector('#reload-latest').onclick = showConflict;
    }
  }

  form.addEventListener('input', event => {
    if (!controls.includes(event.target)) return;
    event.target.setCustomValidity('');
    event.target.removeAttribute('aria-invalid');
    retainValues();
  });
  form.addEventListener('invalid', event => {
    const control = event.target;
    const label = control.labels[0]?.textContent.replace(/\s*\*$/, '') ?? '';
    if (control.validity.valueMissing) control.setCustomValidity(`请填写${label}。`);
    control.setAttribute('aria-invalid', 'true');
  }, true);

  discard.onclick = () => {
    if (!window.confirm('清除这份未保存的草稿？')) return;
    drafts.delete(ctx.key);
    updateWarning();
    ctx.refresh();
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (draft.busy || draft.conflict) return;
    draft.error = '';
    if (!draft.uncertain) {
      retainValues();
      for (const control of controls) {
        if (control.required && !control.value.trim()) {
          control.setCustomValidity('请输入内容，不能只填写空格。');
          control.reportValidity();
          return;
        }
      }
    }

    draft.busy = true;
    sync();
    // Start on user action, independent of the route's read cancellation.
    draft.flight = (async () => {
      try {
        draft.call ??= step(config.operation, await config.input(draft));
        const result = config.result(await invoke(draft.call));
        drafts.delete(ctx.key);
        ctx.saved(config.href(result), config.success);
      } catch (error) {
        draft.uncertain = Boolean(draft.call && error.uncertain);
        if (!draft.uncertain) draft.call = undefined;
        draft.conflict = Boolean(error.conflict && config.readLatest && (config.latestValues || draft.character));
        draft.error = draft.conflict ? '' : `${errorText(error)}${draft.uncertain ? ' 请重试同一次保存。' : ''}`;
      } finally {
        draft.busy = false;
        draft.flight = undefined;
        updateWarning();
      }
    })();
    await draft.flight;
    if (ctx.active()) {
      sync();
      if (draft.conflict) await showConflict();
      else if (draft.error) save.focus();
    }
  };

  sync();
  if (draft.flight) draft.flight.then(() => { if (ctx.active()) ctx.refresh(); });
  if (draft.conflict) void showConflict();
}
