<script setup lang="ts">
import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import { all, href, message, pageOf, recordHref } from './api.ts';
import type { Project, Scene } from './api.ts';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const projects = shallowRef<Project[]>([]);
const scenes = shallowRef<Scene[]>([]);
const projectId = ref('');
const query = ref('');
const busy = ref(false);
const error = ref('');
const more = ref(false);
let controller: AbortController | undefined;

async function load(reset = false) {
  if (busy.value && !reset) return;
  if (reset) {
    controller?.abort();
    controller = new AbortController();
    projectId.value = props.url.searchParams.get('projectId') ?? '';
    query.value = props.url.searchParams.get('q') ?? '';
    scenes.value = [];
    more.value = false;
  }
  const signal = controller!.signal;
  const filters = {
    ...(props.url.searchParams.get('projectId') ? { projectId: props.url.searchParams.get('projectId') } : {}),
    ...(props.url.searchParams.get('q')?.trim() ? { title: props.url.searchParams.get('q')!.trim() } : {}),
  };
  busy.value = true;
  error.value = '';
  try {
    const [page, choices] = await Promise.all([
      pageOf<Scene>('scene.list', filters, signal, scenes.value.length),
      reset ? all<Project>('project.list', {}, signal) : Promise.resolve(projects.value),
    ]);
    if (signal.aborted) return;
    scenes.value = [...scenes.value, ...page.items];
    projects.value = choices;
    more.value = page.more;
  } catch (reason) { if (!signal.aborted) error.value = message(reason); }
  finally { if (!signal.aborted) busy.value = false; }
}
watch(() => props.url.href, () => { void load(true); }, { immediate: true });
onScopeDispose(() => controller?.abort());
</script>

<template>
  <section class="ce-shelf" aria-labelledby="ce-scene-list" :aria-busy="busy">
    <header class="ce-section-heading">
      <h2 id="ce-scene-list">场景</h2>
      <div class="ce-actions"><a href="/scenes/new">新建场景</a><a href="/generations/new">准备写作</a><a href="/branches">IF 分支</a></div>
    </header>
    <search>
      <form action="/create" method="get" class="ce-scene-filters" aria-label="筛选场景"
        @submit.prevent="emit('navigate', href('/create', { projectId, q: query.trim() }))">
        <div class="ce-field">
          <label for="ce-scene-project">作品</label>
          <select id="ce-scene-project" v-model="projectId" name="projectId">
            <option value="">全部作品</option>
            <option v-for="item in projects" :key="item.projectId" :value="item.projectId">{{ item.title }}</option>
          </select>
        </div>
        <div class="ce-field">
          <label for="ce-scene-query">完整场景名称</label>
          <input id="ce-scene-query" v-model="query" type="search" name="q" maxlength="300" enterkeyhint="search">
        </div>
        <button type="submit" class="ce-button">搜索场景</button>
      </form>
    </search>
    <p v-if="error" role="alert" class="ce-error">{{ error }} <button type="button" class="ce-button" @click="load(!scenes.length)">重新读取</button></p>
    <p v-if="busy && !scenes.length" role="status" class="ce-empty">正在读取场景…</p>
    <p v-else-if="!scenes.length && !error" class="ce-empty">没有匹配的场景，可以修改名称或作品筛选。</p>
    <ul v-if="scenes.length" class="ce-items">
      <li v-for="scene in scenes" :key="scene.sceneId">
        <h3><a :href="recordHref('scenes', scene.sceneId)">{{ scene.title }}</a></h3>
        <p class="ce-muted">{{ [`第 ${scene.revision} 版`, scene.time, scene.place].filter(Boolean).join(' · ') }}</p>
      </li>
    </ul>
    <button v-if="more" type="button" class="ce-button" :disabled="busy" @click="load()">{{ busy ? '正在读取…' : '加载更多场景' }}</button>
  </section>
</template>
