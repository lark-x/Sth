import { ApiError, connections, errorText, issueCode, revoke } from './api.js';
import { button, esc, heading, rows, time } from './ui.js';

export function connectionsPage(ctx) {
  if (!ctx.show('连接设置', `${heading('连接设置')}
    <section class="settings-section" aria-labelledby="code-heading">
      <div class="section-head"><h2 id="code-heading">配对码</h2>${button('issue', '生成配对码', 'plus', 'primary')}</div>
      <p id="issue-error" class="notice" role="alert" hidden></p>
      <p id="code-status" class="muted" role="status"></p>
      <div id="pairing" class="pairing" hidden></div>
    </section>
    <section class="settings-section" aria-labelledby="connections-heading">
      <div class="section-head"><h2 id="connections-heading">连接记录</h2>${button('refresh', '刷新', 'refresh', 'secondary')}</div>
      <p id="connections-status" role="status" class="muted"></p>
      <div id="connections-list"></div>
    </section>
    <dialog class="confirmation" aria-labelledby="revoke-heading" aria-describedby="revoke-description">
      <h2 id="revoke-heading">撤销连接</h2><p id="revoke-description"></p>
      <p id="revoke-error" class="notice" role="alert" hidden></p>
      <form method="dialog" class="actions">${button('cancel-revoke', '取消', null, 'secondary', 'submit')}${button('confirm-revoke', '撤销连接', null, 'danger')}</form>
    </dialog>`)) return;

  const find = selector => ctx.main.querySelector(selector);
  const pairing = find('#pairing');
  const status = find('#code-status');
  const issue = find('#issue');
  const issueError = find('#issue-error');
  const refresh = find('#refresh');
  const listStatus = find('#connections-status');
  const listBody = find('#connections-list');
  const dialog = find('dialog');
  const confirm = find('#confirm-revoke');
  const cancel = find('#cancel-revoke');
  const revokeError = find('#revoke-error');
  let expiryTimer;

  function hideCode() {
    clearTimeout(expiryTimer);
    pairing.replaceChildren();
    pairing.hidden = true;
  }
  ctx.signal.addEventListener('abort', hideCode, { once: true });

  issue.onclick = async () => {
    issue.disabled = true;
    issueError.hidden = true;
    hideCode();
    status.textContent = '正在生成配对码…';
    try {
      const result = await issueCode();
      if (!ctx.active()) return;
      const expires = Date.parse(result?.expiresAt);
      if (typeof result?.code !== 'string' || !result.code || !Number.isFinite(expires)) {
        throw new ApiError(502, '', '服务未返回有效配对码。');
      }
      function expire() {
        const remaining = expires - Date.now();
        if (remaining > 0) expiryTimer = setTimeout(expire, Math.min(remaining, 2147483647));
        else {
          hideCode();
          status.textContent = '配对码已过期。';
        }
      }
      const command = `sth personal connect ${result.code}`;
      pairing.innerHTML = `<span class="muted">Hermes 配对命令 · 有效至 ${time(result.expiresAt, 'datetime')}</span>
        <code>${esc(command)}</code><div class="actions">${button('copy-code', '复制命令', 'copy', 'secondary')}
        ${button('hide-code', '收起', null, 'quiet')}</div>`;
      pairing.hidden = false;
      status.textContent = '配对码已生成。';
      find('#copy-code').onclick = async () => {
        if (Date.now() >= expires) return expire();
        try {
          await navigator.clipboard.writeText(command);
          if (ctx.active()) status.textContent = '配对命令已复制。';
        } catch {
          const code = pairing.querySelector('code');
          if (!ctx.active() || !code) return;
          const selection = window.getSelection();
          selection.selectAllChildren(code);
          status.textContent = '已选中配对命令，请手动复制。';
        }
      };
      find('#hide-code').onclick = () => { hideCode(); status.textContent = ''; issue.focus(); };
      expire();
    } catch (error) {
      if (!ctx.active()) return;
      issueError.hidden = false;
      issueError.textContent = errorText(error);
      status.textContent = '';
    } finally {
      issue.disabled = false;
    }
  };

  function listMarkup(items) {
    return rows(items, item => `<div class="connection-row"><div class="row-text"><h3>${esc(item.clientName)}</h3>
      <p class="row-meta">连接于 ${time(item.createdAt, 'datetime')}${item.revokedAt ? ` · 撤销于 ${time(item.revokedAt, 'datetime')}` : ''}</p></div>
      <span class="connection-state${item.revokedAt ? '' : ' active'}">${item.revokedAt ? '已撤销' : '有效'}</span>
      ${item.revokedAt ? '' : `<button type="button" class="button quiet" data-connection="${esc(item.connectionId)}" aria-label="撤销连接 ${esc(item.clientName)}">撤销</button>`}</div>`);
  }

  async function reload() {
    if (refresh.disabled) return;
    refresh.disabled = true;
    listStatus.textContent = '正在读取连接…';
    try {
      const items = await connections(ctx.signal);
      if (!ctx.active()) return;
      const active = items.filter(item => !item.revokedAt);
      const revoked = items.filter(item => item.revokedAt);
      listStatus.textContent = items.length ? '' : '还没有连接记录。';
      listBody.innerHTML = [active.length && `<h3 class="subheading">有效连接</h3>${listMarkup(active)}`,
        revoked.length && `<h3 class="subheading">撤销记录</h3>${listMarkup(revoked)}`].filter(Boolean).join('');
      for (const control of listBody.querySelectorAll('[data-connection]')) {
        control.onclick = () => openRevoke(active.find(item => item.connectionId === control.dataset.connection));
      }
    } catch (error) {
      if (ctx.active()) listStatus.textContent = errorText(error);
    } finally {
      refresh.disabled = false;
    }
  }

  function openRevoke(item) {
    revokeError.hidden = true;
    find('#revoke-description').textContent = `「${item.clientName}」将失去访问权限。`;
    dialog.showModal();
    cancel.focus();
    confirm.onclick = async () => {
      confirm.disabled = cancel.disabled = true;
      revokeError.hidden = true;
      try {
        await revoke(item.connectionId);
        if (!ctx.active()) return;
        dialog.close();
        ctx.announce('连接已撤销');
        await reload();
        refresh.focus();
      } catch (error) {
        if (!ctx.active()) return;
        revokeError.textContent = errorText(error);
        revokeError.hidden = false;
      } finally {
        confirm.disabled = cancel.disabled = false;
      }
    };
  }

  dialog.addEventListener('cancel', event => { if (confirm.disabled) event.preventDefault(); });
  refresh.onclick = reload;
  void reload();
}
