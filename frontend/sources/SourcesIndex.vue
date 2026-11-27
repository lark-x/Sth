<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { catalog, errorText, href, kinds, listAll, query, read } from './api';
import type { Project, SourceKind, Summary } from './api';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const controller = new AbortController();
const loading = ref(true);
const error = ref('');
const contextError = ref('');
const moreError = ref('');
const busy = ref(false);
const more = ref(false);
const items = ref<Summary[]>([]);
const projects = ref<Project[]>([]);
const projectId = ref(props.url.searchParams.get('projectId') ?? '');
const kind = ref(props.url.searchParams.get('kind') ?? '');
const q = ref(props.url.searchParams.get('q') ?? '');
const searchTerm = props.url.searchParams.get('q')?.trim() ?? '';
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
  } catch (reason) {
    if (!controller.signal.aborted) moreError.value = errorText(reason);
  } finally {
    busy.value = false;
  }
}
async function load() {
  loading.value = true;
  error.value = '';
  items.value = [];
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
  emit('navigate', query('/sources', { projectId: projectId.value, kind: kind.value, q: q.value.trim() }));
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
      <h1 tabindex="-1">资料</h1>
      <a
        class="sources-button sources-primary"
        :href="query('/sources/new', { projectId: url.searchParams.get('projectId') })"
        >新建资料</a
      >
    </header>
    <nav class="sources-tabs" aria-label="资料工作区">
      <a href="/sources" aria-current="page">已归档资料</a><a href="/research">外部检索</a
      ><a href="/judgments">判断</a>
    </nav>
    <form class="sources-filter" role="search" action="/sources" @submit.prevent="search">
      <div class="sources-field">
        <label for="sources-project">项目</label
        ><select id="sources-project" v-model="projectId" name="projectId">
          <option value="">全部项目</option>
          <option
            v-if="projectId && !projects.some((item) => item.projectId === projectId)"
            :value="projectId"
          >
            {{ projectId }}
          </option>
          <option v-for="project in projects" :key="project.projectId" :value="project.projectId">
            {{ project.title }}
          </option>
        </select>
      </div>
      <div class="sources-field">
        <label for="sources-kind">类型</label
        ><select id="sources-kind" v-model="kind" name="kind">
          <option value="">全部类型</option>
          <option v-for="(label, value) in kinds" :key="value" :value="value">{{ label }}</option>
        </select>
      </div>
      <div class="sources-field sources-keyword">
        <label for="sources-q">关键词</label
        ><input id="sources-q" v-model="q" name="q" type="search" maxlength="500" />
      </div>
      <button class="sources-button" type="submit">搜索</button>
    </form>
    <p v-if="contextError" role="alert">
      项目列表读取失败。{{ contextError }} <button type="button" @click="load">重试</button>
    </p>
    <p v-if="loading" role="status">正在读取资料…</p>
    <div v-else-if="error">
      <p role="alert">{{ error }}</p>
      <button class="sources-button" type="button" @click="load">重试</button>
    </div>
    <template v-else>
      <p id="workspace-count" class="sources-muted" role="status">{{ items.length }} 条记录</p>
      <div id="workspace-list">
        <ul v-if="items.length" class="sources-list">
          <li v-for="item in items" :key="item.sourceId">
            <h2>
              <a
                :href="
                  searchTerm
                    ? href(item.sourceId, item.revision, undefined, { q: searchTerm })
                    : href(item.sourceId)
                "
                >{{ item.title }}</a
              >
            </h2>
            <p class="sources-muted">{{ kinds[item.kind as SourceKind] }} · 第 {{ item.revision }} 版</p>
            <p v-if="item.origin" class="sources-origin">{{ item.origin }}</p>
          </li>
        </ul>
        <p v-else class="sources-empty">
          {{ searchTerm ? '没有匹配的记录' : '还没有资料，可以新建资料或从外部检索归档。' }}
        </p>
      </div>
      <p v-if="moreError" role="alert">{{ moreError }}</p>
      <button
        v-if="more"
        id="workspace-more"
        class="sources-button"
        type="button"
        :disabled="busy"
        @click="next"
      >
        {{ busy ? '正在读取…' : '加载更多' }}
      </button>
    </template>
  </section>
</template>
