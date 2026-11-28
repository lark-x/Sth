<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import AppIcon from '../AppIcon.vue';
import Button from '../ui/Button.vue';
import AttemptDetails from './AttemptDetails.vue';
import JobAction from './JobAction.vue';
import { ApiError, catalog, display, mediaProvider, read, taskLinks, workspaceError } from './legacy.js';
import type { Catalog } from './legacy.js';
import { dateText, downloadName, jobRecord, loadTaskList, mediaRecord, pageHref, sceneHref } from './model.ts';
import type { Job, Media, TaskList } from './model.ts';
import { resolveTasksRoute } from './routes.ts';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const root = ref<HTMLElement>();
const route = computed(() => resolveTasksRoute(props.url));
const operations = shallowRef<Catalog>(new Map());
const list = shallowRef<TaskList>();
const job = shallowRef<Job>();
const media = shallowRef<Media>();
const provider = ref('');
const loading = ref(true);
const error = ref('');
const imageFailed = ref(false);
const imageVersion = ref(0);
const kindNames: Record<string, string> = { writing: '文字', batch: '文字批量', media: '媒体', research: '资料' };
const title = computed(() => job.value?.title ?? media.value?.title ?? (route.value?.kind === 'media' ? '媒体' : route.value?.kind === 'job' ? '任务详情' : '任务'));
const total = computed(() => Object.values(job.value?.progress ?? {}).reduce((sum, count) => sum + count, 0));
const settled = computed(() => (job.value?.progress.succeeded ?? 0) + (job.value?.progress.failed ?? 0) + (job.value?.progress.canceled ?? 0));
const counts = computed(() => Object.entries(job.value?.progress ?? {}).filter(([, count]) => count > 0));
const listHref = computed(() => {
  const path = props.url.pathname.startsWith('/tasks') ? '/tasks' : '/jobs';
  const params = new URLSearchParams();
  const projectId = props.url.searchParams.get('projectId');
  if (projectId) params.set('projectId', projectId);
  return path + (params.size ? `?${params}` : '');
});
const newHref = computed(() => `/jobs/new${props.url.searchParams.has('projectId') ? `?${new URLSearchParams({ projectId: props.url.searchParams.get('projectId')! })}` : ''}`);
let controller: AbortController | undefined;

function providerText(status: { status: string; provider?: string } | null): string {
  const state = ({ ready: '可用', unconfigured: '未配置', invalid_config: '配置无效', unreachable: '无法连接' } as Record<string, string>)[status?.status ?? ''];
  return state ? `图片供应商 · ${state}${status?.provider ? ` · ${status.provider}` : ''}` : '';
}

async function load() {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  const target = route.value;
  const url = new URL(props.url.href);
  loading.value = true;
  error.value = '';
  job.value = undefined;
  media.value = undefined;
  list.value = undefined;
  provider.value = '';
  imageFailed.value = false;
  try {
    const available = await catalog();
    current.signal.throwIfAborted();
    operations.value = available;
    if (!target) throw new ApiError(404, '', '找不到这条记录。');
    if (target.kind === 'list') {
      const [records, status] = await Promise.all([
        loadTaskList(available, url, current.signal), mediaProvider(current.signal).catch(() => null),
      ]);
      current.signal.throwIfAborted();
      list.value = records;
      provider.value = providerText(status);
    } else {
      const op = target.kind === 'job' ? 'jobs.read' : 'media.read';
      if (!available.has(op)) throw new ApiError(404, '', '此功能暂不可用。');
      const [record, status] = await Promise.all([
        read(op, { [target.kind === 'job' ? 'jobId' : 'mediaId']: target.id }, current.signal),
        target.kind === 'job' ? mediaProvider(current.signal).catch(() => null) : null,
      ]);
      current.signal.throwIfAborted();
      if (target.kind === 'job') job.value = jobRecord(record, target.id);
      else media.value = mediaRecord(record, target.id);
      provider.value = providerText(status);
    }
  } catch (failure) {
    if (current.signal.aborted) return;
    error.value = workspaceError(failure);
  } finally {
    if (!current.signal.aborted) {
      loading.value = false;
      document.title = `${title.value} · Sth`;
    }
  }
}
watch(() => props.url.href, load, { immediate: true });
onBeforeUnmount(() => controller?.abort());

function filter(event: Event) {
  const params = new URLSearchParams(props.url.search);
  params.delete('offset');
  for (const [key, value] of new FormData(event.currentTarget as HTMLFormElement)) {
    if (String(value).trim()) params.set(key, String(value).trim());
    else params.delete(key);
  }
  emit('navigate', props.url.pathname + (params.size ? `?${params}` : '') + props.url.hash);
}
function saved() {
  root.value?.dispatchEvent(new CustomEvent('sth:announce', { detail: '操作已保存', bubbles: true }));
  emit('refresh');
}
function tabHref(href: string) {
  const params = new URLSearchParams();
  const project = props.url.searchParams.get('projectId');
  if (project && !['/generations', '/generation-batches'].includes(href)) params.set('projectId', project);
  return href + (params.size ? `?${params}` : '');
}
</script>

<template>
  <div ref="root" class="tasks-domain">
    <a v-if="route?.kind !== 'list'" class="back" :href="route?.kind === 'media' ? '/media' : listHref"><AppIcon name="back" />{{ route?.kind === 'media' ? '媒体' : '任务' }}</a>
    <header class="masthead">
      <div class="heading-copy"><h1 tabindex="-1">{{ title }}</h1><p v-if="provider" class="masthead-meta">{{ provider }}</p></div>
      <div class="actions">
        <Button v-if="route?.kind === 'list' && operations.has('jobs.create')" as="a" :href="newHref"><AppIcon name="plus" />新建任务</Button>
        <Button variant="outline" :disabled="loading" @click="emit('refresh')"><AppIcon name="refresh" />刷新状态</Button>
      </div>
    </header>
    <nav class="workspace-nav" aria-label="任务视图">
      <a v-for="[href, text] in taskLinks" :key="href" :href="tabHref(href)" :aria-current="(href === '/jobs' && route?.kind !== 'media') || (href === '/media' && route?.kind === 'media') ? 'page' : undefined">{{ text }}</a>
    </nav>
    <p v-if="loading" class="list-state" role="status">正在读取…</p>
    <div v-else-if="error" class="list-state"><p class="notice" role="alert">{{ error }}</p><Button variant="outline" @click="load">重试</Button></div>
    <template v-else-if="list">
      <search v-if="list.filters.length">
        <form method="get" :action="url.pathname" aria-label="筛选任务" class="task-filter" @submit.prevent="filter">
          <div v-for="field in list.filters" :key="field.key" class="field">
            <label :for="`task-filter-${field.key}`">{{ field.label }}</label>
            <select v-if="field.choices" :id="`task-filter-${field.key}`" :name="field.key" :value="field.value"><option value="">全部</option><option v-for="[value, text] in field.choices" :key="value" :value="value">{{ text }}</option></select>
            <input v-else :id="`task-filter-${field.key}`" type="search" :name="field.key" :value="field.value" :maxlength="field.maxLength">
          </div>
          <Button type="submit" variant="outline">{{ list.filters.some(field => field.key === 'q') ? '搜索' : '筛选' }}</Button>
        </form>
      </search>
      <ul v-if="list.items.length" class="rows" role="list">
        <li v-for="item in list.items" :key="`${item.kind}:${item.id}`" class="task-row">
          <div><h2><a :href="item.href">{{ item.title }}</a></h2><p class="row-meta">{{ kindNames[item.kind] ?? item.kind }} · {{ display(item.status) }} · <time :datetime="item.createdAt">{{ dateText(item.createdAt) }}</time></p></div>
        </li>
      </ul>
      <p v-else class="list-state">暂无任务</p>
      <nav v-if="list.offset || list.nextOffset" class="actions load-more" aria-label="任务分页">
        <Button v-if="list.offset" as="a" variant="outline" :href="pageHref(url, Math.max(0, list.offset - 20))"><AppIcon name="back" />上一页</Button>
        <Button v-if="list.nextOffset" as="a" variant="outline" :href="pageHref(url, list.nextOffset)">下一页<AppIcon name="next" /></Button>
      </nav>
    </template>
    <template v-else-if="job">
      <dl class="media-facts"><div><dt>执行模式</dt><dd>{{ display(job.mode) }}</dd></div><div><dt>创建时间</dt><dd><time :datetime="job.createdAt">{{ dateText(job.createdAt) }}</time></dd></div></dl>
      <section class="task-section" aria-labelledby="task-progress-title">
        <h2 id="task-progress-title">进度</h2>
        <p class="row-meta">{{ settled }} / {{ total }} 项已结束</p><progress :max="Math.max(total, 1)" :value="settled" aria-label="已结束任务项"></progress>
        <dl class="task-counts"><div v-for="[state, count] in counts" :key="state"><dt>{{ display(state) }}</dt><dd>{{ count }}</dd></div></dl>
        <div class="actions job-actions">
          <JobAction v-if="job.progress.failed && operations.has('jobs.retry')" :operations="operations" :route-key="url.href" action-key="job-retry" operation="jobs.retry" :input="{ jobId: job.jobId }" label="重试失败项" @saved="saved" />
          <JobAction v-if="job.progress.unknown && operations.has('jobs.reconcile')" :operations="operations" :route-key="url.href" action-key="job-reconcile" operation="jobs.reconcile" :input="{ jobId: job.jobId }" label="核对待确认项" @saved="saved" />
          <details v-if="job.progress.queued && operations.has('jobs.cancel')"><summary>取消待执行项</summary><JobAction :operations="operations" :route-key="url.href" action-key="job-cancel" operation="jobs.cancel" :input="{ jobId: job.jobId }" label="取消待执行项" confirm @saved="saved" /></details>
        </div>
      </section>
      <section class="task-section" aria-labelledby="task-items-title">
        <h2 id="task-items-title">任务明细</h2>
        <ol class="task-items">
          <li v-for="item in job.items" :key="item.itemId">
            <h3>{{ item.title }} <span class="row-meta">· {{ display(item.status) }}</span></h3>
            <div class="actions provenance"><a :href="sceneHref(item.scene)">查看场景 · 第 {{ item.scene.revision }} 版</a><a :href="`/compositions/${item.compositionId}`">查看构图</a><a v-if="item.mediaId" :href="`/media/${item.mediaId}`">查看生成图片</a></div>
            <details v-if="item.attempt"><summary>第 {{ item.attempt.number }} 次 · {{ item.attempt.provider }}</summary><AttemptDetails :attempt="item.attempt" /></details>
            <p v-if="item.reconciliationQueued" class="row-meta">已安排核对</p>
            <JobAction v-if="item.status === 'failed' && operations.has('jobs.retry')" :operations="operations" :route-key="url.href" :action-key="`item-retry-${item.itemId}`" operation="jobs.retry" :input="{ jobId: job.jobId, itemIds: [item.itemId] }" :label="`重试 ${item.title}`" @saved="saved" />
            <JobAction v-if="item.status === 'unknown' && !item.reconciliationQueued && operations.has('jobs.reconcile')" :operations="operations" :route-key="url.href" :action-key="`item-check-${item.itemId}`" operation="jobs.reconcile" :input="{ jobId: job.jobId, itemIds: [item.itemId] }" :label="`核对 ${item.title}`" @saved="saved" />
          </li>
        </ol>
      </section>
    </template>
    <template v-else-if="media">
      <figure class="task-media">
        <img v-if="!imageFailed" :key="imageVersion" :src="media.contentHref" :width="media.width" :height="media.height" :alt="media.title" @error="imageFailed = true">
        <div v-else class="list-state"><p role="status">图片预览暂时无法加载。</p><Button variant="outline" @click="imageFailed = false; imageVersion++">重试预览</Button></div>
        <figcaption class="actions"><a :href="media.contentHref" target="_blank" rel="noopener">打开媒体文件</a><a :href="media.contentHref" :download="downloadName(media)">下载媒体文件</a></figcaption>
      </figure>
      <dl class="media-facts"><div><dt>文件类型</dt><dd>{{ media.contentType }}</dd></div><div><dt>宽度</dt><dd>{{ media.width }}</dd></div><div><dt>高度</dt><dd>{{ media.height }}</dd></div><div><dt>文件字节数</dt><dd>{{ media.byteLength }}</dd></div><div><dt>创建时间</dt><dd><time :datetime="media.createdAt">{{ dateText(media.createdAt) }}</time></dd></div></dl>
      <section class="task-section" aria-labelledby="media-source-title"><h2 id="media-source-title">来源</h2><div class="actions provenance"><a :href="sceneHref(media.scene)">查看场景 · 第 {{ media.scene.revision }} 版</a><a :href="`/compositions/${media.compositionId}`">查看构图</a><a :href="`/jobs/${media.jobId}`">查看任务</a></div></section>
      <section class="task-section" aria-labelledby="media-parameters-title"><h2 id="media-parameters-title">生成参数</h2><AttemptDetails :attempt="media.attempt" /></section>
    </template>
  </div>
</template>

<style scoped>
.tasks-domain { min-inline-size: 0; overflow-wrap: anywhere; color: var(--ink); }
.tasks-domain h1 { font: 600 var(--page-title-size, 1.5rem)/var(--page-title-leading, 1.4) var(--sans); text-wrap: balance; }
.heading-copy { min-inline-size: 0; }
.provenance a, figcaption a, summary { min-block-size: 2.75rem; }
.tasks-domain .workspace-nav { flex-wrap: wrap; margin-block: .65rem 1.25rem; }
.task-row { display: block; padding: .85rem .65rem; border-block-end: 1px solid var(--line); transition: background-color var(--motion-fast, 120ms); }
.task-row:hover { background: var(--surface-subtle, var(--sidebar)); }
.task-row h2 { font-size: 1.06rem; font-family: var(--sans); line-height: 1.55; font-weight: 600; }
.task-row h2 a { display: inline-flex; align-items: center; min-block-size: 2.75rem; padding-block: .25rem; }
.row-meta { margin-block-start: .35rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.list-state { padding-block: 1.5rem; color: var(--muted); }
.list-state :deep(.ui-button) { margin-block-start: .75rem; }
.task-filter { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); align-items: end; gap: .85rem 1rem; padding-block: .5rem 1.25rem; }
.task-filter .field { min-inline-size: 0; margin: 0; }
.task-filter .ui-button { justify-self: start; }
.task-section { margin-block-start: 1.75rem; padding-block-start: 1.15rem; border-block-start: 1px solid var(--line); }
.task-section h2 { margin-block-end: .75rem; font: 650 1.15rem/1.55 var(--sans); }
.task-section > .row-meta { margin-block-start: 0; }
progress { display: block; inline-size: min(100%, 32rem); block-size: .65rem; margin-block: .85rem; accent-color: var(--ink); }
.task-counts { display: flex; flex-wrap: wrap; gap: .6rem 1.35rem; margin-block: .85rem 1rem; }
.task-counts > div { display: flex; gap: .5rem; }
dt { color: var(--muted); }
dd { margin: 0; font-variant-numeric: tabular-nums; }
.job-actions { align-items: start; }
summary { cursor: pointer; min-block-size: 2.75rem; padding-block: .6rem; }
.task-items { padding-inline-start: 1.5rem; }
.task-items > li { padding-block: .95rem 1.25rem; border-block-end: 1px solid var(--line); }
.task-items h3 { font: 600 1rem/1.55 var(--sans); }
.task-items details { margin-block: .45rem; }
.provenance { column-gap: 1.25rem; }
.provenance a, figcaption a { display: inline-flex; align-items: center; text-underline-offset: .25em; }
.task-media { margin: 1.25rem 0 1.5rem; }
.task-media img { display: block; max-inline-size: 100%; block-size: auto; object-fit: contain; }
.task-media figcaption { margin-block-start: .75rem; gap: .5rem 1.25rem; }
.media-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr)); gap: .85rem 1.25rem; margin-block: .5rem 1.25rem; }
.media-facts > div { min-inline-size: 0; }
.media-facts dt { margin-block-end: .2rem; font-size: .8125rem; }
.media-facts dd { overflow-wrap: anywhere; }
@media (width <= 36rem) {
  .masthead { align-items: start; }
  .masthead > .actions { inline-size: 100%; }
  .task-items { padding-inline-start: 1.25rem; }
  .task-filter { grid-template-columns: minmax(0, 1fr); }
  .task-filter .ui-button { justify-self: stretch; }
}
</style>
