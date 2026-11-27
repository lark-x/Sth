<script setup lang="ts">
import { computed, ref } from 'vue';
import { all, href, read, recordHref, revisionParam, version } from './api.ts';
import type { Backlink, Draft, DraftSummary, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { useRead } from './state.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
import EvidenceLinks from './EvidenceLinks.vue';
const props = defineProps<{ route: WritingRoute; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const passage = ref<HTMLElement>();
const selectionError = ref('');
const { data, busy, error, reload } = useRead(async signal => {
  const draftId = 'id' in props.route ? props.route.id : '';
  const draft = await read<Draft>('draft.read', { draftId, revision: revisionParam(props.url.searchParams) }, signal);
  const [scene, revisions, evidence] = await Promise.all([
    read<Scene>('scene.read', { sceneId: draft.sceneId, revision: draft.sceneRevision }, signal),
    all<DraftSummary>('draft.revisions', { draftId }, signal),
    all<Backlink>('character.backlinks', { kind: 'draft', id: draftId, revision: draft.revision }, signal),
  ]);
  if (!signal.aborted) document.title = `${draft.title} · Sth`;
  return { draft, scene, revisions, evidence };
});
const range = computed(() => {
  const start = Number(props.url.searchParams.get('start'));
  const end = Number(props.url.searchParams.get('end'));
  return /^\d+$/.test(props.url.searchParams.get('start') ?? '') && /^\d+$/.test(props.url.searchParams.get('end') ?? '') &&
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start && end <= (data.value?.draft.body.length ?? 0) ? { start, end } : undefined;
});
function cite(kind: 'character' | 'event') {
  if (!data.value || !passage.value) return;
  let chosen = range.value;
  const selected = window.getSelection();
  if (selected?.rangeCount && !selected.isCollapsed) {
    const span = selected.getRangeAt(0);
    if (passage.value.contains(span.startContainer) && passage.value.contains(span.endContainer)) {
      const before = span.cloneRange();
      before.selectNodeContents(passage.value);
      before.setEnd(span.startContainer, span.startOffset);
      const start = before.toString().length;
      chosen = { start, end: start + span.toString().length };
    }
  }
  if (!chosen || !data.value.draft.body.slice(chosen.start, chosen.end).trim()) {
    selectionError.value = '请先选中一段原文。';
    passage.value.focus();
    return;
  }
  const draft = data.value.draft;
  emit('navigate', kind === 'character' ? href(recordHref('drafts', draft.draftId), { revision: draft.revision, ...chosen, action: 'adopt-entry' })
    : href('/events/new', { draftId: draft.draftId, draftRevision: draft.revision, ...chosen }));
}
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && !busy && !error">
    <header class="wr-heading"><a :href="recordHref('scenes', data.draft.sceneId)">返回{{ data.scene.title }}</a><h1>{{ data.draft.title }}</h1><p class="wr-muted">候选稿 · {{ version(data.draft.revision) }}</p>
      <nav class="wr-actions" aria-label="稿件操作">
        <a class="wr-button wr-primary" :href="href(recordHref('drafts', data.draft.draftId), { revision: data.draft.revision, action: 'adopt' })">采纳此版本</a>
        <a v-if="!url.searchParams.has('revision') || data.revisions[0]?.revision === data.draft.revision" :href="href(recordHref('drafts', data.draft.draftId), { action: 'revise' })">修订候选稿</a>
        <a :href="href(recordHref('scenes', data.scene.sceneId), { revision: data.scene.revision, action: 'branch', draftId: data.draft.draftId, draftRevision: data.draft.revision })">从此稿建立 IF</a>
        <a :href="href(recordHref('scenes', data.scene.sceneId), { action: 'compare' })">对照候选稿</a>
        <a :href="href('/generations/new', { draftId: data.draft.draftId, draftRevision: data.draft.revision })">用此稿准备写作</a>
        <a v-if="url.searchParams.has('revision')" :href="recordHref('drafts', data.draft.draftId)">查看当前版本</a>
      </nav>
    </header>
    <div class="wr-reading-layout">
      <section class="wr-section wr-manuscript" aria-label="稿件正文"><h2>正文</h2>
        <div id="passage-body" ref="passage" class="wr-prose" tabindex="-1"><template v-if="range">{{ data.draft.body.slice(0, range.start) }}<mark>{{ data.draft.body.slice(range.start, range.end) }}</mark>{{ data.draft.body.slice(range.end) }}</template><template v-else>{{ data.draft.body }}</template></div>
        <nav class="wr-actions wr-passage-actions" aria-label="原文操作"><button type="button" class="wr-button" @click="cite('character')">采纳为角色条目</button><button type="button" class="wr-button" @click="cite('event')">提炼为事件</button></nav>
        <p class="wr-muted">选中正文片段后可追溯引用。</p><p v-if="selectionError" role="status">{{ selectionError }}</p>
      </section>
      <aside><SceneContext :scene="data.scene" /></aside>
    </div>
    <EvidenceLinks :items="data.evidence" />
    <section class="wr-section"><h2>版本历史</h2><ul class="wr-history"><li v-for="item in data.revisions" :key="item.revision"><a :href="recordHref('drafts', item.draftId, item.revision)" :aria-current="item.revision === data.draft.revision ? 'page' : undefined">{{ version(item.revision) }}</a><span v-if="item.revision === data.draft.revision" class="wr-muted">正在阅读</span></li></ul></section>
  </template>
</template>
