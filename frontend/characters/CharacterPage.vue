<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import Button from '../ui/Button.vue';
import CharacterEntries from './CharacterEntries.vue';
import CharacterEditor from './CharacterEditor.vue';
import { ApiError, catalog, errorText, href, listAll, query, readCharacter } from './api';
import type { Character, Operation, Project } from './api';
import { manuscriptReturn } from '../manuscript/return-link';

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
const returnTo = computed(() => manuscriptReturn(props.url));
function contextual(path: string) {
  if (!returnTo.value || path.startsWith('#')) return path;
  const destination = new URL(path, props.url);
  if (destination.origin !== props.url.origin || !/^\/(?:characters|sources)(?:\/|$)/.test(destination.pathname)) return path;
  destination.searchParams.set('returnTo', returnTo.value);
  return destination.pathname + destination.search + destination.hash;
}
function navigate(path: string) { emit('navigate', contextual(path)); }
function retainReturn(event: MouseEvent) {
  if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
  const destination = contextual(anchor.getAttribute('href')!);
  if (destination === anchor.getAttribute('href')) return;
  event.preventDefault();
  navigate(destination);
}
const pinned = computed(() => Boolean(props.characterId && requested.value !== null));
const editing = computed(() => !props.characterId || !pinned.value && props.url.searchParams.get('edit') === '1');
const title = computed(() => editing.value ? props.characterId ? '编辑角色' : '新建角色' : record.value?.name ?? '角色');
const projectId = computed(() => record.value?.projectId ?? (projects.value.some(project => project.projectId === props.url.searchParams.get('projectId')) ? props.url.searchParams.get('projectId') ?? '' : ''));
const projectName = computed(() => projects.value.find(project => project.projectId === record.value?.projectId)?.title ?? (record.value?.projectId ? '项目角色' : '独立角色'));
const cancel = computed(() => contextual(props.characterId ? href(props.characterId) : query('/characters', { projectId: projectId.value })));
const versionIdentity = computed(() => {
  if (pinned.value && historyError.value) return '固定版本';
  return record.value && record.value.revision < latestRevision.value ? '历史版本' : '当前版本';
});
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
  <section :aria-busy="busy" aria-label="角色详情" @click="retainReturn">
    <p v-if="busy" role="status" class="characters-state">正在读取角色…</p>
    <div v-else-if="error" class="characters-state"><h1 tabindex="-1">页面暂时无法打开</h1>
      <p role="alert">{{ error }}</p><div class="characters-actions"><Button type="button" class="characters-button" variant="outline" @click="load">重试</Button><a :href="returnTo || '/characters'">{{ returnTo ? '返回原稿' : '返回角色' }}</a></div>
    </div>
    <template v-else>
      <header class="characters-heading characters-toolbar">
        <a class="characters-back" :href="returnTo || (editing ? cancel : contextual(query('/characters', { projectId: record?.projectId })))">{{ returnTo ? '返回原稿' : editing && characterId ? '返回角色' : '角色' }}</a>
        <div class="characters-title"><h1 tabindex="-1">{{ title }}</h1>
          <p v-if="record" class="characters-muted">{{ versionIdentity }} · 第 {{ record.revision }} 版 · {{ projectName }}</p>
        </div>
        <details v-if="record && !editing" class="characters-more"><summary>更多</summary>
          <div class="characters-menu characters-actions">
            <a v-if="pinned" :href="contextual(href(record.characterId))">查看当前版本</a>
            <template v-else><a :href="contextual(query(href(record.characterId), { edit: '1' }))">编辑设定</a>
              <a :href="query('/diaries/new', { characterId: record.characterId })">写角色日记</a>
            </template>
            <a :href="query('/workspace', { from: 'character', characterId: record.characterId, revision: record.revision })">从这个版本构思场景</a>
            <a v-if="returnTo" :href="contextual(query('/characters', { projectId: record.projectId }))">角色</a>
          </div>
        </details>
      </header>
      <p v-if="projectError" role="alert" class="characters-muted">{{ projectError }}</p>
      <CharacterEditor v-if="editing" :key="url.href" :url="url" :character="record" :projects="projects" :project-id="projectId"
        :operations="operations" :cancel="cancel" @navigate="navigate" @refresh="emit('refresh')" />
      <template v-else-if="record">
        <article v-if="record.persona" class="characters-section characters-persona" aria-label="角色设定"><h2>角色设定</h2><div class="characters-prose">{{ record.persona }}</div></article>
        <CharacterEntries :entries="record.entries" :contextual-href="contextual" />
        <details v-if="operations.get('character.read')?.inputSchema.properties?.revision" class="characters-section characters-disclosure" aria-label="版本历史">
          <summary>版本历史</summary>
          <p v-if="historyError" role="alert">{{ historyError }} <Button type="button" class="characters-button" variant="outline" @click="load">重新读取</Button></p>
          <ol class="characters-history"><li v-for="number in versions" :key="number"><a :href="contextual(href(record.characterId, number))" :aria-current="number === record.revision ? 'page' : undefined">第 {{ number }} 版</a><span v-if="number === record.revision" class="characters-muted">正在阅读</span></li></ol>
        </details>
      </template>
    </template>
  </section>
</template>
