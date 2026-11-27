<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { ApiError, errorText, invoke, localDate, operation } from './api.ts';
import type { DiarySummary } from './api.ts';
import type { RouteEvents } from './routes.ts';
import { quickBody, quickCall } from './quick-note.ts';

const emit = defineEmits<RouteEvents>();
const diaries = ref<DiarySummary[]>([]);
const loading = ref(true);
const recentError = ref('');
const saveError = ref('');
const saving = ref(false);
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

onMounted(() => { document.title = '首页 · Sth'; void loadRecent(); });
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <div class="sth-home">
    <header class="sth-home-header">
      <h1 tabindex="-1">记一句</h1>
      <time :datetime="today">{{ dateLabel }}</time>
    </header>

    <form class="sth-capture" @submit.prevent="save">
      <label for="quick-note">此刻想记下什么</label>
      <textarea id="quick-note" v-model="quickBody" name="body" rows="4" maxlength="100000" required :readonly="saving || Boolean(quickCall)" placeholder="一个念头，或者今天发生的小事。" :aria-describedby="saveError ? 'quick-note-error' : undefined" />
      <p v-if="saveError" id="quick-note-error" class="sth-error" role="alert">{{ saveError }}</p>
      <p v-else-if="quickCall && !saving" class="sth-error">上一次保存需要确认，内容已保留。请核对并重试。</p>
      <div class="sth-capture-footer">
        <a href="/diaries/new" class="sth-text-link">写日记<AppIcon name="arrow" /></a>
        <button class="button primary" type="submit" :disabled="saving || !quickBody.trim()">
          <AppIcon name="pen" />{{ saving ? '正在保存…' : quickCall ? '核对并重试' : '记下来' }}
        </button>
      </div>
    </form>

    <section class="sth-recent">
      <div class="sth-section-heading"><h2>接着写</h2><a href="/diaries" class="sth-text-link">全部日记<AppIcon name="arrow" /></a></div>
      <p v-if="loading" class="sth-list-state" role="status">正在读取最近的日记…</p>
      <div v-else-if="recentError" class="sth-list-state"><p class="sth-error" role="alert">{{ recentError }}</p><button type="button" class="button secondary" @click="loadRecent">重新读取</button></div>
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
