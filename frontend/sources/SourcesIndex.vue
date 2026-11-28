<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Button from '../ui/Button.vue';
import { ApiError, catalog, errorText, href, kinds, listAll, query, read } from './api';
import type { Project, SourceKind, Summary, Summary as SourceSummary } from './api';
import { manuscriptReturn } from '../manuscript/return-link';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const returnTo = manuscriptReturn(props.url);
function contextual(path: string) {
  if (!returnTo) return path;
  const destination = new URL(path, props.url);
  destination.searchParams.set('returnTo', returnTo);
  return destination.pathname + destination.search;
}
const controller = new AbortController();
const loading = ref(true);
const error = ref('');
const contextError = ref('');
const moreError = ref('');
const busy = ref(false);
const more = ref(false);
const items = ref<Summary[]>([]);
const excerpts = ref(new Map<string, string>());
const projects = ref<Project[]>([]);
const projectId = ref(props.url.searchParams.get('projectId') ?? '');
const kind = ref(props.url.searchParams.get('kind') ?? '');
const q = ref(props.url.searchParams.get('q') ?? '');
const searchTerm = props.url.searchParams.get('q')?.trim() ?? '';
const activeFilterCount = computed(() => Number(Boolean(projectId.value)) + Number(Boolean(q.value.trim())));
const filter = {
  ...(projectId.value ? { projectId: projectId.value } : {}),
  ...(Object.hasOwn(kinds, kind.value) ? { kind: kind.value } : {}),
  ...(searchTerm ? { query: searchTerm } : {}),
};
async function next() {
  busy.value = true;
  moreError.value = '';
  try {
    const page = await read<{ items: Summary[] }>(
      searchTerm ? 'source.search' : 'source.list',
      { ...filter, limit: 20, offset: items.value.length },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    items.value.push(...page.items);
    more.value = page.items.length === 20;
    void loadExcerpts(page.items);
  } catch (reason) {
    if (!controller.signal.aborted) moreError.value = errorText(reason);
  } finally {
    busy.value = false;
  }
}
async function loadExcerpts(records: SourceSummary[]) {
  await Promise.all(records.map(async (item) => {
    try {
      const input = { sourceId: item.sourceId, revision: item.revision, contextChars: 180 };
      let source: SourceSummary & { body: string };
      try {
        source = await read('source.read', { ...input, range: { start: 0, end: 2 } }, controller.signal);
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.code !== 'source_range_invalid') throw reason;
        source = await read('source.read', { ...input, range: { start: 0, end: 1 } }, controller.signal);
      }
      if (!controller.signal.aborted) excerpts.value.set(item.sourceId, source.body);
    } catch {
      // A source summary is optional in the list. Opening the original remains available.
    }
  }));
}
async function load() {
  loading.value = true;
  error.value = '';
  items.value = [];
  excerpts.value.clear();
  try {
    const operations = await catalog(controller.signal);
    const context = listAll<Project>(operations, 'project.list', {}, controller.signal)
      .then((result) => {
        projects.value = result;
        contextError.value = '';
      })
      .catch((reason) => {
        if (!controller.signal.aborted) contextError.value = errorText(reason);
      });
    await Promise.all([next(), context]);
    if (moreError.value) error.value = moreError.value;
  } catch (reason) {
    if (!controller.signal.aborted) error.value = errorText(reason);
  } finally {
    loading.value = false;
  }
}
function search() {
  emit('navigate', contextual(query('/sources', { projectId: projectId.value, kind: kind.value, q: q.value.trim() })));
}
function typeHref(value: string) {
  return contextual(query('/sources', { projectId: projectId.value, kind: value, q: q.value.trim() }));
}
onMounted(() => {
  document.title = '资料 · Sth';
  void load();
});
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <section class="sources-route" :aria-busy="loading" aria-label="资料">
    <header class="sources-heading">
      <a v-if="returnTo" class="sources-back" :href="returnTo">返回原稿</a>
      <h1 tabindex="-1">资料</h1>
      <Button
        as="a"
        variant="default"
        class="sources-button"
        :href="contextual(query('/sources/new', { projectId: url.searchParams.get('projectId') }))"
        >新建资料</Button
      >
    </header>
    <div class="sources-list-bar">
      <div class="sources-list-scope">
        <span class="sources-list-scope-label">{{ searchTerm ? `搜索「${searchTerm}」` : '已归档资料' }}</span>
        <span v-if="projectId">· {{ projects.find(item => item.projectId === projectId)?.title ?? '当前项目' }}</span>
        <span v-if="!loading && !error" id="workspace-count" class="sources-list-count" role="status">{{ items.length }} 条记录</span>
      </div>
      <div class="sources-list-tools">
        <details class="sources-disclosure sources-toolbar-menu sources-filter-disclosure">
          <summary>筛选<span v-if="activeFilterCount" class="sources-filter-count">{{ activeFilterCount }}</span></summary>
          <form class="sources-filter sources-toolbar-panel" role="search" action="/sources" @submit.prevent="search">
            <div class="sources-field ui-field">
              <label for="sources-project">项目</label>
              <select id="sources-project" class="ui-input" v-model="projectId" name="projectId">
                <option value="">全部项目</option>
                <option v-if="projectId && !projects.some(item => item.projectId === projectId)" :value="projectId">{{ projectId }}</option>
                <option v-for="project in projects" :key="project.projectId" :value="project.projectId">{{ project.title }}</option>
              </select>
            </div>
            <div class="sources-field sources-keyword ui-field">
              <label for="sources-q">关键词</label>
              <input id="sources-q" class="ui-input" v-model="q" name="q" type="search" maxlength="500" />
            </div>
            <Button class="sources-button" variant="outline" type="submit">搜索</Button>
          </form>
        </details>
        <details class="sources-disclosure sources-toolbar-menu sources-type-menu">
          <summary>类型<span v-if="kind && kinds[kind as SourceKind]" class="sources-type-current">{{ kinds[kind as SourceKind] }}</span></summary>
          <nav class="sources-type-options sources-toolbar-panel" aria-label="资料类型">
            <a :href="typeHref('')" :aria-current="!kind ? 'page' : undefined">全部类型</a>
            <a v-for="(label, value) in kinds" :key="value" :href="typeHref(value)" :aria-current="kind === value ? 'page' : undefined">{{ label }}</a>
          </nav>
        </details>
        <details class="sources-disclosure sources-toolbar-menu sources-workspace">
          <summary>工作区</summary>
          <nav class="sources-tabs sources-toolbar-panel" aria-label="资料工作区">
            <a :href="contextual('/sources')" aria-current="page">已归档资料</a>
            <a href="/research">外部检索</a>
            <a href="/judgments">判断</a>
          </nav>
        </details>
      </div>
    </div>
    <p v-if="contextError" role="alert">
      项目列表读取失败。{{ contextError }} <Button type="button" variant="outline" @click="load">重试</Button>
    </p>
    <p v-if="loading" role="status">正在读取资料…</p>
    <div v-else-if="error">
      <p role="alert">{{ error }}</p>
      <Button class="sources-button" variant="outline" type="button" @click="load">重试</Button>
    </div>
    <template v-else>
      <div id="workspace-list">
        <ul v-if="items.length" class="sources-list">
          <li v-for="item in items" :key="item.sourceId">
            <h2 class="sources-index-title">
              <a
                :href="
                  searchTerm
                    ? contextual(href(item.sourceId, item.revision, undefined, { q: searchTerm }))
                    : contextual(href(item.sourceId))
                "
                >{{ item.title }}</a
              >
            </h2>
            <p class="sources-muted sources-index-identity">{{ kinds[item.kind as SourceKind] }} · 第 {{ item.revision }} 版</p>
            <p v-if="excerpts.has(item.sourceId)" class="sources-index-excerpt">{{ excerpts.get(item.sourceId) }}</p>
            <details v-if="item.origin" class="sources-index-origin">
              <summary>出处</summary>
              <p>{{ item.origin }}</p>
            </details>
          </li>
        </ul>
        <p v-else class="sources-empty">
          {{ searchTerm ? '没有匹配的记录' : '还没有资料，可以新建资料或从外部检索归档。' }}
        </p>
      </div>
      <p v-if="moreError" role="alert">{{ moreError }}</p>
      <Button
        v-if="more"
        id="workspace-more"
        class="sources-button"
        variant="outline"
        type="button"
        :disabled="busy"
        @click="next"
      >
        {{ busy ? '正在读取…' : '加载更多' }}
      </Button>
    </template>
  </section>
</template>
