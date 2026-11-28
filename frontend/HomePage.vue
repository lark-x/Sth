<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { ApiError, errorText, invoke, localDate, operation } from './api.ts';
import type { DiarySummary } from './api.ts';
import type { RouteEvents } from './routes.ts';
import { quickBody, quickCall } from './quick-note.ts';
import { loadRecentManuscripts, recentManuscripts, rememberManuscript } from './manuscript/recent.ts';
import type { RecentManuscript } from './manuscript/recent.ts';
import './home.css';

const emit = defineEmits<RouteEvents>();
const diaries = ref<DiarySummary[]>([]);
const loading = ref(true);
const recentError = ref('');
const saveError = ref('');
const saving = ref(false);
const manuscripts = ref<ReturnType<typeof recentManuscripts>>([]);
const manuscriptsLoading = ref(true);
const manuscriptsError = ref('');
const manuscriptsIncomplete = ref(false);
const quickNote = ref<HTMLTextAreaElement>();
let manuscriptRequest: AbortController | undefined;
const manuscriptKinds = { draft: '候选稿', scene: '场景', diary: '日记' };
const controller = new AbortController();
const today = localDate();
const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());

async function loadRecent() {
  loading.value = true;
  recentError.value = '';
  try {
    const result = await invoke<{ items: DiarySummary[] }>(operation('diary.list', { limit: 6, offset: 0 }), controller.signal);
    if (!Array.isArray(result.items)) throw new Error('invalid list');
    diaries.value = result.items;
  } catch (error) {
    if (!controller.signal.aborted) recentError.value = errorText(error);
  } finally { if (!controller.signal.aborted) loading.value = false; }
}

async function save() {
  if (saving.value || !quickBody.value.trim()) return;
  saving.value = true;
  saveError.value = '';
  const call = quickCall.value ??= operation('diary.create', {
    title: quickBody.value.trim().split('\n')[0]!.slice(0, 40),
    body: quickBody.value,
    diaryDate: localDate(),
  });
  try {
    const saved = await invoke<DiarySummary>(call);
    if (typeof saved.noteId !== 'string' || !saved.noteId) throw new ApiError(502, 'invalid_result', '服务未返回日记编号。');
    rememberManuscript({ kind: 'diary', id: saved.noteId, title: saved.title,
      href: `/diaries/${encodeURIComponent(saved.noteId)}?edit=1` });
    if (quickCall.value?.stepId === call.stepId) {
      quickBody.value = '';
      quickCall.value = undefined;
    }
    if (!controller.signal.aborted) emit('navigate', `/diaries/${encodeURIComponent(saved.noteId)}`);
  } catch (error) {
    const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status === 408 || error.status >= 500;
    if (!uncertain && quickCall.value?.stepId === call.stepId) quickCall.value = undefined;
    saveError.value = uncertain ? '保存结果暂未确认，内容已保留。请点击“核对并重试”，确认这次保存。' : errorText(error);
  } finally { saving.value = false; }
}

function excerpt(body: string) {
  const text = body.trim().replace(/\s+/g, ' ');
  return text.length > 110 ? `${text.slice(0, 110)}…` : text;
}

async function refreshManuscripts() {
  manuscriptRequest?.abort();
  const request = new AbortController();
  manuscriptRequest = request;
  manuscriptsLoading.value = true;
  manuscriptsError.value = '';
  try {
    const result = await loadRecentManuscripts(recentManuscripts(), request.signal);
    if (request.signal.aborted) return;
    manuscripts.value = result.items;
    manuscriptsIncomplete.value = result.incomplete;
  } catch (error) {
    if (!request.signal.aborted) manuscriptsError.value = errorText(error);
  } finally { if (!request.signal.aborted) manuscriptsLoading.value = false; }
}

function editedAt(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function opensEditor(manuscript: RecentManuscript) {
  const params = new URL(manuscript.href, location.origin).searchParams;
  return manuscript.kind !== 'scene' && params.get('edit') === '1' && !params.has('revision');
}

function manuscriptRevision(manuscript: RecentManuscript & { revision?: unknown }) {
  const params = new URL(manuscript.href, location.origin).searchParams;
  if (params.has('revision')) {
    const revision = params.get('revision')!;
    return /^[1-9]\d*$/.test(revision) && Number.isSafeInteger(Number(revision)) ? Number(revision) : undefined;
  }
  return typeof manuscript.revision === 'number' && Number.isSafeInteger(manuscript.revision) && manuscript.revision > 0
    ? manuscript.revision : undefined;
}

function diaryExcerpt(manuscript: RecentManuscript) {
  if (manuscript.kind !== 'diary') return undefined;
  const revision = manuscriptRevision(manuscript);
  const diary = diaries.value.find(diary => diary.noteId === manuscript.id && diary.revision === revision);
  return diary ? excerpt(diary.body) : undefined;
}

function fitQuickNote() {
  const textarea = quickNote.value;
  if (!textarea || CSS.supports('field-sizing', 'content')) return;
  textarea.style.height = 'auto';
  const maximum = Number.parseFloat(getComputedStyle(textarea).maxHeight);
  textarea.style.height = `${Math.min(textarea.scrollHeight, Number.isFinite(maximum) ? maximum : textarea.scrollHeight)}px`;
}

onMounted(() => {
  fitQuickNote();
  document.title = '首页 · Sth';
  refreshManuscripts();
  void loadRecent();
  window.addEventListener('storage', refreshManuscripts);
  window.addEventListener('focus', refreshManuscripts);
  window.addEventListener('sth:manuscripts-changed', refreshManuscripts);
});
onBeforeUnmount(() => {
  controller.abort();
  manuscriptRequest?.abort();
  window.removeEventListener('storage', refreshManuscripts);
  window.removeEventListener('focus', refreshManuscripts);
  window.removeEventListener('sth:manuscripts-changed', refreshManuscripts);
});
</script>

<template>
  <div class="sth-home">
    <header class="sth-home-header">
      <h1 tabindex="-1">记一句</h1>
      <time :datetime="today">{{ dateLabel }}</time>
    </header>

    <form class="sth-capture" @submit.prevent="save">
      <div class="sth-capture-field ui-field">
        <label for="quick-note">此刻想记下什么</label>
        <textarea id="quick-note" ref="quickNote" class="ui-input sth-capture-input" v-model="quickBody" name="body" rows="2" maxlength="100000" required :readonly="saving || Boolean(quickCall)" placeholder="一个念头，或者今天发生的小事。" :aria-describedby="saveError ? 'quick-note-error' : undefined" @input="fitQuickNote" />
      </div>
      <p v-if="saveError" id="quick-note-error" class="sth-error" role="alert">{{ saveError }}</p>
      <p v-else-if="quickCall && !saving" class="sth-error">上一次保存需要确认，内容已保留。请核对并重试。</p>
      <div class="sth-capture-footer">
        <a href="/diaries/new" class="sth-text-link">写日记<AppIcon name="arrow" /></a>
        <button class="ui-button" data-variant="default" type="submit" :disabled="saving || !quickBody.trim()">
          <AppIcon name="pen" />{{ saving ? '正在保存…' : quickCall ? '核对并重试' : '记下来' }}
        </button>
      </div>
    </form>

    <section class="sth-recent" aria-labelledby="recent-manuscripts-title">
      <div class="sth-section-heading"><h2 id="recent-manuscripts-title">最近编辑</h2></div>
      <p v-if="manuscriptsLoading && !manuscripts.length" class="sth-list-state" role="status">正在读取最近编辑的文稿…</p>
      <div v-else-if="manuscriptsError" class="sth-list-state"><p class="sth-error" role="alert">{{ manuscriptsError }}</p><button type="button" class="ui-button" data-variant="outline" @click="refreshManuscripts">重新读取最近编辑</button></div>
      <ul v-else-if="manuscripts.length" class="sth-manuscript-list" role="list">
        <li v-for="manuscript in manuscripts.slice(0, 6)" :key="`${manuscript.kind}:${manuscript.id}`">
          <a :href="manuscript.href" class="sth-manuscript-link" :aria-label="`${opensEditor(manuscript) ? '继续编辑' : '打开'}${manuscriptKinds[manuscript.kind]} ${manuscript.title}`">
            <AppIcon :name="manuscript.kind === 'diary' ? 'diary' : 'pen'" />
            <div class="sth-manuscript-copy">
              <h3>{{ manuscript.title }}</h3>
              <p v-if="diaryExcerpt(manuscript)" class="sth-manuscript-excerpt">{{ diaryExcerpt(manuscript) }}</p>
              <p>{{ manuscriptKinds[manuscript.kind] }}<span v-if="manuscriptRevision(manuscript)"> · 第 {{ manuscriptRevision(manuscript) }} 版</span><span> · </span><time v-if="manuscript.updatedAt" :datetime="new Date(manuscript.updatedAt).toISOString()">{{ editedAt(manuscript.updatedAt) }}</time><span v-else>历史文稿</span></p>
            </div>
            <span class="sth-manuscript-continue">{{ opensEditor(manuscript) ? '接着写' : '打开' }}<AppIcon name="arrow" /></span>
          </a>
        </li>
      </ul>
      <p v-else class="sth-list-state">写下或打开的候选稿、场景和日记会留在这里。</p>
      <div v-if="manuscriptsIncomplete && !manuscriptsError" class="sth-list-state" role="status"><p>跨设备的近期记录暂时无法读取，当前显示本机记录。</p><button type="button" class="ui-button" data-variant="outline" :disabled="manuscriptsLoading" @click="refreshManuscripts">重新读取最近编辑</button></div>
    </section>

    <section class="sth-recent" aria-labelledby="continue-diaries-title">
      <div class="sth-section-heading"><h2 id="continue-diaries-title">日记接续</h2><a href="/diaries" class="sth-text-link">全部日记<AppIcon name="arrow" /></a></div>
      <p v-if="loading" class="sth-list-state" role="status">正在读取最近的日记…</p>
      <div v-else-if="recentError" class="sth-list-state"><p class="sth-error" role="alert">{{ recentError }}</p><button type="button" class="ui-button" data-variant="outline" @click="loadRecent">重新读取</button></div>
      <div v-else-if="!diaries.length" class="sth-list-state sth-empty"><p>日记本还是空的</p><p>从上面的一句话开始。</p></div>
      <ul v-else id="diary-list" class="sth-recent-list" role="list">
        <li v-for="diary in diaries" :key="diary.noteId" class="sth-recent-entry">
          <a :href="`/diaries/${encodeURIComponent(diary.noteId)}`" class="sth-entry-link">
            <div class="sth-entry-date"><time :datetime="diary.diaryDate">{{ diary.diaryDate.slice(5).replace('-', ' / ') }}</time><span>{{ diary.character?.name || '个人日记' }}</span></div>
            <div class="sth-entry-copy"><h3>{{ diary.title }}</h3><p>{{ excerpt(diary.body) }}</p></div>
          </a>
          <a class="sth-continue" :href="`/diaries/${encodeURIComponent(diary.noteId)}?edit=1`" :aria-label="`继续写 ${diary.title}`"><span>继续写</span><AppIcon name="arrow" /></a>
        </li>
      </ul>
    </section>

    <nav class="sth-domain-links" aria-label="创作入口">
      <a href="/create">继续创作<AppIcon name="arrow" /></a>
      <a href="/characters">整理角色<AppIcon name="arrow" /></a>
      <a href="/sources">查看资料<AppIcon name="arrow" /></a>
    </nav>
  </div>
</template>
