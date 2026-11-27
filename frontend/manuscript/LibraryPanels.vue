<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import type { Directive } from 'vue';
import AppIcon from '../AppIcon.vue';
import bookMark from '../../web/assets/book.svg';
import { all, href, message, recordHref } from '../workspace/api.ts';
import { retain, savedText } from '../workspace/useSubmission.ts';
import { ApiError } from '../api.ts';
import { writingRoute } from '../writing/routes.ts';
import {
  chapterOrder, draftSheetContent, isAdoptedDraft, isLibraryCollection, libraryCollectionHref, libraryCollectionTitle, librarySheetHref, loadCandidateSummary, loadLibrarySheets, matchesSheet, orderedSheets, projectShelfHref,
  resolveLibraryContext, shelfKey, unplacedShelfHref,
} from './library-data.ts';
import type { LibraryChapter, LibraryContext, LibrarySheet, Project, RecentManuscript } from './library-data.ts';
import { recentManuscripts } from './recent.ts';
import './library-panels.css';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; preview: [href: string] }>();
const id = useId();
const sheetsPanel = ref<HTMLElement>();
const searchInput = ref<HTMLInputElement>();
const projects = shallowRef<Project[]>([]);
const chapters = shallowRef<LibraryChapter[]>([]);
const sheets = shallowRef<LibrarySheet[]>([]);
const context = shallowRef<LibraryContext>({ shelf: 'recent' });
const expanded = ref(new Set<string>());
const treeBusy = ref(false);
const busy = ref(false);
const treeError = ref('');
const chaptersUnavailable = ref(false);
const error = ref('');
const listIncomplete = ref(false);
const query = ref('');
const selectedId = ref<string>();
const announcement = ref('');
let treeController: AbortController | undefined;
let controller: AbortController | undefined;
let countTimer: ReturnType<typeof setTimeout> | undefined;
let loadedShelf: string | undefined;
let lastPreview: string | undefined;
let treeLoad: Promise<void> = Promise.resolve();
const intersecting = new Set<string>();
const activeCandidates = new Set<string>();
const observed = new Set<Element>();
const previewViewport = window.matchMedia('(min-width: 640px)');
const sheetObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const key = (entry.target as HTMLElement).dataset.sheetKey;
    if (!key || !observed.has(entry.target)) continue;
    if (entry.isIntersecting) intersecting.add(key);
    else intersecting.delete(key);
  }
  readCandidates();
});
const vTrackSheet: Directive<HTMLElement> = {
  mounted(element) {
    observed.add(element);
    sheetObserver.observe(element);
  },
  beforeUnmount(element) {
    observed.delete(element);
    sheetObserver.unobserve(element);
    intersecting.delete(element.dataset.sheetKey!);
  },
};
const allScope = computed(() => context.value.shelf === 'project' && !context.value.projectId);
const allScopeHref = computed(() => /^\/(create|projects)\/?$/.test(props.url.pathname) && !props.url.search
  ? props.url.pathname : context.value.allPath ?? '/projects');
const activeProjectId = computed(() => context.value.projectId);
const activeProject = computed(() => projects.value.find(project => project.projectId === activeProjectId.value));
const activeChapter = computed(() => chapters.value.find(chapter => chapter.chapterId === context.value.chapterId));
const collectionTitle = computed(() => libraryCollectionTitle(props.url, projects.value, chapters.value));
function updateCollectionTitle() {
  if (collectionTitle.value && document.title !== collectionTitle.value) document.title = collectionTitle.value;
}
// Preview readers also set document.title after their asynchronous loads. The
// collection owns the tab until an author actually opens a manuscript URL.
const titleObserver = new MutationObserver(updateCollectionTitle);
watch(collectionTitle, value => {
  titleObserver.disconnect();
  if (!value) return;
  updateCollectionTitle();
  const titleElement = document.querySelector('title');
  if (titleElement) titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
}, { immediate: true });
const searching = computed(() => Boolean(query.value.trim()));
const incomplete = computed(() => listIncomplete.value || sheets.value.some(sheet => sheet.unavailable));
const chapterSearchIncomplete = computed(() => chaptersUnavailable.value && sheets.value.some(sheet => sheet.chapterId));
const searchIncomplete = computed(() => incomplete.value || chapterSearchIncomplete.value);
const sortedSheets = computed(() => orderedSheets(sheets.value, context.value, chapters.value));
const visibleSheets = computed(() => searching.value
  ? sortedSheets.value.filter(sheet => matchesSheet(sheet, query.value, chapters.value)) : sortedSheets.value);
const unsearched = computed(() => {
  if (!searching.value) return new Set<string>();
  const matches = new Set(visibleSheets.value.map(sheet => sheet.key));
  return new Set(sortedSheets.value.filter(sheet => sheet.needsCandidate && !matches.has(sheet.key)).map(sheet => sheet.key));
});
const searchPending = computed(() => unsearched.value.size > 0);
const selectedSheet = computed(() => visibleSheets.value.find(sheet => sheet.id === selectedId.value)
  ?? (isLibraryCollection(props.url) ? visibleSheets.value[0] : undefined));
const managementReturn = computed(() => isLibraryCollection(props.url)
  ? libraryCollectionHref(context.value, selectedSheet.value?.id) ?? `${props.url.pathname}${props.url.search}${props.url.hash}`
  : `${props.url.pathname}${props.url.search}${props.url.hash}`);
const title = computed(() => context.value.shelf === 'recent' ? '最近写过'
  : context.value.shelf === 'diaries' ? '日记'
    : context.value.shelf === 'unplaced' ? '未编入章节' : activeChapter.value?.title ?? activeProject.value?.title ?? '全部文稿');
const subtitle = computed(() => context.value.shelf === 'recent' ? '按最近编辑排序'
  : context.value.shelf === 'diaries' ? '按日记日期排序'
    : context.value.shelf === 'unplaced' ? '全工作区的独立场景'
      : context.value.chapterId ? activeProject.value?.title ?? '按章节顺序'
        : activeProject.value ? '按章节顺序' : '按作品与章节顺序');
const count = computed(() => {
  const unit = context.value.shelf === 'diaries' ? '篇日记' : context.value.shelf === 'recent' ? '篇文稿' : '幕';
  if (!searching.value) return `${sheets.value.length} ${unit}`;
  if (searchPending.value || searchIncomplete.value) {
    const status = searchPending.value ? '正在搜索正文…' : '搜索未完成';
    return visibleSheets.value.length ? `已找到 ${visibleSheets.value.length} ${unit} · ${status}` : status;
  }
  return `${visibleSheets.value.length} / ${sheets.value.length} ${unit}`;
});
const footerCount = computed(() => busy.value ? '正在读取…' : error.value ? '读取未完成' : count.value);
const emptyText = computed(() => context.value.shelf === 'recent' ? '打开一篇日记或文稿后，可以从这里接着写。'
  : context.value.shelf === 'diaries' ? '写下今天的一句话，开始第一篇日记。'
    : context.value.shelf === 'unplaced' ? '尚未编入章节的场景会显示在这里。'
      : context.value.chapterId ? '这个章节还没有场景。' : '作品还没有编入章节的场景。');
const createLink = computed(() => context.value.shelf === 'diaries' ? '/diaries/new'
  : context.value.shelf === 'recent' ? '/workspace?tab=continue'
    : activeProjectId.value ? href('/scenes/new', {
      projectId: activeProjectId.value, chapterId: context.value.chapterId,
      returnTo: libraryCollectionHref(context.value, selectedSheet.value?.id) ?? managementReturn.value,
    }) : '/scenes/new');
const createLabel = computed(() => context.value.shelf === 'diaries' ? '写日记'
  : context.value.shelf === 'recent' ? '开始写作' : '新建场景');

function projectChapters(projectId: string) {
  return chapterOrder(chapters.value.filter(chapter => chapter.projectId === projectId));
}
function chapterCount(projectId: string) {
  return chapters.value.filter(chapter => chapter.projectId === projectId).reduce((sum, chapter) => sum + chapter.sceneCount, 0);
}
function toggleProject(projectId: string, open = !expanded.value.has(projectId)) {
  const next = new Set(expanded.value);
  if (open) next.add(projectId);
  else next.delete(projectId);
  expanded.value = next;
}
watch(activeProjectId, projectId => { if (projectId) toggleProject(projectId, true); });

function loadTree() {
  // Share the in-flight read so navigation cannot cancel another shelf's refresh.
  if (treeBusy.value) return treeLoad;
  const request = new AbortController();
  treeController = request;
  treeBusy.value = true;
  treeError.value = '';
  treeLoad = Promise.allSettled([
    all<Project>('project.list', {}, request.signal),
    all<LibraryChapter>('chapter.list', {}, request.signal),
  ]).then(results => {
    if (request.signal.aborted) return;
    if (results[0].status === 'fulfilled') projects.value = results[0].value;
    if (results[1].status === 'fulfilled') chapters.value = results[1].value;
    chaptersUnavailable.value = results[1].status === 'rejected';
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') treeError.value = message(failure.reason);
    treeBusy.value = false;
  });
  return treeLoad;
}

function treeContains(next: LibraryContext) {
  return (!next.projectId || projects.value.some(project => project.projectId === next.projectId))
    && (!next.chapterId || chapters.value.some(chapter => chapter.chapterId === next.chapterId && chapter.projectId === next.projectId));
}

function selectionStorageKey(next: LibraryContext) { return `sth:library:selection:${shelfKey(next)}`; }
function rememberSelection(sheet: LibrarySheet) {
  selectedId.value = sheet.id;
  if (libraryCollectionHref(context.value)) retain(selectionStorageKey(context.value), sheet.id);
}

async function loadSheets() {
  controller?.abort();
  activeCandidates.clear();
  const request = new AbortController();
  controller = request;
  const url = new URL(props.url.href);
  busy.value = true;
  error.value = '';
  listIncomplete.value = false;
  try {
    const [next] = await Promise.all([resolveLibraryContext(url, request.signal), treeLoad]);
    if (request.signal.aborted) return;
    // Creation can leave this mounted component's tree stale. Refresh once before
    // treating a cache miss as absence, and never validate against a failed read.
    if (!treeContains(next)) {
      await loadTree();
      if (request.signal.aborted) return;
      if (treeError.value) throw new ApiError(503, 'library_tree_unavailable', treeError.value);
    }
    if (!treeError.value && next.projectId && !projects.value.some(project => project.projectId === next.projectId)) {
      throw new ApiError(404, 'project_not_found', '找不到这部作品。');
    }
    if (!treeError.value && next.chapterId && !chapters.value.some(chapter => chapter.chapterId === next.chapterId && chapter.projectId === next.projectId)) {
      throw new ApiError(404, 'chapter_not_found', '找不到这个章节。');
    }
    const key = shelfKey(next);
    if (loadedShelf !== key) {
      query.value = '';
      sheets.value = [];
      sheetsPanel.value?.querySelector('.library-sheet-scroll')?.scrollTo({ top: 0 });
    }
    context.value = next;
    const recent: RecentManuscript[] = next.shelf === 'recent' ? recentManuscripts() : [];
    const result = await loadLibrarySheets(next, recent, url, request.signal);
    if (request.signal.aborted) return;
    const remembered = next.sceneId ?? next.noteId ?? next.selectedSceneId
      ?? (loadedShelf === key ? selectedId.value : undefined)
      ?? (libraryCollectionHref(next) ? savedText(selectionStorageKey(next)) : undefined);
    selectedId.value = remembered;
    sheets.value = result.items;
    listIncomplete.value = result.incomplete;
    loadedShelf = key;
    const selection = selectedSheet.value;
    if (selection) rememberSelection(selection);
    if (selectedId.value) {
      await nextTick();
      if (!request.signal.aborted) sheetsPanel.value?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
    }
  } catch (reason) {
    if (!request.signal.aborted) {
      sheets.value = [];
      loadedShelf = undefined;
      error.value = message(reason);
    }
  } finally {
    if (!request.signal.aborted) {
      busy.value = false;
      publishPreview();
    }
  }
}

function readCandidates() {
  const request = controller;
  if (!request || request.signal.aborted || busy.value || error.value || activeCandidates.size >= 4) return;
  const previewKey = previewViewport.matches && isLibraryCollection(props.url) ? selectedSheet.value?.key : undefined;
  const pending = sortedSheets.value.filter(sheet => sheet.needsCandidate && !activeCandidates.has(sheet.key));
  const priority = (sheet: LibrarySheet) => sheet.key === previewKey || intersecting.has(sheet.key);
  const queue = [...pending.filter(priority), ...pending.filter(sheet => unsearched.value.has(sheet.key) && !priority(sheet))];
  for (const sheet of queue.slice(0, 4 - activeCandidates.size)) {
    activeCandidates.add(sheet.key);
    void loadCandidateSummary(sheet, request.signal).then(result => {
      if (!request.signal.aborted) sheets.value = sheets.value.map(item => item.key === result.key ? result : item);
    }, () => {}).finally(() => {
      if (request.signal.aborted) return;
      activeCandidates.delete(sheet.key);
      readCandidates();
    });
  }
}

function publishPreview() {
  if (busy.value || !isLibraryCollection(props.url)) return;
  const selection = selectedSheet.value;
  if (selection?.needsCandidate && !searching.value) return;
  const first = error.value || !selection || selection.needsCandidate ? '' : sheetHref(selection);
  const key = `${props.url.href}\n${first}`;
  if (lastPreview === key) return;
  lastPreview = key;
  emit('preview', first);
}

function navigate(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
  const destination = new URL(anchor.href, props.url);
  if (destination.origin !== props.url.origin || !['http:', 'https:'].includes(destination.protocol)) return;
  if (destination.href === props.url.href) return;
  event.preventDefault();
  emit('navigate', `${destination.pathname}${destination.search}${destination.hash}`);
}

function selected(sheet: LibrarySheet) {
  return !error.value && selectedSheet.value?.key === sheet.key;
}
function sheetHref(sheet: LibrarySheet) {
  const current = sheet.kind === 'diary' ? context.value.noteId : context.value.sceneId;
  return !isLibraryCollection(props.url) && sheet.id === current ? `${props.url.pathname}${props.url.search}${props.url.hash}`
    : librarySheetHref(sheet, context.value, props.url);
}
const currentDraftContent = computed(() => {
  const adopted = context.value.scene?.adopted;
  const draft = context.value.draft;
  if (draft) return draftSheetContent(draft, isAdoptedDraft(draft, adopted));
  if (adopted) return draftSheetContent(adopted, true);
});
function currentContent(sheet: LibrarySheet) {
  return sheet.kind === 'scene' && sheet.id === context.value.sceneId ? currentDraftContent.value ?? sheet : sheet;
}
const sheetChapters = computed(() => new Map(chapters.value.map(chapter => [chapter.chapterId, chapter.title])));
function sheetLinks() {
  return Array.from(sheetsPanel.value?.querySelectorAll<HTMLAnchorElement>('a.library-sheet') ?? []);
}
function focusSheet(last = false) {
  const links = sheetLinks();
  const target = last ? links.at(-1) : links.find(link => link.getAttribute('aria-current') === 'page') ?? links[0];
  target?.focus();
}
function listKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
  const links = sheetLinks();
  const index = links.indexOf(event.target as HTMLAnchorElement);
  if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
    : Math.max(0, Math.min(links.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  links[next]?.focus();
}
function panelKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing
    && !target.closest('input, textarea, select, [contenteditable="true"]')) {
    event.preventDefault();
    searchInput.value?.focus();
  }
}
async function clearSearch() {
  query.value = '';
  await nextTick();
  searchInput.value?.focus();
}
function refresh() { void loadTree(); void loadSheets(); }
function manuscriptsChanged() {
  const route = writingRoute(props.url);
  if (context.value.shelf === 'recent'
    || (route?.kind === 'draft' && route.page === 'read' && !props.url.searchParams.has('revision'))) void loadSheets();
}
void loadTree();
watch(() => props.url.href, () => { lastPreview = undefined; void loadSheets(); }, { immediate: true });
watch([query, busy, chapters], readCandidates, { flush: 'post' });
watch([query, chapters, selectedSheet], publishPreview, { flush: 'post' });
watch(footerCount, text => {
  clearTimeout(countTimer);
  announcement.value = '';
  countTimer = setTimeout(() => { announcement.value = text; }, 250);
});
onMounted(() => {
  previewViewport.addEventListener('change', readCandidates);
  window.addEventListener('focus', refresh);
  window.addEventListener('sth:manuscripts-changed', manuscriptsChanged);
});
onScopeDispose(() => {
  titleObserver.disconnect();
  sheetObserver.disconnect();
  treeController?.abort();
  controller?.abort();
  clearTimeout(countTimer);
  previewViewport.removeEventListener('change', readCandidates);
  window.removeEventListener('focus', refresh);
  window.removeEventListener('sth:manuscripts-changed', manuscriptsChanged);
});
</script>

<template>
  <aside class="manuscript-library" aria-label="资料库" @click="navigate" @keydown="panelKeydown">
    <header class="library-heading">
      <a class="library-brand" href="/" aria-label="Sth 首页"><span class="library-brand-mark"><img :src="bookMark" width="20" height="20" alt=""></span><span>Sth</span></a>
      <button class="library-icon-button" type="button" aria-label="刷新资料库和文稿" :disabled="treeBusy || busy" @click="refresh">
        <AppIcon name="refresh" />
      </button>
    </header>
    <div class="library-scroll">
      <nav class="library-primary" aria-label="文稿资料库">
        <a class="library-link" href="/workspace?tab=recent" :aria-current="context.shelf === 'recent' ? 'page' : undefined">
          <svg class="library-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg>
          <span>最近写过</span>
        </a>
        <a class="library-link" href="/diaries" :aria-current="context.shelf === 'diaries' ? 'page' : undefined">
          <AppIcon name="diary" /><span>日记</span>
        </a>
        <a class="library-link" :href="allScopeHref" :aria-current="allScope ? 'page' : undefined">
          <AppIcon name="book" /><span>全部文稿</span>
        </a>
      </nav>
      <div class="library-section-heading">
        <h3>作品</h3>
        <a class="library-icon-button" href="/projects/new" aria-label="新建作品"><AppIcon name="plus" /></a>
      </div>
      <p v-if="treeBusy && !projects.length" class="library-state" role="status">正在读取作品…</p>
      <div v-if="treeError" class="library-state library-error" role="alert">
        <p>{{ treeError }}</p>
        <button type="button" class="library-text-button" :disabled="treeBusy" @click="loadTree">重新读取资料库</button>
      </div>
      <nav aria-label="作品与章节" :aria-busy="treeBusy">
        <ul class="library-projects">
          <li v-for="project in projects" :key="project.projectId">
            <div class="library-project-row" :data-active="activeProjectId === project.projectId || undefined">
              <button class="library-toggle" type="button" :aria-label="`${expanded.has(project.projectId) ? '收起' : '展开'}${project.title}`"
                :aria-expanded="expanded.has(project.projectId)" :aria-controls="`${id}-project-${project.projectId}`"
                @click="toggleProject(project.projectId)" @keydown.right.prevent="toggleProject(project.projectId, true)" @keydown.left.prevent="toggleProject(project.projectId, false)">
                <svg class="library-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
              </button>
              <a class="library-link library-project-link" :href="projectShelfHref(project.projectId)"
                :aria-current="context.shelf === 'project' && !context.chapterId && !context.section && activeProjectId === project.projectId ? 'page' : undefined">
                <AppIcon name="book" /><span>{{ project.title }}</span>
                <span v-if="!treeBusy && !treeError" class="library-count" :aria-label="`${chapterCount(project.projectId)} 幕`">{{ chapterCount(project.projectId) }}</span>
              </a>
            </div>
            <ul :id="`${id}-project-${project.projectId}`" class="library-children" :hidden="!expanded.has(project.projectId)">
              <li v-for="chapter in projectChapters(project.projectId)" :key="chapter.chapterId">
                <a class="library-link library-chapter-link" :href="projectShelfHref(project.projectId, chapter.chapterId)"
                  :aria-current="context.shelf === 'project' && !context.section && context.chapterId === chapter.chapterId ? 'page' : undefined">
                  <span>{{ chapter.title }}</span><span class="library-count" :aria-label="`${chapter.sceneCount} 幕`">{{ chapter.sceneCount }}</span>
                </a>
              </li>
              <li><a class="library-link library-chapter-link" :href="unplacedShelfHref(project.projectId)"
                :aria-current="context.shelf === 'unplaced' && activeProjectId === project.projectId ? 'page' : undefined"><span>未编入章节</span></a></li>
              <li class="library-related-start"><a class="library-link library-related" :href="href('/characters', { projectId: project.projectId })"
                :aria-current="context.section === 'characters' && activeProjectId === project.projectId ? 'page' : undefined"><AppIcon name="people" /><span>作品角色</span></a></li>
              <li><a class="library-link library-related" :href="href('/sources', { projectId: project.projectId })"
                :aria-current="context.section === 'sources' && activeProjectId === project.projectId ? 'page' : undefined"><AppIcon name="book" /><span>作品资料</span></a></li>
            </ul>
          </li>
        </ul>
      </nav>
      <p v-if="!treeBusy && !treeError && !projects.length" class="library-state">还没有作品。<a href="/projects/new">新建作品</a></p>
    </div>
    <nav class="library-footer" aria-label="工作区工具">
      <a class="library-link" href="/jobs" :aria-current="/^\/jobs(?:\/|$)/.test(url.pathname) ? 'page' : undefined"><AppIcon name="tasks" /><span>任务</span></a>
      <a class="library-link" href="/settings" :aria-current="/^\/settings(?:\/|$)/.test(url.pathname) ? 'page' : undefined"><AppIcon name="settings" /><span>设置</span></a>
    </nav>
  </aside>

  <section ref="sheetsPanel" class="manuscript-sheets" :aria-labelledby="`${id}-sheets-title`" @click="navigate" @keydown="panelKeydown">
    <header class="library-sheets-heading">
      <h2 :id="`${id}-sheets-title`">{{ title }}</h2>
      <p>{{ subtitle }}</p>
      <nav v-if="activeProject" class="library-project-actions" aria-label="作品管理">
        <a :href="href(recordHref('projects', activeProject.projectId), { view: 'overview', returnTo: managementReturn })">作品总览</a>
        <a :href="href('/chapters', { projectId: activeProject.projectId, returnTo: managementReturn })">编排章节</a>
        <a :href="href('/author-context', { projectId: activeProject.projectId, returnTo: managementReturn })">创作决定</a>
      </nav>
      <form class="library-search" role="search" aria-label="搜索当前分组" @submit.prevent="focusSheet()">
        <label :for="`${id}-search`">搜索文稿</label>
        <div class="library-search-field">
          <input :id="`${id}-search`" ref="searchInput" v-model="query" type="search" placeholder="标题、正文或章节" autocomplete="off"
            :aria-controls="`${id}-sheets`" @keydown.down.prevent="focusSheet()" @keydown.esc.prevent="clearSearch">
        </div>
      </form>
    </header>
    <div class="library-sheet-scroll" :aria-busy="busy">
      <p v-if="busy && !sheets.length" class="library-state" role="status">正在读取文稿…</p>
      <div v-if="error" class="library-state library-error" role="alert">
        <p>{{ error }}</p><button type="button" class="library-text-button" :disabled="busy" @click="loadSheets">重新读取文稿</button>
      </div>
      <div v-if="incomplete" class="library-state library-warning" role="status">
        <p>部分摘要暂时无法读取，仍可打开文稿。</p>
        <button type="button" class="library-text-button" :disabled="busy" @click="loadSheets">重试摘要</button>
      </div>
      <div v-if="searching && chapterSearchIncomplete" class="library-state library-warning">
        <p>部分章节名称暂时无法读取。</p>
        <button type="button" class="library-text-button" :disabled="treeBusy" @click="loadTree">重试章节</button>
      </div>
      <ul :id="`${id}-sheets`" class="library-sheet-list" aria-label="文稿" @keydown="listKeydown">
        <li v-for="sheet in visibleSheets" :key="sheet.key" v-track-sheet :data-sheet-key="sheet.key">
          <a class="library-sheet" :href="sheetHref(sheet)" :aria-current="selected(sheet) ? 'page' : undefined" @click="rememberSelection(sheet)">
            <span class="library-sheet-title">{{ sheet.title }}</span>
            <span class="library-sheet-preview" :class="{ 'library-preview-empty': !currentContent(sheet).preview }">{{ currentContent(sheet).preview }}</span>
            <span class="library-sheet-meta">
              <time v-if="sheet.diaryDate" :datetime="sheet.diaryDate">{{ sheet.diaryDate }}</time>
              <span v-else-if="sheet.chapterId">{{ sheetChapters.get(sheet.chapterId) }}</span>
              <span v-if="!sheet.diaryDate" :class="{ 'library-sheet-status': sheet.chapterId }">{{ currentContent(sheet).status }}</span>
            </span>
          </a>
        </li>
      </ul>
      <div v-if="!busy && !error && !visibleSheets.length" class="library-empty">
        <p v-if="searchPending" role="status">正在搜索正文…</p>
        <p v-else-if="searching && searchIncomplete">{{ incomplete ? '搜索未完成，部分正文无法读取。' : '搜索未完成。' }}</p>
        <template v-else-if="searching">
          <h3>没有匹配的文稿</h3><p>试试其他标题、正文片段或章节名。</p>
          <button type="button" class="library-text-button" @click="clearSearch">清除搜索</button>
        </template>
        <template v-else>
          <h3>{{ context.shelf === 'recent' ? '从下一次动笔开始' : '这里还没有文稿' }}</h3><p>{{ emptyText }}</p>
          <a class="library-empty-action" :href="createLink">{{ createLabel }}<AppIcon name="plus" /></a>
          <template v-if="context.shelf === 'project' && activeProjectId">
            <a href="/workspace?tab=continue">继续写</a>
            <a :href="href('/chapters/new', { projectId: activeProjectId })">新建章节</a>
          </template>
        </template>
      </div>
    </div>
    <footer class="library-sheets-footer">
      <span>{{ footerCount }}</span>
      <a :href="createLink">{{ createLabel }}<AppIcon name="plus" /></a>
      <span class="library-sr-only" role="status" aria-atomic="true">{{ announcement }}</span>
    </footer>
  </section>
</template>
