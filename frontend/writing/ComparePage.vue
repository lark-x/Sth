<script setup lang="ts">
import { computed, ref } from 'vue';
import { all, ApiError, draftKey, href, read, recordHref, revisionParam, version } from './api.ts';
import type { Draft, DraftSummary, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { useRead } from './state.ts';
import { compareLines } from './diff.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
const props = defineProps<{ route: WritingRoute; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const leftKey = ref('');
const rightKey = ref('');
const differences = ref(true);
const { data, busy, error, reload } = useRead(async signal => {
  const sceneId = 'id' in props.route ? props.route.id : '';
  const scene = await read<Scene>('scene.read', { sceneId, revision: revisionParam(props.url.searchParams) }, signal);
  const drafts = await all<DraftSummary>('draft.list', { sceneId }, signal);
  const versions = (await Promise.all(drafts.map(draft => all<DraftSummary>('draft.revisions', { draftId: draft.draftId }, signal)))).flat();
  const select = (key: string | null) => versions.find(draft => draftKey(draft) === key);
  const left = select(props.url.searchParams.get('left')) ?? (props.url.searchParams.has('left') ? undefined : versions[0]);
  const right = select(props.url.searchParams.get('right')) ?? (props.url.searchParams.has('right') ? undefined : versions.find(draft => draft.draftId !== left?.draftId) ?? versions[1]);
  if ((props.url.searchParams.has('left') && !left) || (props.url.searchParams.has('right') && !right)) {
    throw new ApiError(404, 'draft_version_not_found', '未找到所选稿件版本。');
  }
  leftKey.value = left ? draftKey(left) : '';
  rightKey.value = right ? draftKey(right) : '';
  const compared = left && right ? await read<{ left: Draft; right: Draft }>('draft.compare', {
    sceneId, left: { draftId: left.draftId, revision: left.revision }, right: { draftId: right.draftId, revision: right.revision },
  }, signal) : undefined;
  const contexts = compared ? await Promise.all([compared.left, compared.right].map(draft => read<Scene>('scene.read', { sceneId, revision: draft.sceneRevision }, signal))) : [];
  if (!signal.aborted) document.title = `对照候选稿 · ${scene.title} · Sth`;
  return { scene, versions, compared, contexts };
});
const lines = computed(() => data.value?.compared ? compareLines(data.value.compared.left.body, data.value.compared.right.body) : undefined);
function compare() {
  if (!data.value) return;
  emit('navigate', href(recordHref('scenes', data.value.scene.sceneId), { revision: revisionParam(props.url.searchParams), action: 'compare', left: leftKey.value, right: rightKey.value }));
}
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && !busy && !error">
    <header class="wr-heading"><a :href="recordHref('scenes', data.scene.sceneId, revisionParam(url.searchParams))">返回{{ data.scene.title }}</a><h1>对照候选稿</h1><p class="wr-muted">{{ data.scene.title }} · 对照精确稿件版本，核对后选择采用。</p></header>
    <template v-if="data.compared">
      <form class="wr-compare-form" aria-label="选择对照版本" method="get" :action="recordHref('scenes', data.scene.sceneId)" @submit.prevent="compare">
        <div><label for="wr-left">左稿</label><select id="wr-left" v-model="leftKey" name="left"><option v-for="draft in data.versions" :key="draftKey(draft)" :value="draftKey(draft)">{{ draft.title }} · {{ version(draft.revision) }}</option></select></div>
        <div><label for="wr-right">右稿</label><select id="wr-right" v-model="rightKey" name="right"><option v-for="draft in data.versions" :key="draftKey(draft)" :value="draftKey(draft)">{{ draft.title }} · {{ version(draft.revision) }}</option></select></div>
        <button type="submit" class="wr-button">对照</button>
      </form>
      <label class="wr-check"><input v-model="differences" type="checkbox" name="differences">显示段落差异</label>
      <p v-if="data.compared.left.body === data.compared.right.body" role="status" class="wr-muted">两稿正文一致。</p>
      <p v-else-if="differences" class="wr-muted">左稿删线与右稿下划线标记不同段落。</p>
      <div class="wr-comparison">
        <article v-for="(side, index) in (['left', 'right'] as const)" :key="side" :aria-label="index ? '右稿' : '左稿'">
          <header><h2>{{ index ? '右稿' : '左稿' }} · <a :href="recordHref('drafts', data.compared[side].draftId, data.compared[side].revision)">{{ data.compared[side].title }} · {{ version(data.compared[side].revision) }}</a></h2>
            <p class="wr-muted"><a :href="recordHref('scenes', data.scene.sceneId, data.compared[side].sceneRevision)">上下文 · {{ version(data.compared[side].sceneRevision) }}</a></p>
            <p v-if="data.scene.adopted && draftKey(data.scene.adopted) === draftKey(data.compared[side])" class="wr-selected">此场景版本已采用</p>
            <nav class="wr-actions" :aria-label="index ? '右稿操作' : '左稿操作'">
              <a class="wr-button wr-primary" :href="href(recordHref('drafts', data.compared[side].draftId), { revision: data.compared[side].revision, action: 'adopt' })">采纳{{ index ? '右稿' : '左稿' }}</a>
              <a :href="href(recordHref('scenes', data.scene.sceneId), { revision: data.compared[side].sceneRevision, action: 'branch', draftId: data.compared[side].draftId, draftRevision: data.compared[side].revision })">从此稿建立 IF</a>
            </nav>
          </header>
          <div v-if="differences && lines" class="wr-prose wr-diff"><template v-for="(line, i) in lines[side]" :key="i"><template v-if="i">{{ '\n' }}</template><del v-if="line.changed && !index">{{ line.text }}</del><ins v-else-if="line.changed">{{ line.text }}</ins><template v-else>{{ line.text }}</template></template></div>
          <p v-else class="wr-prose">{{ data.compared[side].body }}</p>
          <details class="wr-context-details"><summary>核对本稿引用上下文</summary><SceneContext v-if="data.contexts[index]" :scene="data.contexts[index]!" /></details>
        </article>
      </div>
    </template>
    <div v-else class="wr-section"><h2>需要两份稿件版本</h2><p>新建另一候选稿，或修订已有稿件，再返回对照。</p><a class="wr-button" :href="href('/drafts/new', { sceneId: data.scene.sceneId, revision: data.scene.revision })">新建候选稿</a></div>
  </template>
</template>
