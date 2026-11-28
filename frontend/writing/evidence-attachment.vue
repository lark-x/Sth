<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import type { Generation, GenerationSummary } from '../../src/generation/contracts.ts';
import type { Draft } from '../../src/story/contracts.ts';
import { errorText, invoke, operation } from '../api.ts';
import { useSubmission } from '../workspace/useSubmission.ts';
import Button from '../ui/Button.vue';
import EvidenceContent from './evidence-content.vue';
const props = defineProps<{ draft: Draft; returnTo?: string }>();
const emit = defineEmits<{ attached: [] }>();
const uid = useId();
const generationId = ref('');
const record = shallowRef<Generation>();
const confirmed = ref(false);
const loading = ref(false);
const failure = ref('');
let controller: AbortController | undefined;
const { pending, busy, error, submit } = useSubmission<GenerationSummary>(
  `sth:evidence:attach:${props.draft.draftId}:${props.draft.revision}`, 'generations.evidence.attach',
  (value): boolean => value.generationId === pending.value?.input.generationId, () => emit('attached'));
async function inspect() {
  if (busy.value || pending.value) return;
  controller?.abort();
  const active = controller = new AbortController();
  record.value = undefined; confirmed.value = false; failure.value = '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(generationId.value.trim())) { failure.value = '请填写生成记录中的组稿编号。'; return; }
  loading.value = true;
  try {
    const result = await invoke<Generation>(operation('generations.get', { generationId: generationId.value.trim() }), active.signal);
    if (!active.signal.aborted) record.value = result;
  } catch (reason) { if (!active.signal.aborted) failure.value = `组稿读取失败。${errorText(reason)}`; }
  finally { if (!active.signal.aborted) loading.value = false; }
}
function attach() {
  if (pending.value) { void submit(pending.value.input); return; }
  if (record.value?.status !== 'succeeded' || !record.value.result || !confirmed.value) return;
  void submit({ generationId: record.value.generationId, draftId: props.draft.draftId, draftRevision: props.draft.revision, authorConfirmed: true });
}
watch(generationId, () => { controller?.abort(); loading.value = false; record.value = undefined; confirmed.value = false; });
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <details class="evidence-attachment">
    <summary>关联已有记录</summary>
    <p :id="`${uid}-note`" class="ui-field-note">如果此稿使用过已保存的组稿，请核对原记录并确认。关联固定在稿件第 {{ draft.revision }} 版。</p>
    <div class="ui-field">
      <label :for="`${uid}-generation-id`">组稿编号</label>
      <input :id="`${uid}-generation-id`" v-model="generationId" class="ui-input" :aria-describedby="`${uid}-note`" :disabled="busy || !!pending" maxlength="128">
    </div>
    <Button variant="outline" size="sm" :disabled="loading || busy || !!pending" @click="inspect">读取待核对组稿</Button>
    <p v-if="loading" role="status">正在读取组稿…</p><p v-if="failure" role="alert" class="ui-field-error">{{ failure }}</p>
    <template v-if="record">
      <h3>待核对的组稿</h3><EvidenceContent :generation="record" :return-to="returnTo" />
      <a v-if="record.result" :href="`/generations/${encodeURIComponent(record.generationId)}/result`" target="_blank" rel="noopener">核对已保存的生成结果（新窗口）</a>
      <p v-if="record.status !== 'succeeded' || !record.result">请先在此组稿保存生成结果，再核对稿件关联。</p>
      <label v-else class="evidence-confirm" :for="`${uid}-confirm`"><input :id="`${uid}-confirm`" v-model="confirmed" type="checkbox" :disabled="busy || !!pending"><span>我确认这版稿件使用了这次组稿</span></label>
    </template>
    <p v-if="error" role="alert" class="ui-field-error">{{ error }}</p>
    <Button v-if="pending || record?.result" size="sm" :disabled="busy || (!pending && !confirmed)" @click="attach">{{ busy ? '正在保存关联…' : pending ? '重试本次关联' : '确认关联此版本' }}</Button>
  </details>
</template>
<style scoped>
.evidence-attachment { margin-block-start: 1.5rem; padding-block-start: .5rem; border-block-start: 1px solid var(--line, #e5e5e5); overflow-wrap: anywhere; }
.ui-field { margin-block: 1rem .75rem; }
label { display: block; }
.evidence-confirm { display: flex; align-items: flex-start; gap: .5rem; margin-block: 1rem; color: var(--ink, #252525); line-height: 1.8; cursor: pointer; }
.evidence-confirm input { flex: none; margin-block-start: .35rem; accent-color: var(--ink, #252525); }
summary { box-sizing: border-box; min-block-size: 2.25rem; padding-block: .5rem; line-height: 1.6; cursor: pointer; }
summary:hover { color: var(--ink, #252525); }
h3 { margin-block: 1.5rem .5rem; font-size: .875rem; font-weight: 600; }
p { white-space: pre-wrap; line-height: 1.8; }
a { display: inline-block; text-underline-offset: .2em; }
[role="alert"] { color: var(--danger); }
:focus-visible { outline: 2px solid var(--focus-ring, var(--ink, #252525)); outline-offset: 3px; }
@media (pointer: coarse), (width < 640px) {
  summary, .evidence-confirm, a { min-block-size: 2.75rem; box-sizing: border-box; }
  a { display: inline-flex; align-items: center; }
}
</style>
