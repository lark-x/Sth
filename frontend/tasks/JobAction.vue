<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { bindWrite } from './legacy.js';
import type { Catalog } from './legacy.js';

const props = defineProps<{
  operations: Catalog;
  routeKey: string;
  actionKey: string;
  operation: string;
  input: Record<string, unknown>;
  label: string;
  confirm?: boolean;
}>();
const emit = defineEmits<{ saved: [] }>();
const form = ref<HTMLFormElement>();
let active = true;
onBeforeUnmount(() => { active = false; });
onMounted(() => {
  if (!form.value) return;
  bindWrite({ key: `${props.routeKey}:${props.actionKey}`, active: () => active }, props.operations,
    form.value, props.operation, () => props.input, () => emit('saved'));
});
</script>

<template>
  <form ref="form" class="job-action" method="post" action="/api/web/invoke" :aria-label="label">
    <button class="button secondary" type="submit">{{ confirm ? '确认取消待执行项' : label }}</button>
    <p class="notice" role="alert" tabindex="-1" hidden></p>
  </form>
</template>

<style scoped>
.job-action { min-inline-size: 0; max-inline-size: 100%; }
.job-action button { min-block-size: 2.75rem; white-space: normal; overflow-wrap: anywhere; }
.job-action .notice { margin-block-start: .75rem; overflow-wrap: anywhere; }
</style>
