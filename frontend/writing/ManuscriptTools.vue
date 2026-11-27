<script setup lang="ts">
import { onMounted, onScopeDispose, ref, useId } from 'vue';
import AppIcon from '../AppIcon.vue';
import ManuscriptViewControls from '../manuscript/ManuscriptViewControls.vue';
defineProps<{
  back: string;
  backLabel?: string;
  title: string;
  editing?: boolean;
  editLabel?: string;
  saveable?: boolean;
  saveDisabled?: boolean;
}>();
const emit = defineEmits<{ edit: []; save: [] }>();
const toolbar = ref<HTMLElement>();
const menu = ref<HTMLElement>();
const moreButton = ref<HTMLButtonElement>();
const evidenceOpen = ref(false);
const evidencePanelId = ref<string>();
let evidenceOwner: HTMLElement | null | undefined;
const id = useId();
const nativePopover =
  typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
const fallbackOpen = ref(false);
function close() {
  if (nativePopover) menu.value?.hidePopover();
  fallbackOpen.value = false;
}
function dismiss(event: PointerEvent) {
  const target = event.target as Node;
  if (!menu.value?.contains(target) && !moreButton.value?.contains(target))
    close();
}
function escape() {
  if (!fallbackOpen.value) return;
  close();
  moreButton.value?.focus({ preventScroll: true });
}
function openEvidence(event: MouseEvent) {
  (event.currentTarget as HTMLButtonElement).dispatchEvent(
    new CustomEvent('sth:open-evidence', { bubbles: true }),
  );
}
function syncEvidence(event: Event) {
  const detail = (event as CustomEvent<{ open: boolean; panelId: string }>)
    .detail;
  if (typeof detail?.open !== 'boolean' || typeof detail.panelId !== 'string')
    return;
  evidenceOpen.value = detail.open;
  evidencePanelId.value = detail.panelId;
}
onMounted(() => {
  if (!nativePopover) document.addEventListener('pointerdown', dismiss);
  evidenceOwner =
    toolbar.value?.closest('main') ?? toolbar.value?.parentElement;
  evidenceOwner?.addEventListener('sth:evidence-state', syncEvidence);
});
onScopeDispose(() => {
  document.removeEventListener('pointerdown', dismiss);
  evidenceOwner?.removeEventListener('sth:evidence-state', syncEvidence);
});
</script>
<template>
  <nav
    ref="toolbar"
    class="wr-reader-toolbar"
    aria-label="读写工具"
    @keydown.esc="escape"
  >
    <ManuscriptViewControls />
    <span class="wr-toolbar-title" :title="title">{{ title }}</span>
    <div class="wr-toolbar-actions">
      <button
        v-if="saveable"
        type="button"
        class="wr-tool"
        aria-label="保存"
        title="保存修订"
        :disabled="saveDisabled"
        @click="emit('save')"
      >
        <svg
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8" /></svg
        ><span class="wr-optional-label">保存</span>
      </button>
      <button
        type="button"
        class="wr-tool"
        :aria-label="editLabel ?? (editing ? '阅读' : '编辑')"
        :title="editLabel ?? (editing ? '阅读' : '编辑')"
        :aria-pressed="!!editing"
        @click="emit('edit')"
      >
        <AppIcon :name="editing ? 'book' : 'pen'" /><span
          class="wr-optional-label"
          >{{ editLabel ?? (editing ? '阅读' : '编辑') }}</span
        >
      </button>
      <button
        type="button"
        class="wr-tool"
        aria-label="来源与依据"
        title="来源与依据"
        :aria-expanded="evidenceOpen"
        :aria-controls="evidencePanelId"
        @click="openEvidence"
      >
        <svg
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h5" /></svg
        ><span class="wr-optional-label">来源</span>
      </button>
      <button
        ref="moreButton"
        type="button"
        class="wr-tool"
        aria-label="更多"
        title="更多"
        :popovertarget="nativePopover ? id : undefined"
        :aria-expanded="nativePopover ? undefined : fallbackOpen"
        :aria-controls="id"
        @click="!nativePopover && (fallbackOpen = !fallbackOpen)"
      >
        <svg
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" /></svg
        ><span class="wr-optional-label">更多</span>
      </button>
    </div>
    <div
      :id="id"
      ref="menu"
      class="wr-more-menu"
      :popover="nativePopover ? 'auto' : undefined"
      :hidden="!nativePopover && !fallbackOpen"
      @click="close"
    >
      <a :href="back">{{ backLabel ?? '返回场景' }}</a>
      <slot />
    </div>
  </nav>
</template>
