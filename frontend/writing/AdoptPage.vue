<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue';
import { all, href, message, read, recordHref, revisionParam, version } from './api.ts';
import type { Draft, DraftSummary, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { returnHref } from './reading.ts';
import { useMutation, useRead } from './state.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
import Button from '../ui/Button.vue';
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
  const [scene, context, revisions] = await Promise.all([
    read<Scene>('scene.read', { sceneId: draft.sceneId }, signal),
    read<Scene>('scene.read', { sceneId: draft.sceneId, revision: draft.sceneRevision }, signal),
    all<DraftSummary>('draft.revisions', { draftId }, signal),
  ]);
  current.value = scene;
  if (!signal.aborted) document.title = `采纳候选稿 · ${draft.title} · Sth`;
  return { draft, context, revisions };
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
const latestDraftRevision = computed(() => data.value?.revisions[0]?.revision);
const branchHref = computed(() => data.value
  ? href(recordHref('scenes', data.value.context.sceneId), {
      revision: data.value.draft.sceneRevision,
      action: 'branch',
      draftId: data.value.draft.draftId,
      draftRevision: data.value.draft.revision,
    })
  : '/create');
const evidenceHref = computed(() => data.value
  ? href(recordHref('drafts', data.value.draft.draftId), {
      revision: data.value.draft.revision,
      returnTo: reviewPageHref,
    })
  : '/create');
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
    </header>
    <div class="wr-reading-layout wr-review-adopt-layout">
      <div class="wr-review-adopt-main">
        <section class="wr-review-transition" aria-label="采用变更">
          <div class="wr-review-transition-side wr-review-current-summary">
            <span class="wr-review-transition-label">当前采用</span>
            <strong v-if="current.adopted">
              {{ current.adopted.title }} · {{ version(current.adopted.revision) }}
            </strong>
            <span v-else class="wr-muted">尚无采用稿</span>
          </div>
          <svg
            class="wr-review-transition-arrow"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          >
            <path d="M4 12h15m-6-6 6 6-6 6" />
          </svg>
          <div class="wr-review-transition-side wr-review-transition-target">
            <span class="wr-review-transition-label">拟采用修订</span>
            <strong>{{ data.draft.title }} · {{ version(data.draft.revision) }}</strong>
            <span class="wr-review-transition-status">
              <template v-if="latestDraftRevision === data.draft.revision">
                最新修订
              </template>
              <template v-else-if="latestDraftRevision">
                历史修订 · 最新第 {{ latestDraftRevision }} 版
              </template>
            </span>
          </div>
        </section>
        <form
          class="wr-review-adopt-form"
          aria-label="确认采纳"
          method="post"
          action="/api/web/invoke"
          @submit.prevent="adopt"
        >
          <div class="wr-review-confirm-controls">
            <p v-if="save.error" role="alert" class="wr-notice">{{ save.error }}</p>
            <div v-if="save.conflict" class="wr-review-refresh-control">
              <Button
                type="button"
                variant="outline"
                class="wr-review-refresh"
                :disabled="refreshing"
                :aria-busy="refreshing"
                @click="loadLatest"
              >
                <span>{{ refreshing ? '正在读取场景…' : '读取最新场景后重新核对' }}</span>
              </Button>
              <p v-if="refreshError" role="alert" class="wr-review-refresh-error">
                {{ refreshError }}
              </p>
            </div>
            <Button
              type="submit"
              class="wr-review-submit"
              :disabled="save.busy || save.conflict"
              :aria-busy="save.busy"
            >
              <span>{{ save.busy ? '正在采纳…' : save.pending ? '重试同一次提交' : '采纳候选稿' }}</span>
            </Button>
          </div>
        </form>
        <section
          class="wr-section wr-manuscript wr-review-target"
          aria-label="即将采用的稿件"
        >
          <h2>{{ data.draft.title }} · {{ version(data.draft.revision) }}</h2>
          <p class="wr-prose">{{ data.draft.body }}</p>
        </section>
        <details class="wr-review-more">
          <summary>更多操作</summary>
          <nav aria-label="采纳页更多操作">
            <a :href="evidenceHref">核对此稿依据</a>
            <a :href="branchHref">从此稿建立 IF</a>
          </nav>
        </details>
        <details v-if="current.adopted" class="wr-section wr-review-current">
          <summary>
            已有采用稿 · {{ current.adopted.title }} · {{ version(current.adopted.revision) }}
          </summary>
          <p class="wr-prose">{{ current.adopted.body }}</p>
          <a
            :href="href(recordHref('drafts', current.adopted.draftId), {
              revision: current.adopted.revision,
              returnTo: reviewPageHref,
            })"
            >查看当前采用版本</a
          >
        </details>
        <details v-if="current.revision !== data.context.revision" class="wr-section">
          <summary>核对目标场景当前上下文 · {{ version(current.revision) }}</summary>
          <SceneContext :scene="current" />
        </details>
      </div>
      <aside><SceneContext :scene="data.context" /></aside>
    </div>
  </template>
</template>
