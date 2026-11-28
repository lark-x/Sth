<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue';
import { href, message, read, recordHref, revisionParam, version } from './api.ts';
import type { Draft, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { returnHref } from './reading.ts';
import { useMutation, useRead } from './state.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
import './review.css';
const props = defineProps<{ route: WritingRoute; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const current = ref<Scene>();
const refreshError = ref('');
const refreshing = ref(false);
let latestRead: AbortController | undefined;
onScopeDispose(() => latestRead?.abort());
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
  if (!signal.aborted) document.title = `采纳候选稿 · ${draft.title} · Sth`;
  return { draft, context };
});
async function loadLatest() {
  if (!current.value || refreshing.value) return;
  refreshing.value = true;
  refreshError.value = '';
  const active = latestRead = new AbortController();
  try {
    const scene = await read<Scene>('scene.read', { sceneId: current.value.sceneId }, active.signal);
    if (active.signal.aborted) return;
    current.value = scene;
    save.conflict = false;
    save.error = '';
  } catch (reason) { if (!active.signal.aborted) refreshError.value = message(reason); }
  finally { if (!active.signal.aborted) refreshing.value = false; }
}
function adopt() {
  if (!data.value || !current.value) return;
  void submit({ sceneId: current.value.sceneId, expectedRevision: current.value.revision, draftId: data.value.draft.draftId, draftRevision: data.value.draft.revision });
}
const sceneScope = computed(() => current.value?.branchFrom || current.value?.branchId ? 'IF 分支' : '主线');
const comparisonHref = computed(() => current.value
  ? href(recordHref('scenes', current.value.sceneId), { action: 'compare' })
  : '/create');
const returnToReview = computed(() => returnHref(props.url, comparisonHref.value));
const reviewPageHref = props.url.pathname + props.url.search;
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && current && !busy && !error">
    <header class="wr-heading wr-review-page wr-review-adopt">
      <a :href="returnToReview">返回对照候选稿</a>
      <h1>采纳候选稿</h1>
      <p class="wr-review-scope">
        <strong>{{ current.title }} · {{ version(current.revision) }}</strong>
        <span>{{ sceneScope }}</span>
        <span v-if="current.branchFrom">源场景固定在第 {{ current.branchFrom.revision }} 版</span>
      </p>
      <p>将 {{ data.draft.title }} · {{ version(data.draft.revision) }} 设为上方场景的采用稿。</p>
    </header>
    <div class="wr-reading-layout wr-review-adopt-layout">
      <div>
        <form class="wr-review-adopt-form" aria-label="确认采纳" method="post" action="/api/web/invoke" @submit.prevent="adopt">
          <p class="wr-review-current-summary">
            <span class="wr-muted">当前采用</span>
            <strong v-if="current.adopted">{{ current.adopted.title }} · {{ version(current.adopted.revision) }}</strong>
            <span v-else class="wr-muted">尚无采用稿</span>
          </p>
          <p class="wr-muted">确认后，场景将采用上方稿件。</p>
          <p v-if="save.error" role="alert" class="wr-notice">{{ save.error }}</p>
          <div v-if="save.conflict"><button type="button" class="wr-button" :disabled="refreshing" @click="loadLatest">{{ refreshing ? '正在读取…' : '读取最新场景后重新核对' }}</button><p v-if="refreshError" role="alert">{{ refreshError }}</p></div>
          <div class="wr-actions"><button type="submit" class="wr-button wr-primary" :disabled="save.busy || save.conflict">{{ save.busy ? '正在采纳…' : save.pending ? '重试同一次提交' : '采纳候选稿' }}</button><a :href="href(recordHref('drafts', data.draft.draftId), { revision: data.draft.revision, returnTo: reviewPageHref })">返回此稿</a></div>
        </form>
        <section class="wr-section wr-manuscript wr-review-target" aria-label="即将采用的稿件"><h2>{{ data.draft.title }} · {{ version(data.draft.revision) }}</h2><p class="wr-prose">{{ data.draft.body }}</p></section>
        <details v-if="current.adopted" class="wr-section wr-review-current"><summary>已有采用稿 · {{ current.adopted.title }} · {{ version(current.adopted.revision) }}</summary><p class="wr-prose">{{ current.adopted.body }}</p><a :href="href(recordHref('drafts', current.adopted.draftId), { revision: current.adopted.revision, returnTo: reviewPageHref })">查看当前采用版本</a></details>
        <p v-else class="wr-muted wr-review-no-current">目标场景目前没有采用稿。</p>
        <details v-if="current.revision !== data.context.revision" class="wr-section"><summary>核对目标场景当前上下文 · {{ version(current.revision) }}</summary><SceneContext :scene="current" /></details>
      </div>
      <aside><SceneContext :scene="data.context" /></aside>
    </div>
  </template>
</template>
