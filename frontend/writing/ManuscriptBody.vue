<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import type { PassageRange } from './reading.ts';
import {
  passageRange,
  selectedPassage,
  useReadingPosition,
} from './reading.ts';
const props = defineProps<{ body: string; readingKey: string; url: URL }>();
const passage = ref<HTMLElement>();
const key = computed(() => props.readingKey);
const range = computed(() =>
  passageRange(props.url.searchParams, props.body.length),
);
let selected: PassageRange | undefined;
function rememberSelection() {
  if (passage.value) selected = selectedPassage(passage.value) ?? selected;
}
onMounted(() =>
  document.addEventListener('selectionchange', rememberSelection),
);
onScopeDispose(() =>
  document.removeEventListener('selectionchange', rememberSelection),
);
const { remember, restore } = useReadingPosition(passage, key, props.url);
defineExpose({
  selection: () =>
    passage.value
      ? (selectedPassage(passage.value) ?? selected ?? range.value)
      : range.value,
  remember,
  restore,
});
</script>
<template>
  <div
    id="passage-body"
    ref="passage"
    class="wr-prose wr-reader-prose"
    tabindex="-1"
  >
    <template v-if="range"
      >{{ body.slice(0, range.start)
      }}<mark tabindex="-1">{{ body.slice(range.start, range.end) }}</mark
      >{{ body.slice(range.end) }}</template
    ><template v-else>{{ body }}</template>
  </div>
</template>
