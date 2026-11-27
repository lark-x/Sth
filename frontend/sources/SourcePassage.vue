<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { href, query } from './api';
import type { Operation, Range, Source } from './api';

const props = defineProps<{ source: Source; range?: Range; operations: Map<string, Operation> }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const prose = ref<HTMLElement>();
const status = ref('');
const actions = computed(() =>
  [
    { operation: 'character.adopt-entries', label: '采纳为角色条目', target: '' },
    { operation: 'judgment.create', label: '用作判断依据', target: '/judgments/new' },
    { operation: 'diary.create', label: '引用到日记', target: '/diaries/new' },
    { operation: 'event.save', label: '提炼为事件', target: '/events/new' },
    { operation: 'scene.create', label: '引用到场景', target: '/scenes/new' },
  ].filter((action) => props.operations.has(action.operation)),
);
function choose(target: string) {
  const selection = window.getSelection();
  let range = props.range;
  if (selection?.rangeCount && !selection.isCollapsed) {
    const selected = selection.getRangeAt(0);
    // An unrelated selection must not silently cite a previously highlighted range.
    range = undefined;
    if (prose.value?.contains(selected.startContainer) && prose.value.contains(selected.endContainer)) {
      const before = selected.cloneRange();
      before.selectNodeContents(prose.value);
      before.setEnd(selected.startContainer, selected.startOffset);
      const start = before.toString().length;
      range = { start, end: start + selected.toString().length };
    }
  }
  if (
    !range ||
    range.start < 0 ||
    range.end > props.source.body.length ||
    range.end <= range.start ||
    !props.source.body.slice(range.start, range.end).trim()
  ) {
    status.value = '请先选中一段原文。';
    prose.value?.focus();
    return;
  }
  if (range.end - range.start > 4000) {
    status.value = '选文最多 4000 个 UTF-16 字符，请缩小选区。';
    return;
  }
  emit(
    'navigate',
    target
      ? query(target, {
          sourceId: props.source.sourceId,
          sourceRevision: props.source.revision,
          start: range.start,
          end: range.end,
        })
      : href(props.source.sourceId, props.source.revision, range, { action: 'adopt-entry' }),
  );
}
onMounted(() => {
  if (props.range) prose.value?.querySelector('mark')?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <section aria-label="原文">
    <h2>原文</h2>
    <div id="passage-body" ref="prose" class="passage-body sources-prose" tabindex="-1">
      <template v-if="range"
        >{{ source.body.slice(0, range.start) }}<mark>{{ source.body.slice(range.start, range.end) }}</mark
        >{{ source.body.slice(range.end) }}</template
      ><template v-else>{{ source.body }}</template>
    </div>
    <div class="sources-actions">
      <button
        v-for="action in actions"
        :key="action.operation"
        class="sources-button"
        type="button"
        @click="choose(action.target)"
      >
        {{ action.label }}
      </button>
    </div>
    <p id="passage-status" class="sources-muted" role="status">{{ status }}</p>
  </section>
</template>
