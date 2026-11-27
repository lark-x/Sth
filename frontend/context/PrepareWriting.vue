<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import type { Generation, GenerationAuthorContextRef, GenerationStoryRef, Template } from '../../src/generation/contracts.ts';
import type { ReferenceInput } from '../../src/generation/contracts.ts';
import type { Scene } from '../../src/story/contracts.ts';
import { ApiError, errorText, invoke, operation, type OperationCall } from '../api.ts';
import { recover } from '../workspace/api.ts';
import { retain, savedText } from '../workspace/useSubmission.ts';
import EvidencePicker from '../writing/evidence-picker.vue';
import { validReferences } from '../writing/evidence-model.ts';

const props = defineProps<{ authorContext?: GenerationAuthorContextRef; story?: GenerationStoryRef; scene?: Scene; returnHref: string }>();
const emit = defineEmits<{ prepared: [record: Generation] }>();
const authorContext = props.authorContext ? { ...props.authorContext } : undefined;
const manuscript = props.scene ? { sceneId: props.scene.sceneId, sceneRevision: props.scene.revision } : undefined;
const key = `sth:context:writing:v1:${JSON.stringify([authorContext, props.story ?? null])}${manuscript ? `:${JSON.stringify(manuscript)}` : ''}`;
type TemplateChoice = Pick<Template, 'templateId' | 'title' | 'revision'>;
type Prepared = Pick<Generation, 'generationId' | 'title'>;
const values = reactive({ title: '', brief: '', templateId: '' });
const references = ref<ReferenceInput[]>([]);
const pending = shallowRef<OperationCall>();
const prepared = shallowRef<Prepared>();
const busy = ref(false);
const failure = ref('');
const templates = shallowRef<TemplateChoice[]>([]);
const templateLoading = ref(false);
const templateFailure = ref('');
const moreTemplates = ref(false);
const invalidField = ref('');
const titleInput = ref<HTMLInputElement>();
const briefInput = ref<HTMLTextAreaElement>();
const controller = new AbortController();
let disposed = false;

function sameScope(value: GenerationAuthorContextRef | undefined) {
  if (!authorContext) return value === undefined;
  return value?.projectId === authorContext.projectId && value.branchId === authorContext.branchId
    && value.contextRevision === authorContext.contextRevision;
}

try {
  const saved = JSON.parse(savedText(key) || 'null');
  if (saved && typeof saved.title === 'string' && typeof saved.brief === 'string' && typeof saved.templateId === 'string') {
    Object.assign(values, { title: saved.title, brief: saved.brief, templateId: saved.templateId });
    if (validReferences(saved.references)) references.value = saved.references;
    if (saved.prepared && typeof saved.prepared.generationId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(saved.prepared.generationId) && typeof saved.prepared.title === 'string') {
      prepared.value = saved.prepared;
    }
  }
  const call = JSON.parse(savedText(`${key}:pending`) || 'null');
  if (call?.operationId === 'generations.prepare' && typeof call.stepId === 'string' && sameScope(call.input?.authorContext)
    && JSON.stringify(call.input?.story ?? null) === JSON.stringify(props.story ?? null)
    && JSON.stringify(call.input?.manuscript ?? null) === JSON.stringify(manuscript ?? null)
    && (call.input?.references === undefined || validReferences(call.input.references))
    && typeof call.input.title === 'string' && typeof call.input.brief === 'string' && typeof call.input.templateId === 'string') {
    pending.value = call;
    prepared.value = undefined;
    Object.assign(values, { title: call.input.title, brief: call.input.brief, templateId: call.input.templateId });
    references.value = call.input.references ?? [];
    failure.value = '上次准备的结果尚未确认。请重试本次准备，找回原组稿。';
  }
} catch { /* A fresh form remains available when a stored draft cannot be read. */ }

function saveDraft() {
  retain(key, JSON.stringify({ ...values, references: references.value, prepared: prepared.value }));
}
watch(values, saveDraft, { flush: 'sync' });
watch(references, saveDraft, { deep: true, flush: 'sync' });

async function loadTemplates() {
  if (templateLoading.value) return;
  templateLoading.value = true;
  templateFailure.value = '';
  try {
    const result = await invoke<{ items: TemplateChoice[] }>(operation('templates.list', { limit: 50, offset: templates.value.length }), controller.signal);
    if (controller.signal.aborted) return;
    if (!Array.isArray(result.items)) throw new Error('invalid templates');
    templates.value = [...templates.value, ...result.items];
    moreTemplates.value = result.items.length === 50;
  } catch (error) {
    if (!controller.signal.aborted) templateFailure.value = `模板读取失败。${errorText(error)}`;
  } finally { if (!controller.signal.aborted) templateLoading.value = false; }
}

function prepareError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'generation_author_context_too_large') return '此版决定与问题超过组稿容量。请返回作品整理内容后，选择新的版本。';
    if (error.code === 'generation_context_too_large' || error.code === 'generation_provenance_too_large') return '组稿内容超过容量，请缩短写作要求，或返回选择较小的作者上下文。';
    if (error.code === 'source_excerpt_mismatch' || error.code === 'source_range_invalid') return '引用原句或位置与所选版本不一致，请核对原文后重试。';
    if (error.code === 'generation_viewpoint_reference_forbidden') return '此人物视角仅允许讲法中可见的事件。请移除额外引用，或返回选择合适的讲法。';
    if (error.status === 409) return '作品、分支或讲法版本不一致，请返回核对固定版本链接。';
    if (error.status === 404) return '找不到所选模板或上下文版本。请重新读取模板，或返回核对版本链接。';
  }
  return `准备失败。${errorText(error)}`;
}

async function submit() {
  if (busy.value || prepared.value) return;
  let call = pending.value;
  const retry = Boolean(call);
  if (!call) {
    invalidField.value = !values.title.trim() ? 'title' : !values.brief.trim() ? 'brief' : '';
    if (invalidField.value) {
      (invalidField.value === 'title' ? titleInput : briefInput).value?.focus();
      return;
    }
    const template = templates.value.find(item => item.templateId === values.templateId);
    if (!template) { templateFailure.value = '请选择已读取的可用模板。'; return; }
    call = operation('generations.prepare', { title: values.title.trim(), brief: values.brief.trim(),
      ...(authorContext ? { projectId: authorContext.projectId, authorContext } : props.scene?.placement ? { projectId: props.scene.placement.projectId } : {}),
      templateId: template.templateId, templateRevision: template.revision,
      references: JSON.parse(JSON.stringify(references.value)), ...(manuscript ? { manuscript } : {}), ...(props.story ? { story: props.story } : {}) });
  }
  pending.value = call;
  retain(`${key}:pending`, JSON.stringify(call));
  busy.value = true;
  failure.value = '';
  try {
    const result = await (retry ? recover<Generation>(call) : invoke<Generation>(call));
    if (typeof result.generationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.generationId)
      || typeof result.title !== 'string' || result.mode !== 'current-chat' || !sameScope(result.composition?.authorContext)) {
      throw new ApiError(502, 'invalid_result', '组稿结果无法读取。');
    }
    if (disposed) return;
    prepared.value = { generationId: result.generationId, title: result.title };
    saveDraft();
    pending.value = undefined;
    retain(`${key}:pending`, '');
    emit('prepared', result);
  } catch (error) {
    if (disposed) return;
    const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status === 408 || error.status >= 500;
    failure.value = uncertain ? '准备结果尚未确认。请重试本次准备，找回原组稿。' : prepareError(error);
    if (!uncertain) {
      pending.value = undefined;
      retain(`${key}:pending`, '');
      if (!templates.value.length) void loadTemplates();
    }
  } finally { if (!disposed) busy.value = false; }
}

function another() {
  prepared.value = undefined;
  saveDraft();
  if (!templates.value.length) void loadTemplates();
}

onBeforeUnmount(() => { disposed = true; controller.abort(); });
if (!prepared.value && !pending.value) void loadTemplates();
</script>

<template>
  <section class="prepare-writing" aria-labelledby="prepare-writing-heading">
    <h2 id="prepare-writing-heading">按此版准备写作</h2>
    <p v-if="authorContext" class="form-note">固定{{ authorContext.branchId ? ' IF 分支' : '主线' }}第 {{ authorContext.contextRevision }} 版作者上下文，包含其它分页。已确认决定在视角可见范围内作为约束，提案与待决问题保持未确定。</p>
    <p v-if="scene" class="form-note">为《{{ scene.title }}》场景第 {{ scene.revision }} 版准备新稿。可临时增减下面的本次依据。</p>
    <p v-if="story" class="form-note">沿用讲法第 {{ story.revision }} 版{{ story.checkpointRevision ? `及断点第 ${story.checkpointRevision} 版` : '' }}，按既有视角可见性准备内容。</p>
    <template v-if="prepared">
      <p role="status">已准备《{{ prepared.title }}》<template v-if="authorContext">，作者上下文固定在第 {{ authorContext.contextRevision }} 版</template>。本次依据已随组稿保存。</p>
      <div class="form-actions">
        <a class="button primary" :href="`/generations/${encodeURIComponent(prepared.generationId)}/prompt`">查看提示词与出处</a>
        <a :href="`/generations/${encodeURIComponent(prepared.generationId)}`">生成记录</a>
        <a :href="returnHref">查看本版决定与依据</a>
        <button class="button quiet" type="button" @click="another">再准备一份</button>
      </div>
    </template>
    <form v-else aria-labelledby="prepare-writing-heading" :aria-busy="busy" @submit.prevent="submit">
      <fieldset :disabled="busy || !!pending">
        <legend class="form-note">填写本次稿件</legend>
        <label for="context-writing-title">稿件标题（必填）</label>
        <input id="context-writing-title" ref="titleInput" v-model="values.title" name="title" required maxlength="300"
          :aria-invalid="invalidField === 'title'" :aria-describedby="invalidField === 'title' ? 'context-writing-title-error' : undefined"
          @invalid="invalidField ||= 'title'" @input="invalidField = ''">
        <p v-if="invalidField === 'title'" id="context-writing-title-error" role="alert">请填写稿件标题。</p>
        <label for="context-writing-brief">写作要求（必填）</label>
        <textarea id="context-writing-brief" ref="briefInput" v-model="values.brief" name="brief" rows="4" required maxlength="20000"
          :aria-invalid="invalidField === 'brief'" :aria-describedby="invalidField === 'brief' ? 'context-writing-brief-error' : undefined"
          @invalid="invalidField ||= 'brief'" @input="invalidField = ''" />
        <p v-if="invalidField === 'brief'" id="context-writing-brief-error" role="alert">请填写写作要求。</p>
        <label for="context-writing-template">内容模板（必填）</label>
        <select id="context-writing-template" v-model="values.templateId" name="templateId" required :disabled="templateLoading">
          <option disabled value="">选择可用模板</option>
          <option v-for="item in templates" :key="item.templateId" :value="item.templateId">{{ item.title }} · 第 {{ item.revision }} 版</option>
        </select>
      </fieldset>
      <EvidencePicker v-model="references" :scene="scene" :disabled="busy || !!pending" />
      <p v-if="templateLoading" role="status">正在读取模板…</p>
      <p v-else-if="!templates.length && !templateFailure && !pending" role="status">暂无可用模板。可以先<a href="/templates/new">新建模板</a>，再重新读取。</p>
      <p v-if="templateFailure" role="alert">{{ templateFailure }}</p>
      <button v-if="!pending && (templateFailure || !templates.length || moreTemplates)" class="button quiet" type="button" :disabled="templateLoading || busy" @click="loadTemplates">
        {{ moreTemplates && !templateFailure ? '读取更多模板' : '重新读取模板' }}
      </button>
      <p v-if="failure" role="alert">{{ failure }}</p>
      <p v-if="busy" role="status">正在准备本版写作…</p>
      <div class="form-actions">
        <button v-if="pending" class="button primary" type="button" :disabled="busy" @click="submit">重试本次准备</button>
        <button v-else class="button primary" type="submit" :disabled="busy || templateLoading || !templates.length">准备写作</button>
        <a :href="returnHref">收起写作准备</a>
      </div>
    </form>
  </section>
</template>

<style scoped>
.prepare-writing { margin-block: 1.5rem 2rem; padding-block: 1.25rem; border-block: 1px solid var(--line-strong); }
h2 { font-size: 1.23rem; margin-block-end: .6rem; }
p { margin-block: .5rem; line-height: 1.65; overflow-wrap: anywhere; }
fieldset { min-inline-size: 0; margin: 1rem 0; padding: 0; border: 0; }
label { display: block; margin-block: 1rem .35rem; }
input, textarea, select { display: block; inline-size: 100%; min-inline-size: 0; max-inline-size: 100%; min-block-size: 3rem; padding: .6rem; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--sheet); font: inherit; }
textarea { resize: vertical; }
[aria-invalid="true"] { border-color: var(--danger); }
[role="alert"] { color: var(--danger); }
.form-actions { margin-block-start: 1rem; gap: .75rem 1rem; }
</style>
