<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { catalog, errorText, listAll, read } from './api';
import type { Diary, Project } from './api';
import { dateLabel, indexHref, resourceHref, today } from './drafts';
import './diary.css';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const pageError = ref('');
const records = ref<Diary[]>([]);
const projects = ref<Project[]>([]);
const projectId = ref('');
const more = ref(false);
const chapters = ref(false);
let offset = 0;
let limit = 20;
let paged = false;
let controller: AbortController | undefined;
const groups = computed(() => {
  const months = new Map<string, Diary[]>();
  for (const diary of records.value.toSorted((left, right) => right.diaryDate.localeCompare(left.diaryDate))) {
    const month = diary.diaryDate.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month)!.push(diary);
  }
  return [...months].map(([key, diaries]) => ({ key, label: `${key.slice(0, 4)} 年 ${Number(key.slice(5))} 月`, diaries }));
});
const newHref = computed(() => projectId.value ? `/diaries/new?${new URLSearchParams({ projectId: projectId.value })}` : '/diaries/new');
const chaptersHref = computed(() => `/chapters?${new URLSearchParams({ projectId: projectId.value })}`);

function navigate(event: MouseEvent, href: string) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  emit('navigate', href);
}

async function loadMore(signal = controller?.signal) {
  if (!signal || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const filters = projectId.value ? { projectId: projectId.value } : {};
    const data = await read<{ items: Diary[] }>('diary.list', paged ? { ...filters, limit, offset } : filters, signal);
    if (signal.aborted) return;
    if (!Array.isArray(data.items)) throw new Error('invalid list');
    offset += data.items.length;
    records.value = [...new Map([...records.value, ...data.items].map(diary => [diary.noteId, diary])).values()];
    more.value = paged && data.items.length === limit;
  } catch (cause) {
    if (!signal.aborted) {
      if (loading.value) pageError.value = errorText(cause);
      else error.value = errorText(cause);
    }
  } finally {
    if (!signal.aborted) busy.value = false;
  }
}

async function load() {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  loading.value = true;
  busy.value = false;
  pageError.value = error.value = '';
  records.value = [];
  offset = 0;
  projectId.value = props.url.searchParams.get('projectId') ?? '';
  try {
    const operations = await catalog(signal);
    const allProjects = await listAll<Project>(operations, 'project.list', {}, signal);
    if (signal.aborted) return;
    projects.value = allProjects;
    const properties = operations.get('diary.list')?.inputSchema.properties;
    paged = Boolean(properties?.limit && properties.offset);
    limit = Math.min(properties?.limit?.maximum ?? 20, 20);
    chapters.value = operations.has('chapter.list');
    await loadMore(signal);
    if (!signal.aborted) document.title = 'Sth · 我的日记';
  } catch (cause) {
    if (!signal.aborted) pageError.value = errorText(cause);
  } finally {
    if (!signal.aborted) loading.value = false;
  }
}
watch(() => props.url.href, () => void load(), { immediate: true });
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section class="diary-route" aria-label="日记" :aria-busy="loading">
    <p v-if="loading" class="diary-loading" role="status">正在读取日记…</p>
    <div v-else-if="pageError" class="diary-error-page"><h1>页面暂时无法打开</h1><p role="alert">{{ pageError }}</p>
      <button type="button" class="diary-button diary-primary" @click="load">重试</button>
    </div>
    <template v-else>
      <header class="diary-heading"><div><h1 tabindex="-1">我的日记</h1><p class="diary-meta"><time :datetime="today()">{{ dateLabel(today()) }}</time></p></div>
        <div class="diary-actions">
          <a v-if="projectId && chapters" :href="chaptersHref" class="diary-button diary-secondary" @click="navigate($event, chaptersHref)">查看项目章节</a>
          <a :href="newHref" class="diary-button diary-primary" @click="navigate($event, newHref)">写日记</a>
        </div>
      </header>
      <div class="diary-list-bar"><p class="diary-muted" role="status">{{ more ? '已加载 ' : '' }}{{ records.length }} 篇日记</p>
        <div v-if="projects.length" class="diary-field"><label for="diary-project-filter">项目</label>
          <select id="diary-project-filter" :value="projectId" @change="emit('navigate', indexHref(($event.target as HTMLSelectElement).value))">
            <option value="">全部项目</option><option v-for="project in projects" :key="project.projectId" :value="project.projectId">{{ project.title }}</option>
          </select>
        </div>
      </div>
      <div v-if="!records.length" class="diary-empty"><p>{{ projectId ? '这个项目还没有日记' : '日记本还是空的' }}</p></div>
      <section v-for="group in groups" :key="group.key" class="diary-month"><h2>{{ group.label }}</h2>
        <ul><li v-for="diary in group.diaries" :key="diary.noteId"><a class="diary-row" :href="resourceHref('diaries', diary.noteId)" @click="navigate($event, resourceHref('diaries', diary.noteId))">
          <time :datetime="diary.diaryDate" :aria-label="dateLabel(diary.diaryDate)">{{ diary.diaryDate.slice(8) }}<small>日</small></time>
          <div><h3>{{ diary.title }}</h3><p class="diary-excerpt">{{ diary.body.trim().replace(/\s+/g, ' ').slice(0, 150) }}</p>
            <p class="diary-muted">{{ diary.character?.name ?? '个人日记' }}<span v-if="diary.projectId"> · {{ projects.find(project => project.projectId === diary.projectId)?.title ?? '项目日记' }}</span></p>
          </div>
        </a></li></ul>
      </section>
      <div v-if="more" class="diary-actions"><button type="button" class="diary-button diary-secondary" :disabled="busy" @click="loadMore()">{{ busy ? '正在读取…' : '加载更多' }}</button></div>
      <p v-if="error" class="diary-notice" role="alert">{{ error }}</p>
    </template>
  </section>
</template>
