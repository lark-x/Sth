<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import Button from '../ui/Button.vue';
import { all, href, message, read, recordHref } from './api.ts';
import type { Character, Diary, Project, Source, StartContext } from './api.ts';
import ContinueShelf from './ContinueShelf.vue';
import ProjectBook from './ProjectBook.vue';
import ProjectCreate from './ProjectCreate.vue';
import StartFrom from './StartFrom.vue';
import SceneIndex from './SceneIndex.vue';
import './creative-entry.css';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const projects = shallowRef<Project[]>([]);
const context = shallowRef<StartContext>();
const busy = ref(false);
const error = ref('');
const filter = ref('');
const filterDraft = ref('');
const wideScreen = ref(false);
let controller: AbortController | undefined;
let detachMedia: (() => void) | undefined;
onMounted(() => {
  const media = window.matchMedia('(min-width: 761px)');
  const update = () => { wideScreen.value = media.matches; };
  update();
  media.addEventListener('change', update);
  detachMedia = () => media.removeEventListener('change', update);
});
const tab = computed(() => props.url.searchParams.get('tab') ?? 'projects');
const isNew = computed(() => props.url.pathname.replace(/\/+$/, '') === '/projects/new');
const sceneList = computed(() => props.url.pathname.replace(/\/+$/, '') === '/create' && (props.url.searchParams.has('q') || props.url.searchParams.has('projectId')));
const continuing = computed(() => ['continue', 'characters', 'sources', 'diaries'].includes(tab.value) || props.url.searchParams.has('from'));
const shelfKind = computed(() => tab.value === 'sources' ? 'sources' : tab.value === 'diaries' ? 'diaries' : 'characters');
const requestedProject = computed(() => {
  const match = /^\/projects\/([^/]+)\/?$/.exec(props.url.pathname);
  if (match && match[1] !== 'new') {
    try { return decodeURIComponent(match[1]); } catch { return '\u0000'; }
  }
  return props.url.searchParams.get('projectId') ?? '';
});
const project = computed(() => projects.value.find(item => item.projectId === requestedProject.value) ?? (!requestedProject.value ? projects.value[0] : undefined));
const visibleProjects = computed(() => projects.value.filter(item => item.title.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())));
const title = computed(() => isNew.value ? '新建作品' : sceneList.value ? '创作' : continuing.value ? '从已有内容继续' : '作品');
const tools = [
  ['/scenes', '全部场景'], ['/chapters', '章节'], ['/branches', 'IF 分支'], ['/events', '事件'],
  ['/templates', '内容模板'], ['/writing-requirements', '写作要求'], ['/generation-plans', '生成方案'],
  ['/generations/new', '准备写作'],
];

function linkClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
  if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
  const target = new URL(anchor.href, props.url);
  if (target.origin !== props.url.origin || !['http:', 'https:'].includes(target.protocol)) return;
  event.preventDefault();
  emit('navigate', `${target.pathname}${target.search}${target.hash}`);
}

async function load() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  context.value = undefined;
  projects.value = [];
  error.value = '';
  busy.value = true;
  filter.value = '';
  filterDraft.value = '';
  try {
    if (sceneList.value) return;
    if (!continuing.value) {
      const result = await all<Project>('project.list', {}, signal);
      if (signal.aborted) return;
      projects.value = result;
      if (requestedProject.value && !result.some(item => item.projectId === requestedProject.value)) {
        error.value = '找不到这部作品，请从作品列表重新选择。';
      }
    }
    const from = props.url.searchParams.get('from');
    if (!from) return;
    if (!['character', 'source', 'diary'].includes(from)) throw new Error('invalid context');
    const revisionText = props.url.searchParams.get('revision');
    if (!revisionText || !/^[1-9]\d*$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText))) {
      error.value = '所选版本无效，请从已有内容重新选择。';
      return;
    }
    const revision = Number(revisionText);
    const key = `${from === 'diary' ? 'note' : from}Id`;
    const id = props.url.searchParams.get(key);
    if (!id) { error.value = '缺少内容编号，请从已有内容重新选择。'; return; }
    if (from === 'character') {
      const record = await read<Character>('character.read', { characterId: id, revision }, signal);
      if (!signal.aborted) context.value = { kind: 'character', record };
    } else if (from === 'source') {
      const record = await read<Source>('source.read', { sourceId: id, revision }, signal);
      if (signal.aborted) return;
      const start = props.url.searchParams.get('start');
      const end = props.url.searchParams.get('end');
      let range: { start: number; end: number } | undefined;
      if (start !== null || end !== null) {
        if (!/^\d+$/.test(start ?? '') || !/^\d+$/.test(end ?? '') || !Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(end)) || Number(end) <= Number(start) || Number(end) > record.body.length || Number(end) - Number(start) > 4000 || !record.body.slice(Number(start), Number(end)).trim()) {
          error.value = '引用位置无效，请重新选择原文。';
          return;
        }
        range = { start: Number(start), end: Number(end) };
      }
      context.value = { kind: 'source', record, range };
    } else {
      const record = await read<Diary>('diary.read', { noteId: id, revision }, signal);
      if (!signal.aborted) context.value = { kind: 'diary', record };
    }
  } catch (reason) { if (!signal.aborted) error.value = message(reason); }
  finally { if (!signal.aborted) busy.value = false; }
}

function created(result: Project) {
  projects.value = [...projects.value, result];
  emit('navigate', recordHref('projects', result.projectId));
}
watch(() => props.url.href, () => { void load(); }, { immediate: true });
onScopeDispose(() => { controller?.abort(); detachMedia?.(); });
</script>

<template>
  <div class="creative-entry" @click="linkClick">
    <header class="ce-heading">
      <h1 tabindex="-1">{{ title }}</h1>
      <Button v-if="!isNew" as="a" class="ce-button" href="/projects/new">新建作品</Button>
      <Button v-else as="a" class="ce-button" variant="outline" href="/projects">返回作品</Button>
    </header>
    <nav class="ce-tabs" aria-label="创作入口">
      <a href="/projects" :aria-current="!continuing && !isNew && !sceneList ? 'page' : undefined">作品</a>
      <a href="/workspace?tab=continue" :aria-current="continuing ? 'page' : undefined">从已有内容继续</a>
      <a href="/scenes" :aria-current="sceneList ? 'page' : undefined">场景</a>
    </nav>
    <p v-if="busy" role="status" class="ce-empty">正在读取{{ continuing ? '已有内容' : '作品' }}…</p>
    <p v-if="error" role="alert" class="ce-error">{{ error }} <Button class="ce-button" variant="outline" @click="load">重新读取</Button></p>
    <SceneIndex v-if="sceneList" :url="url" @navigate="emit('navigate', $event)" />
    <ProjectCreate v-else-if="isNew" @created="created" />
    <template v-else-if="continuing">
      <nav class="ce-tabs ce-material-tabs" aria-label="选择已有内容">
        <a v-for="[key, label] in [['characters', '角色'], ['sources', '资料'], ['diaries', '日记']]" :key="key"
          :href="href('/workspace', { tab: key, projectId: props.url.searchParams.get('projectId') ?? undefined })"
          :aria-current="shelfKind === key && !context ? 'page' : undefined">{{ label }}</a>
      </nav>
      <StartFrom v-if="context" :key="props.url.href" :context="context" @navigate="emit('navigate', $event)" />
      <ContinueShelf v-else-if="!busy && !props.url.searchParams.has('from')" :kind="shelfKind" :project-id="props.url.searchParams.get('projectId') ?? undefined" />
      <p v-else-if="!busy && !context" class="ce-empty"><a href="/workspace?tab=continue">返回已有内容</a></p>
    </template>
    <div v-else-if="!busy && projects.length" class="ce-project-layout">
      <aside class="ce-project-list" aria-label="选择作品">
        <details :open="wideScreen || !requestedProject">
          <summary>{{ project?.title ?? '选择作品' }} · 切换作品</summary>
          <search>
            <form action="/projects" method="get" aria-label="查找作品" @submit.prevent="filter = filterDraft.trim()">
              <label class="ui-label" for="ce-project-search">查找作品</label>
              <div class="ce-search-line">
                <input id="ce-project-search" v-model="filterDraft" class="ui-input" name="q" type="search" enterkeyhint="search" maxlength="300">
                <Button type="submit" class="ce-button" variant="outline">查找</Button>
              </div>
            </form>
          </search>
          <ul class="ce-project-links">
            <li v-for="item in visibleProjects" :key="item.projectId">
              <a :href="recordHref('projects', item.projectId)" :aria-current="item.projectId === project?.projectId ? 'page' : undefined">{{ item.title }}</a>
            </li>
          </ul>
          <p v-if="!visibleProjects.length" class="ce-muted">没有匹配的作品，可以换个名称查找。</p>
        </details>
      </aside>
      <ProjectBook v-if="project" :project="project" />
    </div>
    <section v-else-if="!busy && !error" class="ce-empty">
      <h2>开始你的第一部作品</h2>
      <p>先起一个名字，或从已存角色、资料、日记继续。</p>
      <div class="ce-actions"><Button as="a" class="ce-button" href="/projects/new">新建作品</Button><a href="/workspace?tab=continue">从已有内容继续</a></div>
    </section>
    <details class="ce-tools">
      <summary>更多创作工具</summary>
      <nav aria-label="创作工具"><a v-for="[path, label] in tools" :key="path" :href="path">{{ label }}</a></nav>
    </details>
  </div>
</template>
