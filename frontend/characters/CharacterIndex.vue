<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { catalog, errorText, href, listAll, query } from './api';
import type { Character, Project } from './api';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const characters = shallowRef<Character[]>([]);
const projects = shallowRef<Project[]>([]);
const busy = ref(false);
const error = ref('');
const projectId = computed(() => props.url.searchParams.get('projectId') ?? '');
let controller: AbortController | undefined;
const projectName = (id?: string) => projects.value.find(project => project.projectId === id)?.title ?? (id ? '项目角色' : '独立角色');

async function load() {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  busy.value = true;
  error.value = '';
  characters.value = [];
  projects.value = [];
  document.title = '角色 · Sth';
  try {
    const operations = await catalog(signal);
    const [allProjects, records] = await Promise.all([
      listAll<Project>(operations, 'project.list', {}, signal),
      listAll<Character>(operations, 'character.list', projectId.value ? { projectId: projectId.value } : {}, signal),
    ]);
    if (signal.aborted) return;
    projects.value = allProjects;
    characters.value = records;
  } catch (reason) { if (!signal.aborted) error.value = errorText(reason); }
  finally { if (!signal.aborted) busy.value = false; }
}
watch(() => props.url.href, () => { void load(); }, { immediate: true });
onScopeDispose(() => controller?.abort());
</script>

<template>
  <section :aria-busy="busy" aria-label="角色列表">
    <header class="characters-heading"><h1 tabindex="-1">角色</h1>
      <a class="characters-button characters-primary" :href="query('/characters/new', { projectId })">新建角色</a>
    </header>
    <p v-if="busy" role="status" class="characters-state">正在读取角色…</p>
    <div v-else-if="error" class="characters-state"><p role="alert">{{ error }}</p><button class="characters-button" type="button" @click="load">重试</button></div>
    <template v-else>
      <div class="characters-list-bar"><p class="characters-muted">{{ characters.length }} 个角色</p>
        <div v-if="projects.length || projectId" class="characters-filter"><label for="characters-project">项目</label>
          <select id="characters-project" :value="projectId" @change="emit('navigate', query('/characters', { projectId: ($event.target as HTMLSelectElement).value }))">
            <option value="">全部项目</option>
            <option v-if="projectId && !projects.some(project => project.projectId === projectId)" :value="projectId">当前项目</option>
            <option v-for="project in projects" :key="project.projectId" :value="project.projectId">{{ project.title }}</option>
          </select>
        </div>
      </div>
      <ul v-if="characters.length" class="characters-list">
        <li v-for="character in characters" :key="character.characterId"><a :href="href(character.characterId)">
          <h2>{{ character.name }}</h2><p class="characters-muted">{{ projectName(character.projectId) }}</p>
          <p v-if="character.persona" class="characters-excerpt">{{ character.persona.slice(0, 160) }}</p>
        </a></li>
      </ul>
      <div v-else class="characters-state"><h2>还没有角色</h2><p>可以先写名字、设定，或添加图片与记录。</p></div>
    </template>
  </section>
</template>
