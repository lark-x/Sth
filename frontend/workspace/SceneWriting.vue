<script setup lang="ts">
import { onScopeDispose, ref, shallowRef } from 'vue';
import Button from '../ui/Button.vue';
import { all, href, message, recordHref } from './api.ts';
import type { Branch, Draft, Narrative, Scene } from './api.ts';

const props = defineProps<{ scene: Scene }>();
const drafts = shallowRef<Draft[]>([]);
const narratives = shallowRef<Narrative[]>([]);
const branches = shallowRef<Branch[]>([]);
const loaded = ref(false);
const busy = ref(false);
const error = ref('');
const controller = new AbortController();
onScopeDispose(() => controller.abort());
async function load() {
  if (busy.value || loaded.value) return;
  busy.value = true;
  error.value = '';
  const sceneId = props.scene.sceneId;
  try {
    const result = await Promise.all([
      all<Draft>('draft.list', { sceneId }, controller.signal),
      all<Narrative>('narrative.list', { sceneId }, controller.signal),
      all<Branch>('branch.list', { originSceneId: sceneId }, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    [drafts.value, narratives.value, branches.value] = result;
    loaded.value = true;
  } catch (reason) { if (!controller.signal.aborted) error.value = message(reason); }
  finally { if (!controller.signal.aborted) busy.value = false; }
}
function toggle(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) void load();
}
</script>

<template>
  <details class="ce-writing" @toggle="toggle">
    <summary>讲法、候选稿与 IF</summary>
    <p v-if="busy" role="status">正在读取这个场景的讲法…</p>
    <p v-if="error" role="alert" class="ce-error">{{ error }} <Button class="ce-button" variant="outline" @click="load">重新读取</Button></p>
    <template v-if="loaded">
      <div class="ce-actions">
        <a :href="href('/drafts/new', { sceneId: scene.sceneId, revision: scene.revision })">写另一种讲法</a>
        <a v-if="drafts.length > 1" :href="href(recordHref('scenes', scene.sceneId), { action: 'compare' })">对照两种讲法</a>
        <a :href="href('/narratives/new', { sceneId: scene.sceneId, sceneRevision: scene.revision })">组织讲述视角</a>
        <a :href="href(recordHref('scenes', scene.sceneId), { revision: scene.revision, action: 'branch' })">从此场景建立 IF</a>
      </div>
      <p v-if="!drafts.length" class="ce-muted">还没有候选稿。写下一种讲法后，可以继续写另一种，再对照选用。</p>
      <ul v-else class="ce-reference-list" aria-label="候选稿">
        <li v-for="draft in drafts" :key="draft.draftId">
          <a :href="recordHref('drafts', draft.draftId, draft.revision)">{{ draft.title }} · 第 {{ draft.revision }} 版</a>
          <span v-if="scene.adopted?.draftId === draft.draftId" class="ce-muted"> · 已采用第 {{ scene.adopted.revision }} 版</span>
        </li>
      </ul>
      <h4 v-if="narratives.length">已有讲述</h4>
      <ul v-if="narratives.length" class="ce-reference-list" aria-label="已有讲述">
        <li v-for="narrative in narratives" :key="narrative.narrativeId">
          <a :href="recordHref('narratives', narrative.narrativeId, narrative.revision)">{{ narrative.title }} · 第 {{ narrative.revision }} 版</a>
          <a :href="href(recordHref('narratives', narrative.narrativeId), { revision: narrative.revision, action: 'branch' })">从此讲述建立 IF</a>
        </li>
      </ul>
      <h4 v-if="branches.length">已有 IF</h4>
      <ul v-if="branches.length" class="ce-reference-list" aria-label="已有 IF">
        <li v-for="branch in branches" :key="branch.branchId"><a :href="recordHref('branches', branch.branchId)">{{ branch.name }} · 继续 IF</a></li>
      </ul>
    </template>
  </details>
</template>
