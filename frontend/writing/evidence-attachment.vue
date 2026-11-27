<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import type { Generation, GenerationSummary } from '../../src/generation/contracts.ts';
import type { Draft } from '../../src/story/contracts.ts';
import { errorText, invoke, operation } from '../api.ts';
import { useSubmission } from '../workspace/useSubmission.ts';
import EvidenceContent from './evidence-content.vue';
const props = defineProps<{ draft: Draft }>();
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
    <summary>关联已有组稿</summary>
    <p>如果此稿使用过已保存的组稿，请核对原记录并确认。关联固定在稿件第 {{ draft.revision }} 版。</p>
    <label :for="`${uid}-generation-id`">组稿编号</label><input :id="`${uid}-generation-id`" v-model="generationId" :disabled="busy || !!pending" maxlength="128">
    <button type="button" :disabled="loading || busy || !!pending" @click="inspect">读取待核对组稿</button>
    <p v-if="loading" role="status">正在读取组稿…</p><p v-if="failure" role="alert">{{ failure }}</p>
    <template v-if="record">
      <h3>待核对的组稿</h3><EvidenceContent :generation="record" />
      <a v-if="record.result" :href="`/generations/${encodeURIComponent(record.generationId)}/result`" target="_blank" rel="noopener">核对已保存的生成结果（新窗口）</a>
      <p v-if="record.status !== 'succeeded' || !record.result">请先在此组稿保存生成结果，再核对稿件关联。</p>
      <label v-else :for="`${uid}-confirm`"><input :id="`${uid}-confirm`" v-model="confirmed" type="checkbox" :disabled="busy || !!pending">我确认这版稿件使用了这次组稿</label>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="pending || record?.result" type="button" :disabled="busy || (!pending && !confirmed)" @click="attach">{{ busy ? '正在保存关联…' : pending ? '重试本次关联' : '确认关联此版本' }}</button>
  </details>
</template>
<style scoped>
details { margin-block: 1rem; }
label { display: block; margin-block: .75rem; }
input:not([type="checkbox"]) { display: block; box-sizing: border-box; inline-size: 100%; min-inline-size: 0; min-block-size: 2.75rem; font: inherit; }
button, summary { min-block-size: 2.75rem; cursor: pointer; }
p { white-space: pre-wrap; line-height: 1.65; }
[role="alert"] { color: var(--danger); }
</style>
