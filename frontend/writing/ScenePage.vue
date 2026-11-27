<script setup lang="ts">
import { all, href, read, recordHref, version } from './api.ts';
import type { Backlink, DraftSummary, Narrative, Scene, SceneSummary } from './api.ts';
import { revisionParam } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { useRead } from './state.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
import EvidenceLinks from './EvidenceLinks.vue';

const props = defineProps<{ route: WritingRoute; url: URL }>();
const { data, busy, error, reload } = useRead(async signal => {
  const sceneId = 'id' in props.route ? props.route.id : '';
  const scene = await read<Scene>('scene.read', { sceneId, revision: revisionParam(props.url.searchParams) }, signal);
  const [drafts, revisions, branches, narratives, evidence, chapter] = await Promise.all([
    all<DraftSummary>('draft.list', { sceneId }, signal), all<SceneSummary>('scene.revisions', { sceneId }, signal),
    all<SceneSummary>('scene.list', { branchOf: sceneId }, signal), all<Narrative>('narrative.list', { sceneId }, signal),
    all<Backlink>('character.backlinks', { kind: 'scene', id: sceneId, revision: scene.revision }, signal),
    scene.placement ? read<{ title: string }>('chapter.read', { chapterId: scene.placement.chapterId }, signal) : undefined,
  ]);
  if (!signal.aborted) document.title = `${scene.title} · Sth`;
  return { scene, drafts, revisions, branches, narratives, evidence, chapter };
});
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && !busy && !error">
    <header class="wr-heading">
      <a href="/create">返回场景</a>
      <h1>{{ data.scene.title }}</h1>
      <p class="wr-muted">场景 · {{ version(data.scene.revision) }}<span v-if="data.scene.branchFrom || data.scene.branchId"> · IF 分支</span></p>
      <nav aria-label="场景操作" class="wr-actions">
        <a class="wr-button wr-primary" :href="href('/drafts/new', { sceneId: data.scene.sceneId, revision: data.scene.revision })">新建候选稿</a>
        <a class="wr-button" :href="href(recordHref('scenes', data.scene.sceneId), { action: 'compare', revision: revisionParam(url.searchParams) })">对照候选稿</a>
        <a :href="href(recordHref('scenes', data.scene.sceneId), { revision: data.scene.revision, action: 'branch' })">建立 IF 分支</a>
        <a v-if="!url.searchParams.has('revision') || data.revisions[0]?.revision === data.scene.revision" :href="href(recordHref('scenes', data.scene.sceneId), { action: 'revise' })">修订场景</a>
        <a v-if="url.searchParams.has('revision')" :href="recordHref('scenes', data.scene.sceneId)">查看当前版本</a>
      </nav>
      <p v-if="data.scene.placement" class="wr-muted">
        <a :href="recordHref('projects', data.scene.placement.projectId)">返回作品</a> ·
        <a :href="recordHref('chapters', data.scene.placement.chapterId)">{{ data.chapter?.title }} · 位置 {{ data.scene.placement.position }}</a> ·
        <a :href="href('/author-context', { projectId: data.scene.placement.projectId, branchId: data.scene.branchId })">创作决定</a>
      </p>
    </header>
    <nav aria-label="本页内容" class="wr-anchor-nav"><a href="#manuscript">采用稿</a><a href="#candidates">候选稿</a><a href="#scene-context">引用上下文</a></nav>
    <div class="wr-reading-layout">
      <div>
        <section id="manuscript" class="wr-section wr-manuscript" aria-label="当前采用稿">
          <h2>当前采用稿</h2>
          <template v-if="data.scene.adopted">
            <h3><a :href="recordHref('drafts', data.scene.adopted.draftId, data.scene.adopted.revision)">{{ data.scene.adopted.title }} · {{ version(data.scene.adopted.revision) }}</a></h3>
            <p class="wr-prose">{{ data.scene.adopted.body }}</p>
          </template>
          <p v-else class="wr-muted">尚未采纳候选稿。写下不同版本并对照后，选择要采用的一稿。</p>
        </section>
        <section id="candidates" class="wr-section">
          <h2>候选稿</h2>
          <ul v-if="data.drafts.length" class="wr-candidates">
            <li v-for="draft in data.drafts" :key="draft.draftId">
              <div><h3><a :href="recordHref('drafts', draft.draftId)">{{ draft.title }}</a></h3>
                <p class="wr-muted">{{ version(draft.revision) }} · 场景上下文 {{ version(draft.sceneRevision) }}</p>
                <p v-if="data.scene.adopted?.draftId === draft.draftId" class="wr-selected">已采用{{ version(data.scene.adopted.revision) }}<span v-if="draft.revision !== data.scene.adopted.revision">，当前候选稿另有修订</span></p>
              </div>
              <a :href="href(recordHref('drafts', draft.draftId), { revision: draft.revision, action: 'adopt' })">核对并采纳</a>
            </li>
          </ul>
          <p v-else class="wr-muted">还没有候选稿。可从当前场景上下文开始写作。</p>
        </section>
        <section v-if="data.scene.branchFrom" class="wr-section">
          <h2>IF 分歧来源</h2><p class="wr-prose">{{ data.scene.branchFrom.divergence }}</p>
          <nav class="wr-actions" aria-label="IF 来源">
            <a :href="recordHref('scenes', data.scene.branchFrom.sceneId, data.scene.branchFrom.revision)">原场景 · {{ version(data.scene.branchFrom.revision) }}</a>
            <a v-if="data.scene.branchFrom.draft" :href="recordHref('drafts', data.scene.branchFrom.draft.draftId, data.scene.branchFrom.draft.revision)">原候选稿 · {{ version(data.scene.branchFrom.draft.revision) }}</a>
          </nav>
        </section>
        <section class="wr-section">
          <h2>事件与讲述</h2>
          <nav class="wr-actions" aria-label="讲述操作">
            <a :href="href('/narratives/new', { sceneId: data.scene.sceneId, sceneRevision: data.scene.revision })">新建讲述</a>
            <a :href="href('/events', { branchId: data.scene.branchId ?? (data.scene.branchFrom ? data.scene.sceneId : undefined) })">查看事件</a>
            <a v-if="data.scene.branchId || data.scene.branchFrom" :href="recordHref('branches', data.scene.branchId ?? data.scene.sceneId)">查看 IF 接续</a>
          </nav>
          <ul class="wr-list"><li v-for="item in data.narratives" :key="item.narrativeId"><a :href="recordHref('narratives', item.narrativeId, item.revision)">{{ item.title }} · {{ version(item.revision) }}</a></li></ul>
        </section>
        <section v-if="data.branches.length" class="wr-section">
          <h2>IF 分支场景</h2><ul class="wr-list"><li v-for="branch in data.branches" :key="branch.sceneId"><a :href="recordHref('scenes', branch.sceneId)">{{ branch.title }} · {{ version(branch.revision) }}</a></li></ul>
        </section>
        <section v-if="data.scene.placement" class="wr-section"><h2>场景构图</h2><nav class="wr-actions" aria-label="构图操作">
          <a :href="href('/compositions/new', { sceneId: data.scene.sceneId, revision: data.scene.revision })">新建构图</a>
          <a :href="href('/compositions', { projectId: data.scene.placement.projectId, sceneId: data.scene.sceneId })">查看构图</a>
        </nav></section>
      </div>
      <aside id="scene-context"><SceneContext :scene="data.scene" /></aside>
    </div>
    <EvidenceLinks :items="data.evidence" />
    <section class="wr-section"><h2>版本历史</h2><ul class="wr-history"><li v-for="item in data.revisions" :key="item.revision">
      <a :href="recordHref('scenes', item.sceneId, item.revision)" :aria-current="item.revision === data.scene.revision ? 'page' : undefined">{{ version(item.revision) }}</a>
      <span v-if="item.revision === data.scene.revision" class="wr-muted">正在阅读</span>
    </li></ul></section>
  </template>
</template>
