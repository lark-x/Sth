<script setup lang="ts">
import { label } from './legacy.js';
import { dateText } from './model.ts';
import type { Attempt } from './model.ts';
defineProps<{ attempt: Attempt }>();
</script>

<template>
  <dl class="attempt-facts">
    <div><dt>供应商</dt><dd>{{ attempt.provider }}</dd></div>
    <div><dt>上游任务</dt><dd>{{ attempt.providerJobId ?? '未知' }}</dd></div>
    <div><dt>请求编号</dt><dd>{{ attempt.requestId }}</dd></div>
    <div v-if="attempt.message"><dt>说明</dt><dd>{{ attempt.message }}</dd></div>
    <div><dt>更新时间</dt><dd><time :datetime="attempt.updatedAt">{{ dateText(attempt.updatedAt) }}</time></dd></div>
    <div v-for="(value, key) in attempt.parameters" :key="key"><dt>{{ label(key) }}</dt><dd>{{ value }}</dd></div>
  </dl>
</template>

<style scoped>
.attempt-facts { display: grid; gap: .7rem; margin-block: 1rem; }
.attempt-facts > div { display: grid; grid-template-columns: minmax(5.5rem, 8rem) minmax(0, 1fr); gap: .5rem 1rem; }
dt { color: var(--muted); font-size: .875rem; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (width <= 30rem) { .attempt-facts > div { grid-template-columns: 1fr; gap: .15rem; } }
</style>
