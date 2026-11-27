<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import AppIcon from '../AppIcon.vue';
import LibraryPanels from './LibraryPanels.vue';
import type { LibraryPreviewReason } from './library-data.ts';
import { collectionRoute } from './routes.ts';
import { manuscriptView } from './view.ts';
import ManuscriptViewControls from './ManuscriptViewControls.vue';
import './frame.css';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
type Pane = 'library' | 'sheets' | 'editor';
const root = ref<HTMLElement>();
const first = ref<string>();
const emptyReason = ref<LibraryPreviewReason>();
const previewTitles: Record<LibraryPreviewReason, string> = {
  empty: '这里还没有文稿',
  searching: '正在搜索正文…',
  'no-matches': '没有匹配的文稿',
  'search-incomplete': '搜索未完成',
  unavailable: '文稿暂时无法读取',
};
const compact = ref(window.matchMedia('(max-width: 639px)').matches);
const focus = ref(false);
const wideLibrary = ref(false);
const activePane = ref<Pane>('editor');
const collection = computed(() => collectionRoute(props.url));
const editorUrl = computed(() => collection.value ? first.value && new URL(first.value, props.url) : props.url);
const isBook = computed(() => /^\/projects\/[^/]+\/?$/.test(props.url.pathname));
const emptyAction = computed(() => {
  if (isBook.value) {
    const projectId = decodeURIComponent(props.url.pathname.split('/')[2]!);
    return { href: `/chapters/new?${new URLSearchParams({ projectId })}`, label: '新建章节' };
  }
  if (props.url.pathname === '/diaries') return { href: '/diaries/new', label: '写第一篇日记' };
  if (props.url.pathname === '/workspace') return { href: '/workspace?tab=continue', label: '开始写作' };
  return { href: '/projects/new', label: '新建作品' };
});
const listOnly = computed(() => collection.value && compact.value);
const query = window.matchMedia('(max-width: 639px)');
function sizeChanged() { compact.value = query.matches; }
onMounted(() => query.addEventListener('change', sizeChanged));
onBeforeUnmount(() => query.removeEventListener('change', sizeChanged));

function defaultPane(url: URL): Pane {
  if (/^\/(projects|create)\/?$/.test(url.pathname) && collectionRoute(url)) return 'library';
  return collectionRoute(url) ? 'sheets' : 'editor';
}
function setPane(pane: Pane) {
  activePane.value = pane;
  wideLibrary.value = pane === 'library';
  focus.value = false;
  const entry = { ...history.state, manuscriptPane: pane };
  if (pane !== history.state?.manuscriptPane) {
    if (compact.value) history.pushState(entry, '', location.href);
    else history.replaceState(entry, '', location.href);
  }
  void nextTick(() => {
    const target = root.value?.querySelector<HTMLElement>(pane === 'editor' ? '#main' : `.manuscript-${pane}`);
    target?.setAttribute('tabindex', '-1');
    target?.focus({ preventScroll: true });
  });
}

watch([() => props.url, compact], ([url], [previous]) => {
  if (url.href !== previous?.href) {
    first.value = undefined;
    emptyReason.value = undefined;
  }
  const saved = history.state?.manuscriptPane;
  activePane.value = ['library', 'sheets', 'editor'].includes(saved) ? saved : defaultPane(url);
  // Compact collections do not mount the preview reader. Normalize an editor
  // pane saved on a wider screen so resizing, Back and reload remain usable.
  if (compact.value && collectionRoute(url) && activePane.value === 'editor') {
    activePane.value = defaultPane(url);
    history.replaceState({ ...history.state, manuscriptPane: activePane.value }, '', location.href);
  }
  wideLibrary.value = activePane.value === 'library';
  if (collectionRoute(url)) focus.value = false;
}, { immediate: true });

function preview(href: string, reason?: LibraryPreviewReason) {
  first.value = href;
  emptyReason.value = reason;
}
function backToSheets() { setPane('sheets'); }
provide(manuscriptView, {
  focus, library: wideLibrary,
  toggleFocus: () => { focus.value = !focus.value; wideLibrary.value = false; },
  toggleLibrary: () => setPane(wideLibrary.value ? 'editor' : 'library'),
  showSheets: backToSheets,
});
function handleLinks(event: MouseEvent) {
  if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element && event.target.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.target || link.origin !== location.origin || !link.closest('.manuscript-library,.manuscript-sheets')) return;
  if (link.href === props.url.href) {
    event.preventDefault();
    setPane(link.closest('.manuscript-sheets') ? 'editor' : 'sheets');
  }
}
</script>

<template>
  <div ref="root" class="manuscript-frame" :data-pane="activePane" :class="{ 'ms-focus': focus, 'ms-library-open': wideLibrary }" @click="handleLinks">
    <LibraryPanels :url="url" @preview="preview" @navigate="emit('navigate', $event)" />
    <div v-if="activePane === 'sheets'" class="ms-sheets-bar">
      <button class="ms-tool" type="button" @click="setPane('library')"><AppIcon name="back" />资料库</button>
    </div>
    <main id="main" class="ms-editor" tabindex="-1">
      <nav class="ms-view-tools" aria-label="阅读视图">
        <ManuscriptViewControls />
      </nav>
      <slot v-if="editorUrl && !listOnly" :editor-url="editorUrl" />
      <section v-else-if="collection && !listOnly" class="ms-empty-editor">
        <AppIcon name="book" />
        <h1>{{ emptyReason ? previewTitles[emptyReason] : '正在打开文稿…' }}</h1>
        <div v-if="emptyReason === 'empty'">
          <a :href="emptyAction.href">{{ emptyAction.label }}</a>
        </div>
      </section>
    </main>
  </div>
</template>
