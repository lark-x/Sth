<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { StoryContext, DecisionSummary, QuestionSummary, Decision, Question } from '../../src/story/decision-contracts.ts';
import type { GenerationStoryRef } from '../../src/generation/contracts.ts';
import { ApiError, errorText, invoke, operation, type OperationCall } from '../api.ts';
import PrepareWriting from './PrepareWriting.vue';

const props = defineProps<{url: URL}>();
const project = computed(() => props.url.searchParams.get('projectId') ?? '');
const branch = computed(() => props.url.searchParams.get('branchId'));
const version = computed(() => props.url.searchParams.get('revision'));
const offset = computed(() => Number(props.url.searchParams.get('offset') ?? 0));
const scope = computed(() => ({ projectId: project.value, branchId: branch.value }));
const context = shallowRef<StoryContext>();
const detail = shallowRef<Decision | Question>();
const failure = ref('');
const saving = ref(false);
const loading = ref(false);
const pending = shallowRef<OperationCall>();
const author = ref('');
const questionTitle = ref('');
const questionBody = ref('');
const detailFailure = ref('');
const inspecting = ref(false);
const detailPanel = ref<HTMLElement>();
let inspection = 0;
let controller: AbortController | undefined;
const pageSize = 12;
const more = computed(() => context.value && [context.value.confirmedDecisions, context.value.pendingDecisions,
  context.value.openQuestions, context.value.resolvedQuestions].some(section => section.hasMore));

function href(revision: number | null, skip = 0) {
  const url = new URL(props.url);
  url.searchParams.delete('prepare');
  if (revision === null) url.searchParams.delete('revision');
  else url.searchParams.set('revision', String(revision));
  if (skip) url.searchParams.set('offset', String(skip));
  else url.searchParams.delete('offset');
  return url.pathname + url.search;
}

const preparing = computed(() => props.url.searchParams.get('prepare') === '1' && version.value !== null);
const prepareHref = computed(() => {
  if (!context.value) return '';
  const url = new URL(href(context.value.revision, offset.value), props.url);
  url.searchParams.set('prepare', '1');
  return url.pathname + url.search;
});
const pinnedStory = computed((): { story?: GenerationStoryRef; error?: string } => {
  const params = props.url.searchParams;
  if (!['narrativeId', 'narrativeRevision', 'checkpointRevision'].some(key => params.has(key))) return {};
  const narrativeId = params.get('narrativeId') ?? '';
  const rawRevision = params.get('narrativeRevision') ?? '';
  const revision = Number(rawRevision);
  const checkpoint = params.get('checkpointRevision');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(narrativeId) || !/^\d+$/.test(rawRevision) || !Number.isSafeInteger(revision) || revision < 1
    || (checkpoint !== null && (!/^\d+$/.test(checkpoint) || !Number.isSafeInteger(Number(checkpoint)) || Number(checkpoint) < 1))) {
    return { error: '讲法版本链接不完整，请回到讲法页重新打开。' };
  }
  return { story: { narrativeId, revision, branchId: branch.value,
    ...(checkpoint === null ? {} : { checkpointRevision: Number(checkpoint) }) } };
});

async function load() {
  controller?.abort();
  const active = new AbortController();
  controller = active;
  loading.value = true;
  failure.value = '';
  detail.value = undefined;
  detailFailure.value = '';
  inspecting.value = false;
  inspection++;
  try {
    if (!project.value || (version.value !== null && (!/^\d+$/.test(version.value) || !Number.isSafeInteger(Number(version.value))))
      || !Number.isSafeInteger(offset.value) || offset.value < 0) {
      throw new Error('请从作品页打开创作决定，或检查版本链接。');
    }
    const result = await invoke<StoryContext>(operation('story.context', { ...scope.value,
      ...(version.value === null ? {} : {contextRevision: Number(version.value)}), offset: offset.value, limit: pageSize }), active.signal);
    if (!active.signal.aborted) context.value = result;
  } catch (error) {
    if (!active.signal.aborted) { context.value = undefined; failure.value = error instanceof Error ? error.message : errorText(error); }
  } finally { if (!active.signal.aborted) loading.value = false; }
}

async function inspect(record: Pick<DecisionSummary, 'decisionId' | 'revision'> | Pick<QuestionSummary, 'questionId' | 'revision'>) {
  const active = controller;
  const request = ++inspection;
  inspecting.value = true;
  detail.value = undefined;
  detailFailure.value = '';
  const input = 'decisionId' in record ? { decisionId: record.decisionId } : { questionId: record.questionId };
  const method = 'decisionId' in record ? 'decision.read' : 'question.read';
  try {
    const result = await invoke<Decision | Question>(operation(method, { ...input, revision: record.revision }), active?.signal);
    if (active === controller && request === inspection) {
      detail.value = result;
      await nextTick();
      if (active === controller && request === inspection) detailPanel.value?.focus();
    }
  } catch (error) { if (!active?.signal.aborted && request === inspection) detailFailure.value = errorText(error); }
  finally { if (active === controller && request === inspection) inspecting.value = false; }
}

async function write(call: OperationCall) {
  if (saving.value || version.value !== null) return;
  const active = controller;
  pending.value = call;
  saving.value = true;
  failure.value = '';
  try {
    await invoke(call);
    if (active !== controller) return;
    pending.value = undefined;
    if (call.operationId === 'question.save') { questionTitle.value = ''; questionBody.value = ''; }
    await load();
  } catch (error) {
    if (active !== controller) return;
    const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
    if (definitive) pending.value = undefined;
    failure.value = error instanceof ApiError && error.status === 409 ? '此条目已更新，请重新读取后核对。' : errorText(error);
  } finally { saving.value = false; }
}

function confirm(item: DecisionSummary) {
  if (author.value.trim()) void write(operation('decision.confirm', {decisionId: item.decisionId, expectedRevision: item.revision,
    proposalRevision: item.revision, authorConfirmed: true, confirmedBy: author.value.trim()}));
}
watch(() => props.url.href, () => {
  context.value = undefined; pending.value = undefined; questionTitle.value = ''; questionBody.value = ''; void load();
}, { immediate: true });
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section class="author-context">
    <a :href="project ? `/projects/${encodeURIComponent(project)}` : '/projects'">返回作品</a>
    <h1>创作决定</h1>
    <p v-if="branch"><a :href="`/branches/${encodeURIComponent(branch)}`">IF 分支</a></p>
    <p v-if="loading" role="status">正在读取…</p>
    <p v-if="failure" role="alert">{{ failure }} <button v-if="pending" :disabled="saving" @click="write(pending)">重试本次操作</button><button v-else @click="load">重新读取</button></p>
    <template v-if="context">
      <nav class="context-links" aria-label="决定版本"><span>{{ branch ? 'IF' : '主线' }} · 第 {{ context.revision }} 版</span>
        <a v-if="version === null" :href="href(context.revision, offset)">固定此版本</a><a v-else :href="href(null)">返回最新版</a>
        <a v-if="context.revision > 0" :href="href(context.revision - 1)">上一版本</a>
      </nav>
      <div v-if="!preparing" class="context-actions"><a class="button primary" :href="prepareHref">按此版准备写作</a></div>
      <p v-else-if="pinnedStory.error" role="alert">{{ pinnedStory.error }}</p>
      <PrepareWriting v-else :key="`${context.projectId}:${context.branchId}:${context.revision}`"
        :author-context="{ projectId: context.projectId, branchId: context.branchId, contextRevision: context.revision }"
        :story="pinnedStory.story" :return-href="href(context.revision, offset)" />
      <section aria-labelledby="confirmed-decisions"><h2 id="confirmed-decisions">作者已确认</h2><p v-if="!context.confirmedDecisions.items.length">本页暂无已确认的决定。</p>
        <article v-for="item in context.confirmedDecisions.items" :key="item.decisionId"><h3>{{ item.title }}</h3><p>{{ item.body }}</p>
          <small v-if="item.status === 'confirmed'">{{ item.confirmation.confirmedBy }} · {{ item.confirmation.confirmedAt.slice(0,10) }} · 第 {{ item.revision }} 版</small>
          <button @click="inspect(item)">查看依据</button></article></section>
      <section aria-labelledby="pending-decisions"><h2 id="pending-decisions">待确认提案</h2><p v-if="!context.pendingDecisions.items.length">本页暂无待确认的提案。</p>
        <label v-if="version === null && context.pendingDecisions.items.length">作者署名<input v-model="author" maxlength="160" autocomplete="name"></label>
        <article v-for="item in context.pendingDecisions.items" :key="item.decisionId"><h3>{{ item.title }}</h3><p>{{ item.body }}</p>
          <button @click="inspect(item)">查看依据</button><button v-if="version === null" :disabled="saving || !!pending || !author.trim()" @click="confirm(item)">确认这一版</button></article></section>
      <section aria-labelledby="open-questions"><h2 id="open-questions">待决问题</h2><p v-if="!context.openQuestions.items.length">本页暂无待决问题。</p>
        <article v-for="item in context.openQuestions.items" :key="item.questionId"><h3>{{ item.title }}</h3><p>{{ item.body }}</p><button @click="inspect(item)">查看依据</button></article>
        <details v-if="version === null"><summary>记下问题</summary>
          <form @submit.prevent="write(operation('question.save', {...scope, title: questionTitle.trim(), body: questionBody.trim()}))">
            <label>问题标题<input v-model="questionTitle" required maxlength="160"></label><label>要讨论的内容<textarea v-model="questionBody" required maxlength="4000" rows="3" /></label>
            <button :disabled="saving || !!pending || !questionTitle.trim() || !questionBody.trim()">保存问题</button>
          </form></details></section>
      <section v-if="context.resolvedQuestions.items.length" aria-labelledby="resolved-questions"><h2 id="resolved-questions">已结案问题</h2><article v-for="item in context.resolvedQuestions.items" :key="item.questionId"><h3>{{ item.title }}</h3>
        <p>{{ item.body }}</p><button @click="inspect(item)">查看问题依据</button>
        <button v-if="item.status === 'resolved'" @click="inspect(item.resolution)">当时确认的决定</button></article></section>
      <p v-if="inspecting" role="status">正在读取该版本依据…</p>
      <p v-if="detailFailure" role="alert">依据读取失败。{{ detailFailure }}请再次点击对应条目的依据按钮。</p>
      <aside v-if="detail" ref="detailPanel" tabindex="-1" aria-label="条目依据" aria-live="polite"><h2>{{ detail.title }} · 第 {{ detail.revision }} 版</h2><p>{{ detail.body }}</p>
        <p v-if="detail.status === 'confirmed'" class="form-note">{{ detail.confirmation.confirmedBy }} · {{ detail.confirmation.confirmedAt }} · 确认提案第 {{ detail.confirmation.proposalRevision }} 版</p>
        <p v-if="!detail.basis.sources.length && !detail.basis.scene && !detail.basis.checkpoint" class="form-note">该版本未附资料、场景或断点依据。</p>
        <blockquote v-for="source in detail.basis.sources" :key="`${source.sourceId}:${source.range?.start}`"><p>{{ source.excerpt }}</p><a :href="source.href">原文 · 第 {{ source.revision }} 版</a></blockquote>
        <a v-if="detail.basis.scene" :href="detail.basis.scene.href">所用场景</a> <a v-if="detail.basis.checkpoint" :href="detail.basis.checkpoint.href">续写位置</a>
        <button @click="inspection++; detail = undefined">收起</button></aside>
      <nav v-if="more || offset" class="context-links" aria-label="条目分页"><a v-if="offset" :href="href(context.revision, Math.max(0, offset-pageSize))">上一页</a><a v-if="more" :href="href(context.revision, offset+pageSize)">下一页</a></nav>
    </template>
  </section>
</template>

<style scoped>
.author-context { max-width: 48rem; overflow-wrap:anywhere; }
.author-context h2 { font-size:1.23rem; margin-block:1.7rem .6rem; }
.author-context h3 { font-size:1.02rem; }
.author-context p { white-space:pre-wrap; line-height:1.65; }
.author-context article { border-top:1px solid #d8d9d5; padding-block:.7rem; }
.author-context label { display:grid; gap:.3rem; margin-block:.65rem; }
.author-context button, .author-context summary { cursor:pointer; min-height:2.75rem; margin-inline-end:.45rem; }
.author-context small { display:block; margin-bottom:.5rem; }
.context-links { display:flex; flex-wrap:wrap; gap:.3rem 1rem; align-items:center; }
.author-context aside { border:1px solid var(--line-strong); padding:1rem; margin-block:1rem; }
.context-actions { margin-block:1.25rem; }
</style>
