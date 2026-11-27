<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import CharacterEntries from './CharacterEntries.vue';
import CharacterEditor from './CharacterEditor.vue';
import { ApiError, catalog, errorText, href, listAll, query, readCharacter } from './api';
import type { Character, Operation, Project } from './api';

const props = defineProps<{ url: URL; characterId?: string }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const record = shallowRef<Character>();
const projects = shallowRef<Project[]>([]);
const operations = shallowRef<Map<string, Operation>>(new Map());
const latestRevision = ref(0);
const busy = ref(false);
const error = ref('');
const historyError = ref('');
const projectError = ref('');
const requested = computed(() => props.url.searchParams.get('revision'));
const pinned = computed(() => Boolean(props.characterId && requested.value !== null));
const editing = computed(() => !props.characterId || !pinned.value && props.url.searchParams.get('edit') === '1');
const title = computed(() => editing.value ? props.characterId ? '编辑角色' : '新建角色' : record.value?.name ?? '角色');
const projectId = computed(() => record.value?.projectId ?? (projects.value.some(project => project.projectId === props.url.searchParams.get('projectId')) ? props.url.searchParams.get('projectId') ?? '' : ''));
const projectName = computed(() => projects.value.find(project => project.projectId === record.value?.projectId)?.title ?? (record.value?.projectId ? '项目角色' : '独立角色'));
const cancel = computed(() => props.characterId ? href(props.characterId) : query('/characters', { projectId: projectId.value }));
const versions = computed(() => Array.from({ length: latestRevision.value }, (_, index) => latestRevision.value - index));
let controller: AbortController | undefined;

async function load() {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  busy.value = true;
  error.value = '';
  historyError.value = '';
  projectError.value = '';
  record.value = undefined;
  latestRevision.value = 0;
  projects.value = [];
  try {
    if (props.characterId && requested.value !== null && (!/^[1-9]\d*$/.test(requested.value) || !Number.isSafeInteger(Number(requested.value)))) {
      throw new ApiError(400, 'invalid_revision');
    }
    const available = await catalog(signal);
    const [character, allProjects] = await Promise.all([
      props.characterId ? readCharacter(props.characterId, signal, pinned.value ? Number(requested.value) : undefined) : undefined,
      listAll<Project>(available, 'project.list', {}, signal).catch(reason => {
        if (!props.characterId) throw reason;
        if (!signal.aborted) projectError.value = '项目名称暂时无法读取。';
        return [];
      }),
    ]);
    if (signal.aborted) return;
    operations.value = available;
    record.value = character;
    projects.value = allProjects;
    latestRevision.value = character?.revision ?? 0;
    if (pinned.value && character && available.get('character.read')?.inputSchema.properties?.revision) {
      try { latestRevision.value = (await readCharacter(character.characterId, signal)).revision; }
      catch { if (!signal.aborted) historyError.value = '当前版本暂时无法读取，可以重新读取版本历史。'; }
    }
    if (!signal.aborted) document.title = `${title.value} · Sth`;
  } catch (reason) {
    if (!signal.aborted) { error.value = errorText(reason); document.title = '页面暂时无法打开 · Sth'; }
  } finally { if (!signal.aborted) busy.value = false; }
}
watch(() => props.url.href, () => { void load(); }, { immediate: true });
onScopeDispose(() => controller?.abort());
</script>

<template>
  <section :aria-busy="busy" aria-label="角色详情">
    <p v-if="busy" role="status" class="characters-state">正在读取角色…</p>
    <div v-else-if="error" class="characters-state"><h1 tabindex="-1">页面暂时无法打开</h1>
      <p role="alert">{{ error }}</p><div class="characters-actions"><button type="button" class="characters-button" @click="load">重试</button><a href="/characters">返回角色</a></div>
    </div>
    <template v-else>
      <a :href="editing ? cancel : query('/characters', { projectId: record?.projectId })" class="characters-back">{{ editing && characterId ? '返回角色' : '角色' }}</a>
      <header class="characters-heading"><div><h1 tabindex="-1">{{ title }}</h1>
        <p v-if="record" class="characters-muted">{{ projectName }} · 第 {{ record.revision }} 版</p>
      </div><div v-if="record && !editing" class="characters-actions">
        <a v-if="pinned" class="characters-button" :href="href(record.characterId)">查看当前版本</a>
        <template v-else><a class="characters-button" :href="query(href(record.characterId), { edit: '1' })">编辑设定</a>
          <a class="characters-button characters-primary" :href="query('/diaries/new', { characterId: record.characterId })">写角色日记</a>
        </template>
      </div></header>
      <p v-if="projectError" role="alert" class="characters-muted">{{ projectError }}</p>
      <CharacterEditor v-if="editing" :key="url.href" :url="url" :character="record" :projects="projects" :project-id="projectId"
        :operations="operations" :cancel="cancel" @navigate="emit('navigate', $event)" @refresh="emit('refresh')" />
      <template v-else-if="record">
        <article v-if="record.persona" class="characters-section characters-persona" aria-label="角色设定"><h2>角色设定</h2><div class="characters-prose">{{ record.persona }}</div></article>
        <CharacterEntries :entries="record.entries" />
        <div class="characters-actions characters-section"><a :href="query('/workspace', { from: 'character', characterId: record.characterId, revision: record.revision })">从这个版本构思场景</a></div>
        <section v-if="operations.get('character.read')?.inputSchema.properties?.revision" class="characters-section" aria-label="版本历史">
          <h2>版本历史</h2>
          <p v-if="historyError" role="alert">{{ historyError }} <button type="button" class="characters-button" @click="load">重新读取</button></p>
          <ol class="characters-history"><li v-for="number in versions" :key="number"><a :href="href(record.characterId, number)" :aria-current="number === record.revision ? 'page' : undefined">第 {{ number }} 版</a><span v-if="number === record.revision" class="characters-muted">正在阅读</span></li></ol>
        </section>
      </template>
    </template>
  </section>
</template>
