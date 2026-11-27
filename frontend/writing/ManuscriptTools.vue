<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, useId } from 'vue';
import AppIcon from '../AppIcon.vue';
import ManuscriptViewControls from '../manuscript/ManuscriptViewControls.vue';
import { all, read, recordHref } from './api.ts';
import type { Scene } from './api.ts';
import { useRead } from './state.ts';
const props = defineProps<{
  back: string;
  backLabel?: string;
  title: string;
  revision?: number;
  latestRevision?: number;
  status: string;
  adoptedLabel?: string;
  sceneHistorical?: boolean;
  alternate?: boolean;
  placement?: Scene['placement'];
  chapterTitle?: string;
  sceneTitle?: string;
  editing?: boolean;
  editLabel?: string;
  saveable?: boolean;
  saveDisabled?: boolean;
}>();
const emit = defineEmits<{ edit: []; save: [] }>();
const toolbar = ref<HTMLElement>();
const menu = ref<HTMLElement>();
const moreButton = ref<HTMLButtonElement>();
const versions = ref<HTMLElement>();
const versionButton = ref<HTMLButtonElement>();
const evidenceOpen = ref(false);
const evidencePanelId = ref<string>();
let evidenceOwner: HTMLElement | null | undefined;
const id = useId();
const nativePopover =
  typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
const fallbackPanel = ref<'more' | 'versions'>();
const historical = computed(() => props.latestRevision !== undefined &&
  props.revision !== props.latestRevision);
const { data: path } = useRead(async (signal) => {
  if (!props.placement) return;
  const { chapterId, projectId } = props.placement;
  const [projects, chapter] = await Promise.allSettled([
    all<{ projectId: string; title: string }>('project.list', {}, signal),
    props.chapterTitle ? undefined : read<{ title: string }>('chapter.read', { chapterId, limit: 1 }, signal),
  ]);
  return {
    project: projects.status === 'fulfilled' ? projects.value.find(project => project.projectId === projectId)?.title : undefined,
    chapter: chapter.status === 'fulfilled' ? chapter.value?.title : undefined,
  };
});
function toggleFallback(panel: 'more' | 'versions') {
  if (nativePopover) return;
  fallbackPanel.value = fallbackPanel.value === panel ? undefined : panel;
}
function close(panel: HTMLElement | undefined) {
  if (nativePopover) panel?.hidePopover();
  fallbackPanel.value = undefined;
}
function dismiss(event: PointerEvent) {
  const target = event.target as Node;
  if (![menu, moreButton, versions, versionButton].some(item => item.value?.contains(target)))
    close(undefined);
}
function escape(event: KeyboardEvent) {
  if (!fallbackPanel.value) return;
  const trigger = fallbackPanel.value === 'more' ? moreButton.value : versionButton.value;
  event.preventDefault();
  close(undefined);
  trigger?.focus({ preventScroll: true });
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
    <div class="wr-toolbar-identity">
      <button
        ref="versionButton"
        type="button"
        class="wr-toolbar-picker"
        aria-label="稿件与版本"
        :aria-describedby="`${id}-title ${id}-identity`"
        :popovertarget="nativePopover ? `${id}-versions` : undefined"
        :aria-expanded="nativePopover ? undefined : fallbackPanel === 'versions'"
        :aria-controls="`${id}-versions`"
        @click="toggleFallback('versions')"
      >
        <span :id="`${id}-title`" class="wr-toolbar-title" :title="title">{{ title }}</span>
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
      </button>
      <div
        :id="`${id}-versions`"
        ref="versions"
        class="wr-versions-menu"
        :popover="nativePopover ? 'auto' : undefined"
        :hidden="!nativePopover && fallbackPanel !== 'versions'"
        @change="close(versions)"
        @click="($event.target as Element).closest('a') && close(versions)"
      >
        <p class="wr-version-title">{{ title }}</p>
        <div class="wr-version-bar"><slot name="versions" /></div>
      </div>
    </div>
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
        :aria-expanded="nativePopover ? undefined : fallbackPanel === 'more'"
        :aria-controls="id"
        @click="toggleFallback('more')"
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
    <p :id="`${id}-identity`" class="wr-toolbar-meta">
      <span v-if="revision">第 {{ revision }} 版</span>
      <span :class="{ 'wr-adopted-label': status === '采用稿' }">{{ adoptedLabel ?? status }}</span>
      <span v-if="historical">旧版 · 最新第 {{ latestRevision }} 版</span>
      <span v-else-if="revision">最新修订</span>
      <span v-if="sceneHistorical">场景旧版</span>
      <span v-if="alternate">IF 分支</span>
    </p>
    <div
      :id="id"
      ref="menu"
      class="wr-more-menu"
      :popover="nativePopover ? 'auto' : undefined"
      :hidden="!nativePopover && fallbackPanel !== 'more'"
      @click="($event.target as Element).closest('a,button') && close(menu)"
    >
      <a :href="back">{{ backLabel ?? '返回场景' }}</a>
      <slot />
    </div>
  </nav>
  <nav v-if="placement || sceneTitle" class="wr-reader-path" aria-label="文稿位置">
    <template v-if="placement">
      <a :href="recordHref('projects', placement.projectId)" :title="path?.project">{{ path?.project ?? '作品' }}</a>
      <span aria-hidden="true">/</span>
      <a :href="recordHref('chapters', placement.chapterId)" :title="chapterTitle ?? path?.chapter">{{ chapterTitle ?? path?.chapter ?? '章节' }}</a>
      <span v-if="sceneTitle" aria-hidden="true">/</span>
    </template>
    <span v-if="sceneTitle" class="wr-path-scene" :title="sceneTitle">{{ sceneTitle }}</span>
  </nav>
</template>
