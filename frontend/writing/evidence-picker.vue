<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, useId } from 'vue';
import type { ReferenceInput } from '../../src/generation/contracts.ts';
import type { Scene } from '../../src/story/contracts.ts';
import { errorText, invoke, operation } from '../api.ts';
import Button from '../ui/Button.vue';
import { evidenceHref, evidenceKinds, referenceKey } from './evidence-model.ts';

const props = defineProps<{ modelValue: ReferenceInput[]; disabled?: boolean; scene?: Scene }>();
const emit = defineEmits<{ 'update:modelValue': [value: ReferenceInput[]] }>();
type Choice = { id: string; title: string; revision: number };
const uid = useId();
const field = reactive({ kind: 'source' as 'source' | 'character', id: '', revision: 1, excerpt: '', start: '', end: '' });
const choices = shallowRef<Choice[]>([]);
const labels = reactive<Record<string, string>>({});
const loading = ref(false);
const error = ref('');
const more = ref(false);
const expanded = ref(false);
const controls = ref<HTMLFieldSetElement>();
let controller: AbortController | undefined;
const suggested = computed<ReferenceInput[]>(() => props.scene ? [
  ...props.scene.sources.map(pin => ({ kind: 'source' as const, id: pin.sourceId, revision: pin.revision, excerpt: pin.excerpt,
    ...(pin.range ? { range: pin.range } : {}) })),
  ...props.scene.characters.map(pin => ({ kind: 'character' as const, id: pin.characterId, revision: pin.revision })),
] : []);
function label(item: ReferenceInput) {
  return labels[`${item.kind}:${item.id}`] ?? props.scene?.characters.find(pin => pin.characterId === item.id)?.name
    ?? (item.kind === 'source' ? '所选原文' : '所选资料');
}
function add(item: ReferenceInput, title?: string) {
  if (props.disabled || loading.value || props.modelValue.length >= 32) return;
  if (props.modelValue.some(saved => referenceKey(saved) === referenceKey(item))) { error.value = '已加入这一版本的依据。'; return; }
  if (title) labels[`${item.kind}:${item.id}`] = title;
  emit('update:modelValue', [...props.modelValue, item]);
  error.value = '';
}
async function remove(index: number) {
  if (props.disabled || loading.value) return;
  emit('update:modelValue', props.modelValue.filter((_, item) => item !== index));
  controls.value?.focus();
}
async function load(reset = true) {
  controller?.abort();
  const active = controller = new AbortController();
  loading.value = true;
  error.value = '';
  if (reset) { choices.value = []; field.id = ''; }
  try {
    const page = await invoke<{ items: Record<string, any>[] }>(operation(field.kind === 'source' ? 'source.list' : 'character.list',
      { limit: 50, offset: choices.value.length }), active.signal);
    if (active.signal.aborted) return;
    if (!Array.isArray(page.items)) throw new Error('invalid list');
    const items = page.items.map(item => ({ id: item.sourceId ?? item.characterId, title: item.title ?? item.name, revision: item.revision }));
    for (const item of items) labels[`${field.kind}:${item.id}`] = item.title;
    choices.value = [...choices.value, ...items];
    more.value = page.items.length === 50;
  } catch (reason) { if (!active.signal.aborted) error.value = `依据列表读取失败。${errorText(reason)}`; }
  finally { if (!active.signal.aborted) loading.value = false; }
}
async function addSelection() {
  if (props.disabled || loading.value) return;
  const choice = choices.value.find(item => item.id === field.id);
  if (!choice || !Number.isSafeInteger(field.revision) || field.revision < 1) { error.value = '请选择资料并填写版本。'; return; }
  let range;
  if (field.kind === 'source' && (field.start !== '' || field.end !== '')) {
    const start = Number(field.start), end = Number(field.end);
    if (field.start === '' || field.end === '' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      error.value = '请同时填写有效的原文起点和终点。'; return;
    }
    range = { start, end };
  }
  const selected: ReferenceInput = field.kind === 'source' ? { kind: 'source', id: choice.id, revision: field.revision,
    ...(field.excerpt.trim() ? { excerpt: field.excerpt } : {}), ...(range ? { range } : {}) }
    : { kind: 'character', id: choice.id, revision: field.revision };
  add(selected, choice.title);
}
function choose() {
  field.revision = choices.value.find(item => item.id === field.id)?.revision ?? 1;
  field.excerpt = ''; field.start = ''; field.end = '';
}
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <fieldset ref="controls" class="evidence-picker" tabindex="-1" :disabled="disabled">
    <legend>本次依据</legend>
    <p class="ui-field-note">所选版本会随这次组稿固定保存，最多 32 项。</p>
    <p v-if="!modelValue.length" class="ui-field-note">尚未选择额外依据。</p>
    <ol v-else>
      <li v-for="(item, index) in modelValue" :key="referenceKey(item)">
        <a :href="evidenceHref(item.kind, item.id, item.revision)" target="_blank" rel="noopener">{{ evidenceKinds[item.kind] }} · {{ label(item) }} · 第 {{ item.revision }} 版</a>
        <blockquote v-if="item.excerpt">{{ item.excerpt }}</blockquote>
        <Button variant="ghost" size="sm" :disabled="loading" :aria-label="`移除第 ${index + 1} 项依据`" @click="remove(index)">移除</Button>
      </li>
    </ol>
    <details v-if="suggested.length">
      <summary>从场景关联中选择</summary>
      <p>点击加入后，才会作为这次组稿的显式引用。</p>
      <div v-for="(item, index) in suggested" :key="referenceKey(item)" class="evidence-suggestion">
        <p>{{ evidenceKinds[item.kind] }} · {{ label(item) }} · 第 {{ item.revision }} 版</p>
        <blockquote v-if="item.excerpt">{{ item.excerpt }}</blockquote>
        <Button variant="outline" size="sm" :disabled="loading || modelValue.length >= 32" @click="add(item)">加入场景依据 {{ index + 1 }}</Button>
      </div>
    </details>
    <Button variant="outline" size="sm" :aria-expanded="expanded" :aria-controls="`${uid}-choices`" :disabled="loading || modelValue.length >= 32"
      @click="expanded = !expanded; if (expanded && !choices.length) load()">添加本次依据</Button>
    <div v-if="expanded" :id="`${uid}-choices`" class="evidence-choices">
      <div class="ui-field">
        <label :for="`${uid}-kind`">依据类型</label>
        <select :id="`${uid}-kind`" v-model="field.kind" class="ui-input" :disabled="loading" @change="load()"><option value="source">引用原文</option><option value="character">人物</option></select>
      </div>
      <div class="ui-field">
        <label :for="`${uid}-choice`">选择资料</label>
        <select :id="`${uid}-choice`" v-model="field.id" class="ui-input" :disabled="loading" @change="choose"><option value="">选择一项</option>
          <option v-for="item in choices" :key="item.id" :value="item.id">{{ item.title }} · 第 {{ item.revision }} 版</option></select>
      </div>
      <Button v-if="more" variant="ghost" size="sm" :disabled="loading" @click="load(false)">读取更多依据</Button>
      <div class="ui-field">
        <label :for="`${uid}-revision`">固定版本</label><input :id="`${uid}-revision`" v-model.number="field.revision" class="ui-input" type="number" min="1" step="1" :disabled="loading">
      </div>
      <template v-if="field.kind === 'source'">
        <div class="ui-field">
          <label :for="`${uid}-excerpt`">引用原句（可选，留空引用全文）</label><textarea :id="`${uid}-excerpt`" v-model="field.excerpt" class="ui-input" rows="3" maxlength="20000" />
        </div>
        <details><summary>指定原文位置</summary><p :id="`${uid}-range-note`" class="ui-field-note">使用所选版本的 UTF-16 起点和终点，终点不含在选区内。重复原句可按位置区分。</p>
          <div class="ui-field"><label :for="`${uid}-start`">原文起点</label><input :id="`${uid}-start`" v-model="field.start" class="ui-input" :aria-describedby="`${uid}-range-note`" type="number" min="0" step="1"></div>
          <div class="ui-field"><label :for="`${uid}-end`">原文终点</label><input :id="`${uid}-end`" v-model="field.end" class="ui-input" :aria-describedby="`${uid}-range-note`" type="number" min="1" step="1"></div></details>
      </template>
      <a v-if="field.id" :href="evidenceHref(field.kind, field.id, field.revision)" target="_blank" rel="noopener">核对所选版本原文（新窗口）</a>
      <Button size="sm" :disabled="loading || !field.id || modelValue.length >= 32" @click="addSelection">加入本次依据</Button>
    </div>
    <p v-if="loading" role="status">正在读取可选依据…</p>
    <p v-if="error" role="alert" class="ui-field-error">{{ error }} <Button variant="outline" size="sm" :disabled="loading" @click="load()">重新读取依据</Button></p>
  </fieldset>
</template>

<style scoped>
.evidence-picker { min-inline-size: 0; border: 0; border-block-start: 1px solid var(--line, #e5e5e5); padding: 1rem 0 0; margin: 1.5rem 0; }
legend { padding: 0 .5rem 0 0; font-size: .875rem; font-weight: 600; }
p, li, blockquote { overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.8; }
ol { margin-block: 1rem; padding-inline-start: 1.25rem; }
li, details { margin-block: 1rem; }
li::marker { color: var(--muted, #686868); font-size: .8125rem; }
blockquote { margin: .5rem 0; padding: 0; border: 0; color: var(--ink, #252525); }
label { display: block; }
.ui-field { margin-block: 1rem; }
.evidence-choices { margin-block-start: 1rem; }
.evidence-suggestion + .evidence-suggestion { margin-block-start: 1rem; padding-block-start: .5rem; border-block-start: 1px solid var(--line, #e5e5e5); }
textarea { resize: vertical; }
summary { box-sizing: border-box; min-block-size: 2.25rem; padding-block: .5rem; line-height: 1.6; cursor: pointer; }
summary:hover { color: var(--ink, #252525); }
.ui-button { margin-block: .25rem; }
a { display: inline-block; text-underline-offset: .2em; }
.evidence-choices > a { margin-block-end: .75rem; }
[role="alert"] { color: var(--danger); }
:focus-visible { outline: 2px solid var(--focus-ring, var(--ink, #252525)); outline-offset: 3px; }
@media (pointer: coarse), (width < 640px) {
  summary, a { min-block-size: 2.75rem; box-sizing: border-box; }
  a { display: inline-flex; align-items: center; }
}
</style>
