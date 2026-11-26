import { errorText, invoke, retryWrite, step } from './api.js';
import { renderFields } from './workspace-fields.js';
import { inputFor, referenceChoices, schemaOf } from './workspace-model.js';
import { back, button, esc, heading, link } from './ui.js';
import { prose } from './workspace-view.js';

const pending = new Map();

export function workspaceError(error) {
  if (error?.status >= 400 && error.status < 500 && error.message && ![401, 403, 429].includes(error.status)) {
    return error.message;
  }
  return errorText(error);
}

export function bindWrite(ctx, catalog, form, operationId, getInput, success, { key = ctx.key, conflict } = {}) {
  const submit = form.querySelector('button[type="submit"]');
  const notice = form.querySelector('[role="alert"]');
  const original = submit.textContent;
  const restore = new Map();

  function sync(busy = false) {
    const locked = busy || pending.has(key);
    for (const control of form.querySelectorAll('input, select, textarea, button:not([type="submit"])')) {
      if (locked) {
        if (!restore.has(control)) restore.set(control, control.disabled);
        control.disabled = true;
      } else if (restore.has(control)) {
        control.disabled = restore.get(control);
        restore.delete(control);
      }
    }
    const inFlight = pending.get(key)?.inFlight;
    submit.disabled = busy || Boolean(inFlight);
    submit.textContent = busy || inFlight ? '正在提交…' : locked ? '重试同一次提交' : original;
  }

  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    notice.hidden = true;
    let request = pending.get(key);
    const retry = Boolean(request);
    try {
      if (!request) {
        const input = getInput();
        sync(true);
        request = { call: step(operationId, inputFor(catalog, operationId, await input)) };
      }
      request.inFlight = true;
      pending.set(key, request);
      sync(true);
      const result = await (retry ? retryWrite(request.call) : invoke(request.call));
      pending.delete(key);
      if (ctx.active()) success(result);
    } catch (error) {
      if (request) request.inFlight = false;
      if (!error.uncertain) pending.delete(key);
      if (!ctx.active()) return;
      notice.textContent = workspaceError(error) + (error.uncertain && request ? ' 请重试同一次提交。' : '');
      notice.hidden = false;
      if (error.status === 409) await conflict?.(error);
      notice.focus();
    } finally {
      sync();
    }
  };
  sync();
}

export const errorBox = '<p class="notice" role="alert" tabindex="-1" hidden></p>';

export async function operationPage(ctx, catalog, config) {
  const { id, title, backTo, values = {}, fixed = {}, clearable, complete, latest, subtitle } = config;
  const rule = config.schema ?? schemaOf(catalog, id);
  const choices = config.choices ?? await referenceChoices(catalog, rule, { ...values, ...fixed }, ctx.signal);
  if (!ctx.show(title, `${heading(title, { trail: back(backTo, '返回'), meta: subtitle ? `<p class="masthead-meta">${esc(subtitle)}</p>` : '' })}
    <form class="editor" id="workspace-editor" aria-label="${esc(title)}" action="/api/web/invoke" method="post">
      <div class="workspace-fields" id="workspace-fields"></div>${errorBox}<div id="workspace-conflict" hidden></div>
      <div class="form-actions">${button('workspace-submit', config.submit ?? title, null, 'primary', 'submit')}
        ${link(backTo, '返回', null, 'quiet')}</div>
    </form>`)) return;
  const form = ctx.main.querySelector('#workspace-editor');
  const get = renderFields(form.querySelector('#workspace-fields'), rule, values, {
    choices, fixed, clearable, orderable: config.orderable, referenceExtras: config.referenceExtras, signal: ctx.signal,
  });
  config.configure?.(form, get);
  bindWrite(ctx, catalog, form, id, () => config.input ? config.input(get()) : get(), complete, {
    conflict: latest && (async error => {
      if (!error.conflict) return;
      const region = form.querySelector('#workspace-conflict');
      region.hidden = false;
      region.innerHTML = '<p class="muted">正在读取最新版本…</p>';
      const save = form.querySelector('[type="submit"]');
      try {
        const current = await latest();
        if (!ctx.active()) return;
        region.innerHTML = `<details open><summary>当前版本 · 第 ${esc(current.revision)} 版</summary>
          ${current.title ? `<p>${esc(current.title)}</p>` : ''}${current.body ? prose(current.body) : ''}</details>
          ${link(backTo, '查看当前版本', null, 'secondary')}`;
        // Keep this draft intact so the author can review and copy its edits.
        save.addEventListener('click', event => event.preventDefault());
        form.addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); }, { capture: true });
        save.setAttribute('aria-disabled', 'true');
      } catch (error) {
        if (ctx.active()) region.textContent = workspaceError(error);
      }
    }),
  });
}

