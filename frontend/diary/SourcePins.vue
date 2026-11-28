<script setup lang="ts">
import type { Source, SourcePin } from './api';
import { resourceHref } from './drafts';

const props = defineProps<{ pins: SourcePin[]; sources: Source[]; disabled: boolean; maxItems: number }>();
const emit = defineEmits<{ change: [pins: SourcePin[]] }>();

function add() {
  emit('change', [...props.pins, { sourceId: '', revision: 1, excerpt: '' }]);
}
function select(pin: SourcePin) {
  pin.revision = props.sources.find(source => source.sourceId === pin.sourceId)?.revision ?? 1;
  delete pin.range;
}
function toggleRange(pin: SourcePin, event: Event) {
  if ((event.target as HTMLInputElement).checked) pin.range = { start: 0, end: 1 };
  else delete pin.range;
}
</script>

<template>
  <div class="diary-pins">
    <fieldset v-for="(pin, index) in pins" :key="index" class="diary-pin" :disabled="disabled">
      <legend>资料引用 {{ index + 1 }}</legend>
      <div class="ui-field">
        <label :for="`diary-source-${index}`">资料</label>
        <select :id="`diary-source-${index}`" class="ui-input" v-model="pin.sourceId" required @change="select(pin)">
          <option value="" disabled>选择资料</option>
          <option v-if="pin.sourceId && !sources.some(source => source.sourceId === pin.sourceId)" :value="pin.sourceId">已引用的资料</option>
          <option v-for="source in sources" :key="source.sourceId" :value="source.sourceId">{{ source.title }} · 第 {{ source.revision }} 版</option>
        </select>
      </div>
      <div class="ui-field">
        <label :for="`diary-source-revision-${index}`">资料版本</label>
        <input :id="`diary-source-revision-${index}`" class="ui-input" v-model.number="pin.revision" type="number" min="1" :max="Number.MAX_SAFE_INTEGER" required>
      </div>
      <a v-if="pin.sourceId && pin.revision > 0" :href="resourceHref('sources', pin.sourceId, pin.revision, pin.range)"
        target="_blank" rel="noopener" class="diary-reference">查看所选版本原文</a>
      <div class="ui-field">
        <label :for="`diary-source-excerpt-${index}`">引用原文</label>
        <textarea :id="`diary-source-excerpt-${index}`" class="ui-input" v-model="pin.excerpt" rows="3" maxlength="4000" required />
      </div>
      <label class="diary-check">
        <input type="checkbox" :checked="Boolean(pin.range)" @change="toggleRange(pin, $event)">限定原文位置
      </label>
      <div v-if="pin.range" class="diary-range">
        <div class="ui-field">
          <label :for="`diary-source-start-${index}`">原文起点</label>
          <input :id="`diary-source-start-${index}`" class="ui-input" v-model.number="pin.range.start" type="number" min="0" :max="Number.MAX_SAFE_INTEGER" required>
        </div>
        <div class="ui-field">
          <label :for="`diary-source-end-${index}`">原文终点</label>
          <input :id="`diary-source-end-${index}`" class="ui-input" v-model.number="pin.range.end" type="number" :min="Number(pin.range.start) + 1" :max="Number.MAX_SAFE_INTEGER" required>
        </div>
      </div>
      <button type="button" class="ui-button diary-button" data-variant="ghost" :aria-label="`移除资料引用 ${index + 1}`" @click="emit('change', pins.filter((_, position) => position !== index))">移除引用</button>
    </fieldset>
    <p v-if="!pins.length" class="diary-muted">可以引用资料的指定版本和原文。</p>
    <button type="button" class="ui-button diary-button" data-variant="outline" :disabled="disabled || pins.length >= maxItems" @click="add">添加资料引用</button>
  </div>
</template>
