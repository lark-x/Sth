<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { errorText } from '../api.ts';
import Button from '../ui/Button.vue';
import { issueCode, listConnections, revokeConnection } from './api.ts';
import type { Connection } from './api.ts';
import CopyCommand from './CopyCommand.vue';
import InstallGuide from './InstallGuide.vue';
import { matchesConnectionsRoute } from './routes.ts';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const matches = computed(() => matchesConnectionsRoute(props.url));
const isSettings = computed(() => /^\/settings\/?$/.test(props.url.pathname));
const records = ref<Connection[]>([]);
const active = computed(() => records.value.filter(item => !item.revokedAt));
const revoked = computed(() => records.value.filter(item => item.revokedAt));
const loading = ref(false);
const listError = ref('');
const issuing = ref(false);
const issueError = ref('');
const code = ref('');
const expiresAt = ref('');
const codeStatus = ref('');
const announcement = ref('');
const issueButton = ref<HTMLButtonElement>();
const refreshButton = ref<HTMLButtonElement>();
const dialog = ref<HTMLDialogElement>();
const cancelButton = ref<HTMLButtonElement>();
const selected = ref<Connection>();
const revoking = ref(false);
const revokeError = ref('');
let lifetime = new AbortController();
let listRequest: AbortController | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function time(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function hideCode() { clearTimeout(expiryTimer); code.value = ''; expiresAt.value = ''; }
function expire() {
  const remaining = Date.parse(expiresAt.value) - Date.now();
  if (remaining > 0) expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
  else { hideCode(); codeStatus.value = '配对码已过期。'; }
}

async function generateCode() {
  if (issuing.value) return;
  const signal = lifetime.signal;
  issuing.value = true;
  issueError.value = '';
  hideCode();
  codeStatus.value = '正在生成配对码…';
  try {
    const result = await issueCode(signal);
    if (signal.aborted) return;
    code.value = result.code;
    expiresAt.value = result.expiresAt;
    codeStatus.value = '配对码已生成。';
    expire();
  } catch (error) {
    if (signal.aborted) return;
    issueError.value = errorText(error);
    codeStatus.value = '';
  } finally { if (!signal.aborted) issuing.value = false; }
}

async function reload() {
  listRequest?.abort();
  const request = new AbortController();
  listRequest = request;
  const signal = AbortSignal.any([lifetime.signal, request.signal]);
  loading.value = true;
  listError.value = '';
  try {
    const items = await listConnections(signal);
    if (!signal.aborted) records.value = items;
  } catch (error) {
    if (!signal.aborted) listError.value = errorText(error);
  } finally { if (!signal.aborted) loading.value = false; }
}

async function openRevoke(item: Connection) {
  selected.value = item;
  revokeError.value = '';
  dialog.value?.showModal();
  await nextTick();
  cancelButton.value?.focus();
}

async function confirmRevoke() {
  if (!selected.value || revoking.value) return;
  const signal = lifetime.signal;
  revoking.value = true;
  revokeError.value = '';
  try {
    await revokeConnection(selected.value.connectionId, signal);
    if (signal.aborted) return;
    dialog.value?.close();
    announcement.value = '连接已撤销';
    await reload();
    if (!signal.aborted) refreshButton.value?.focus();
  } catch (error) {
    if (!signal.aborted) revokeError.value = errorText(error);
  } finally { if (!signal.aborted) revoking.value = false; }
}

function onNavigate(event: MouseEvent, href: string) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  emit('navigate', href);
}

watch(() => props.url.href, (_value, _previous, onCleanup) => {
  lifetime = new AbortController();
  const controller = lifetime;
  hideCode();
  codeStatus.value = issueError.value = announcement.value = listError.value = '';
  issuing.value = revoking.value = false;
  records.value = [];
  onCleanup(() => { controller.abort(); listRequest?.abort(); hideCode(); dialog.value?.close(); });
  if (matches.value) {
    document.title = '连接设置 · Sth';
    void reload();
  }
}, { immediate: true });
</script>

<template>
  <div v-if="matches" class="connections-route">
    <a v-if="isSettings" class="back" href="/" @click="onNavigate($event, '/')">返回首页</a>
    <a v-else class="back" href="/settings" @click="onNavigate($event, '/settings')">返回设置</a>
    <header class="connections-header">
      <h1 tabindex="-1">连接设置</h1>
      <p>让助手与你共用 Sth 的日记、角色和资料。</p>
      <a v-if="isSettings" href="/settings/connections" @click="onNavigate($event, '/settings/connections')">连接管理</a>
    </header>
    <p class="service-origin">当前 Sth 服务 <code>{{ url.origin }}</code></p>

    <section class="pairing-section" aria-labelledby="code-heading">
      <div class="section-heading">
        <h2 id="code-heading">配对码</h2>
        <button ref="issueButton" type="button" class="button primary" :disabled="issuing" @click="generateCode">生成配对码</button>
      </div>
      <p class="section-note">每个宿主单独配对。配对码有效期为 10 分钟，生成新码会使前一个失效。已配对的连接持续有效，直到撤销。</p>
      <p v-if="issueError" class="error" role="alert">{{ issueError }}</p>
      <p id="code-status" class="section-note" role="status">{{ codeStatus }}</p>
      <div v-if="code" id="pairing" class="pairing-code">
        <p class="section-note">Hermes 配对命令 · 有效至 <time :datetime="expiresAt">{{ time(expiresAt) }}</time></p>
        <CopyCommand :text="`sth personal connect ${code}`" label="复制命令" success-message="配对命令已复制。" fallback-message="已选中配对命令，请手动复制。" :valid-until="Date.parse(expiresAt)" @expired="expire">
          <Button variant="ghost" @click="hideCode(); codeStatus = ''; issueButton?.focus()">收起</Button>
        </CopyCommand>
      </div>
    </section>

    <InstallGuide :origin="url.origin" />

    <section class="connections-section" aria-labelledby="connections-heading">
      <div class="section-heading">
        <h2 id="connections-heading">连接记录</h2>
        <button ref="refreshButton" type="button" class="button secondary" :disabled="loading" @click="reload">刷新</button>
      </div>
      <p v-if="listError" class="error" role="alert">{{ listError }}</p>
      <p role="status" class="section-note">{{ loading ? '正在读取连接…' : !listError && !records.length ? '还没有连接记录。' : '' }}</p>
      <template v-for="group in [{ title: '有效连接', items: active }, { title: '撤销记录', items: revoked }]" :key="group.title">
        <template v-if="group.items.length">
          <h3 class="group-heading">{{ group.title }}</h3>
          <ul class="connection-list">
            <li v-for="item in group.items" :key="item.connectionId" class="connection-record">
              <div class="record-copy">
                <h4>{{ item.clientName }}</h4>
                <p>连接于 <time :datetime="item.createdAt">{{ time(item.createdAt) }}</time><template v-if="item.revokedAt"> · 撤销于 <time :datetime="item.revokedAt">{{ time(item.revokedAt) }}</time></template></p>
              </div>
              <span class="connection-state">{{ item.revokedAt ? '已撤销' : '有效' }}</span>
              <button v-if="!item.revokedAt" type="button" class="button quiet" :aria-label="`撤销连接 ${item.clientName}`" @click="openRevoke(item)">撤销</button>
            </li>
          </ul>
        </template>
      </template>
    </section>

    <details class="access-help">
      <summary>服务地址与手机访问</summary>
      <p>助手需要连接上方同一 Sth 服务。本机可使用 loopback HTTP，远程助手使用可访问的 HTTPS 地址。手机需要能访问的网页地址，loopback 地址指向手机本身。</p>
      <p>远程网页由服务端配置 STH_PUBLIC_ORIGIN 和 STH_WEB_PASSWORD，通过保留 Host 的 HTTPS 反向代理访问。浏览器登录用户名为 sth，密码由服务管理员设置。Hermes 的 STH_PERSONAL_OPERATIONS_PORTAL_ORIGIN 指定回复中的网页地址。</p>
      <p>一次性码和令牌赋予个人目录访问权限。请在可信私聊或本机隐藏输入中使用，并在下方撤销不再使用的连接。</p>
    </details>
    <p class="section-note" role="status" aria-atomic="true">{{ announcement }}</p>

    <dialog ref="dialog" class="revoke-dialog" aria-labelledby="revoke-heading" aria-describedby="revoke-description" @cancel="revoking && $event.preventDefault()">
      <h2 id="revoke-heading">撤销连接</h2>
      <p id="revoke-description">「{{ selected?.clientName }}」将失去访问权限。</p>
      <p v-if="revokeError" class="error" role="alert">{{ revokeError }}</p>
      <form method="dialog" class="dialog-actions" @submit="revoking && $event.preventDefault()">
        <button ref="cancelButton" type="submit" class="button secondary" :disabled="revoking">取消</button>
        <button type="button" class="button danger" :disabled="revoking" @click="confirmRevoke">撤销连接</button>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.connections-route { min-inline-size: 0; max-inline-size: 53rem; margin-inline: auto; color: var(--ink); }
.connections-route h1 { font: 650 1.8rem/1.4 var(--sans); text-wrap: balance; }
.connections-route h2 { font: 650 1.18rem/1.5 var(--sans); text-wrap: balance; }
.connections-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: .45rem 1rem; padding-block-end: 1rem; border-block-end: 1px solid var(--line); }
.connections-header h1 { inline-size: 100%; }
.connections-header p { grid-column: 1; color: var(--muted); }
.connections-header a:not(.ui-button) { display: inline-flex; align-items: center; min-block-size: 2.75rem; color: var(--accent-deep); }
.service-origin { padding-block: .75rem 1.4rem; color: var(--muted); font-size: .84rem; overflow-wrap: anywhere; }
.service-origin code { color: var(--ink); }
.section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .75rem; margin-block-end: .65rem; }
.pairing-section { padding-block: 1.1rem 1.35rem; border-block: 1px solid var(--line); }
.section-note { max-inline-size: 70ch; font-size: .9rem; color: var(--muted); line-height: 1.8; }
#code-status { margin-block-start: .5rem; }
.pairing-code { max-inline-size: 40rem; margin-block-start: .9rem; padding-block-start: .75rem; border-block-start: 1px solid var(--line); }
.error { margin-block: .75rem; font-size: .92rem; color: var(--danger); overflow-wrap: anywhere; }
.group-heading { margin-block: 1.2rem .4rem; color: var(--muted); font-size: .84rem; font-weight: 600; }
.connection-list { list-style: none; margin: 0; padding: 0; border-block-start: 1px solid var(--line); }
.connection-record { display: flex; align-items: center; gap: .75rem 1rem; padding-block: .85rem; border-block-end: 1px solid var(--line); }
.connection-record > .button { flex: 0 0 auto; }
.record-copy { flex: 1; min-inline-size: 0; }
.record-copy h4 { margin: 0; font-size: 1rem; font-weight: 650; overflow-wrap: anywhere; }
.record-copy p { margin-block-start: .3rem; color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }
.connection-state { flex: 0 0 auto; color: var(--ink); font-size: .8125rem; font-weight: 550; }
.connections-section > .section-note:empty { display: none; }
.access-help { margin-block-start: 1.5rem; border-block-start: 1px solid var(--line); padding-block: .75rem 1rem; }
.access-help summary { cursor: pointer; min-block-size: 2.75rem; color: var(--accent-deep); }
.access-help p { max-inline-size: 70ch; font-size: .9rem; line-height: 1.8; margin-block: .7rem; overflow-wrap: anywhere; color: var(--muted); }
.revoke-dialog { inline-size: min(30rem, calc(100% - 2rem)); max-block-size: calc(100dvh - 2rem); padding: 1.5rem; overflow: auto; border: 1px solid var(--line-strong); border-radius: var(--radius-panel, 12px); background: var(--sheet); color: var(--ink); }
.revoke-dialog::backdrop { background: rgb(37 37 37 / 45%); }
.revoke-dialog p { margin-block: 1rem; overflow-wrap: anywhere; }
.dialog-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
@media (width <= 30rem) {
  .connections-header { grid-template-columns: minmax(0, 1fr); align-items: start; }
  .connections-header p { grid-column: 1; }
  .connections-header > :is(a, .ui-button) { justify-self: start; }
  .connection-record { flex-wrap: wrap; }
  .record-copy { flex-basis: calc(100% - 4rem); }
  .connection-record .button { margin-inline-start: auto; }
}
</style>
