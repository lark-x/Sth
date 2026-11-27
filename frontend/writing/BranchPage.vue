<script setup lang="ts">
import { reactive, watch } from 'vue';
import { href, read, recordHref, requiredId, revisionParam, version } from './api.ts';
import type { Draft, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { retain, stored, useMutation, useRead } from './state.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
const props = defineProps<{ route: WritingRoute; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const key = `sth:writing:branch:${props.url.pathname}${props.url.search}`;
const initial = stored<{ title: string; divergence: string; branchName: string }>(key);
const form = reactive({ title: initial?.title ?? '', divergence: initial?.divergence ?? '', branchName: initial?.branchName ?? '' });
watch(form, () => retain(key, { ...form }));
const { state: save, submit } = useMutation<Scene>(`${key}:call`, 'scene.branch', 'sceneId', result => { retain(key); emit('navigate', recordHref('scenes', result.sceneId)); });
const { data, busy, error, reload } = useRead(async signal => {
  const sceneId = 'id' in props.route ? props.route.id : '';
  const scene = await read<Scene>('scene.read', { sceneId, revision: save.pending?.input.revision ?? revisionParam(props.url.searchParams) }, signal);
  const draftRevision = revisionParam(props.url.searchParams, 'draftRevision');
  let draft = scene.adopted;
  if (props.url.searchParams.has('draftId')) {
    const draftId = requiredId(props.url.searchParams.get('draftId'));
    if (!draftRevision) throw new Error('缺少稿件版本');
    draft = await read<Draft>('draft.read', { draftId, revision: draftRevision }, signal);
    if (draft.sceneId !== sceneId) throw new Error('稿件与场景不匹配');
  } else if (draftRevision) throw new Error('缺少稿件');
  if (!signal.aborted) document.title = `建立 IF 分支 · ${scene.title} · Sth`;
  return { scene, draft };
});
function branch(event: Event) {
  if (!data.value) return;
  const element = event.currentTarget as HTMLFormElement;
  const divergence = element.elements.namedItem('divergence') as HTMLTextAreaElement;
  divergence.setCustomValidity(form.divergence.trim() ? '' : '请写下分歧点。');
  if (!element.reportValidity()) return;
  void submit({ sceneId: data.value.scene.sceneId, revision: data.value.scene.revision, divergence: form.divergence.trim(),
    ...(form.title.trim() ? { title: form.title.trim() } : {}), ...(form.branchName.trim() ? { branchName: form.branchName.trim() } : {}),
    ...(data.value.draft ? { draft: { draftId: data.value.draft.draftId, revision: data.value.draft.revision } } : {}),
  });
}
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && !busy && !error">
    <header class="wr-heading"><a :href="recordHref('scenes', data.scene.sceneId, data.scene.revision)">返回{{ data.scene.title }}</a><h1>建立 IF 分支</h1><p class="wr-muted">从 {{ data.scene.title }} · {{ version(data.scene.revision) }} 分叉</p></header>
    <div class="wr-reading-layout">
      <div>
        <details v-if="data.draft" class="wr-section" open><summary>锚定稿件 · {{ data.draft.title }} · {{ version(data.draft.revision) }}</summary><p class="wr-prose">{{ data.draft.body }}</p><a :href="recordHref('drafts', data.draft.draftId, data.draft.revision)">查看原稿</a></details>
        <form class="wr-editor" aria-label="建立 IF 分支" method="post" action="/api/web/invoke" @submit.prevent="branch">
          <label for="wr-divergence">分歧点</label><textarea id="wr-divergence" v-model="form.divergence" name="divergence" required maxlength="1000" rows="4" :readonly="save.busy || !!save.pending" @input="($event.target as HTMLTextAreaElement).setCustomValidity('')" />
          <label for="wr-branch-title">标题</label><input id="wr-branch-title" v-model="form.title" name="title" maxlength="300" :readonly="save.busy || !!save.pending" aria-describedby="wr-branch-hint"><p id="wr-branch-hint" class="wr-muted">可留空，沿用原场景标题。</p>
          <label for="wr-branch-name">分支名称（选填）</label><input id="wr-branch-name" v-model="form.branchName" name="branchName" maxlength="300" :readonly="save.busy || !!save.pending"><p class="wr-muted">填写后可在 IF 接续页继续管理分支与接续位置。</p>
          <p v-if="save.error" role="alert" class="wr-notice">{{ save.error }}</p>
          <div class="wr-actions"><button type="submit" class="wr-button wr-primary" :disabled="save.busy">{{ save.busy ? '正在建立…' : save.pending ? '重试同一次提交' : '建立 IF 分支' }}</button><a :href="href(recordHref('scenes', data.scene.sceneId), { action: 'compare' })">返回对照</a></div>
        </form>
      </div>
      <aside><SceneContext :scene="data.scene" /></aside>
    </div>
  </template>
</template>
