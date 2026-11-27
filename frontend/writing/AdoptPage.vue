<script setup lang="ts">
import { ref } from 'vue';
import { href, message, read, recordHref, revisionParam, version } from './api.ts';
import type { Draft, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { useMutation, useRead } from './state.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
const props = defineProps<{ route: WritingRoute; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const current = ref<Scene>();
const refreshError = ref('');
const refreshing = ref(false);
const { state: save, submit } = useMutation<Scene>(`sth:writing:adopt:${props.url.pathname}${props.url.search}`, 'scene.adopt', 'sceneId', result => emit('navigate', recordHref('scenes', result.sceneId)));
const { data, busy, error, reload } = useRead(async signal => {
  const draftId = 'id' in props.route ? props.route.id : '';
  const revision = save.pending?.input.draftRevision ?? revisionParam(props.url.searchParams);
  const draft = await read<Draft>('draft.read', { draftId, revision }, signal);
  const [scene, context] = await Promise.all([
    read<Scene>('scene.read', { sceneId: draft.sceneId }, signal),
    read<Scene>('scene.read', { sceneId: draft.sceneId, revision: draft.sceneRevision }, signal),
  ]);
  current.value = scene;
  document.title = `采纳候选稿 · ${draft.title} · Sth`;
  return { draft, context };
});
async function loadLatest() {
  if (!current.value || refreshing.value) return;
  refreshing.value = true;
  refreshError.value = '';
  try {
    const scene = await read<Scene>('scene.read', { sceneId: current.value.sceneId }, AbortSignal.timeout(15_000));
    current.value = scene;
    save.conflict = false;
    save.error = '';
  } catch (reason) { refreshError.value = message(reason); }
  finally { refreshing.value = false; }
}
function adopt() {
  if (!data.value || !current.value) return;
  void submit({ sceneId: current.value.sceneId, expectedRevision: current.value.revision, draftId: data.value.draft.draftId, draftRevision: data.value.draft.revision });
}
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && current && !busy && !error">
    <header class="wr-heading"><a :href="href(recordHref('scenes', current.sceneId), { action: 'compare' })">返回对照候选稿</a><h1>采纳候选稿</h1><p>将 <strong>{{ data.draft.title }} · {{ version(data.draft.revision) }}</strong> 采用到 <strong>{{ current.title }} · {{ version(current.revision) }}</strong>。</p></header>
    <div class="wr-reading-layout">
      <div>
        <section class="wr-section wr-manuscript" aria-label="即将采用的稿件"><h2>{{ data.draft.title }} · {{ version(data.draft.revision) }}</h2><p class="wr-prose">{{ data.draft.body }}</p></section>
        <details v-if="current.adopted" class="wr-section"><summary>核对当前采用稿 · {{ current.adopted.title }} · {{ version(current.adopted.revision) }}</summary><p class="wr-prose">{{ current.adopted.body }}</p><a :href="recordHref('drafts', current.adopted.draftId, current.adopted.revision)">查看当前采用版本</a></details>
        <form aria-label="确认采纳" method="post" action="/api/web/invoke" @submit.prevent="adopt">
          <p class="wr-muted">确认后，场景的采用稿将指向上方这份精确版本。</p>
          <p v-if="save.error" role="alert" class="wr-notice">{{ save.error }}</p>
          <div v-if="save.conflict"><button type="button" class="wr-button" :disabled="refreshing" @click="loadLatest">{{ refreshing ? '正在读取…' : '读取最新场景后重新核对' }}</button><p v-if="refreshError" role="alert">{{ refreshError }}</p></div>
          <div class="wr-actions"><button type="submit" class="wr-button wr-primary" :disabled="save.busy || save.conflict">{{ save.busy ? '正在采纳…' : save.pending ? '重试同一次提交' : '采纳候选稿' }}</button><a :href="recordHref('drafts', data.draft.draftId, data.draft.revision)">返回此稿</a></div>
        </form>
      </div>
      <aside><SceneContext :scene="data.context" /></aside>
    </div>
  </template>
</template>
