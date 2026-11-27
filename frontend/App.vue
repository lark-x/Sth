<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onErrorCaptured, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import RouteDocument from './RouteDocument.vue';
import { characterRoute } from './characters/routes.ts';
import ManuscriptFrame from './manuscript/ManuscriptFrame.vue';
import { manuscriptRoute } from './manuscript/routes.ts';
import { readingPosition, restoreReadingPosition } from './navigation-state.ts';
import type { ReadingPosition } from './navigation-state.ts';
import { currentNavigation } from './routes.ts';
import { sourceRoute } from './sources/routes.ts';
import { writingRoute } from './writing/routes.ts';
import bookMark from '../web/assets/book.svg';

const url = ref(new URL(location.href));
const refreshVersion = ref(0);
const announcement = ref('');
const routeError = ref(false);
const libraryNavigation = ref<HTMLDialogElement>();
const navigationOpen = ref(false);
const phoneNavigation = window.matchMedia('(width < 640px)');
let navigationPosition: { top: number; left: number } | undefined;
const returnToManuscript = ref<string | undefined>(history.state?.sthManuscriptReturn);
let announcementTimer: ReturnType<typeof setTimeout> | undefined;
let focusNextMount = false;
let evidencePosition: ReadingPosition | undefined;
let cancelReadingRestore: (() => void) | undefined;
let routeChange = 0;
let returning = false;
const destinations = [
  { href: '/diaries', name: '日记', icon: 'diary' },
  { href: '/create', name: '创作', icon: 'pen' },
  { href: '/characters', name: '角色', icon: 'people' },
  { href: '/sources', name: '资料', icon: 'book' },
  { href: '/jobs', name: '任务', icon: 'tasks' },
];
const active = computed(() => currentNavigation(url.value));
const isHome = computed(() => url.value.pathname === '/' && !url.value.searchParams.has('projectId'));
const workbench = computed(() => manuscriptRoute(url.value));
const navigationTitle = computed(() => isHome.value ? '首页' : active.value === '/settings' ? '设置'
  : destinations.find(item => item.href === active.value)?.name ?? 'Sth');

function openNavigation(event: MouseEvent) {
  // Safari does not focus buttons on pointer activation. Give the native dialog
  // the same focused invoker for pointer and keyboard focus restoration.
  (event.currentTarget as HTMLButtonElement).focus({ preventScroll: true });
  navigationPosition = { top: window.scrollY, left: window.scrollX };
  libraryNavigation.value?.showModal();
  navigationOpen.value = Boolean(libraryNavigation.value?.open);
}

function closeNavigation() {
  libraryNavigation.value?.close();
  navigationClosed();
}

function navigationClosed() {
  navigationOpen.value = Boolean(libraryNavigation.value?.open);
  if (navigationOpen.value || !navigationPosition) return;
  // WebKit can scroll the page behind a full-height modal despite containment.
  window.scrollTo({ ...navigationPosition, behavior: 'instant' });
  navigationPosition = undefined;
}

function selectNavigation(event: MouseEvent) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (event.target instanceof Element && event.target.closest('a[href]')) closeNavigation();
}

function resizeNavigation() {
  if (!phoneNavigation.matches) closeNavigation();
}

watch(url, closeNavigation);
onMounted(() => phoneNavigation.addEventListener('change', resizeNavigation));
onBeforeUnmount(() => phoneNavigation.removeEventListener('change', resizeNavigation));

function visibleContent() {
  const main = document.getElementById('main');
  if (main?.getClientRects().length) return main;
  return Array.from(document.querySelectorAll<HTMLElement>('.manuscript-library, .manuscript-sheets'))
    .find(pane => pane.getClientRects().length > 0);
}

function skipToContent(event: MouseEvent) {
  const target = visibleContent();
  if (!target || target.id === 'main') return;
  event.preventDefault();
  target.setAttribute('tabindex', '-1');
  target.focus();
}

async function updateRoute(position?: ReadingPosition) {
  const change = ++routeChange;
  cancelReadingRestore?.();
  cancelReadingRestore = undefined;
  evidencePosition = undefined;
  returning = false;
  returnToManuscript.value = history.state?.sthManuscriptReturn;
  focusNextMount = !position;
  routeError.value = false;
  url.value = new URL(location.href);
  if (isHome.value) document.title = '首页 · Sth';
  await nextTick();
  if (change !== routeChange) return;
  const main = visibleContent();
  if (position && main?.id === 'main') {
    cancelReadingRestore = restoreReadingPosition(position, main);
    return;
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  const target = main?.querySelector<HTMLElement>('h1, h2') ?? main;
  target?.setAttribute('tabindex', '-1');
  target?.focus({ preventScroll: true });
}

function focusPage() {
  if (!focusNextMount) return;
  const heading = visibleContent()?.querySelector<HTMLElement>('h1, h2');
  if (!heading) return;
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  focusNextMount = false;
}

function navigate(href: string, replace = false) {
  const destination = new URL(href, location.href);
  if (destination.origin !== location.origin || !['http:', 'https:'].includes(destination.protocol)) return;
  if (destination.href === location.href) return;
  if (!replace && destination.href === returnToManuscript.value) {
    if (!returning) history.back();
    returning = true;
    return;
  }
  if (replace) {
    let state = history.state;
    if (state?.sthManuscriptPosition || state?.sthManuscriptReturn) {
      state = { ...state };
      delete state.sthManuscriptPosition;
      delete state.sthManuscriptReturn;
    }
    history.replaceState(state, '', destination);
  } else {
    const auxiliary = characterRoute(destination)?.page === 'detail' || sourceRoute(destination)?.page === 'detail';
    const position = auxiliary && writingRoute(url.value)?.page === 'read'
      ? evidencePosition ?? readingPosition() : undefined;
    if (position) history.replaceState({ ...history.state, sthManuscriptPosition: position }, '');
    history.pushState(position ? { sthManuscriptReturn: position.href } : null, '', destination);
  }
  void updateRoute();
}

function refresh() {
  refreshVersion.value++;
  void updateRoute();
}

function rememberEvidencePosition(event: Event) {
  if (event.type === 'click' && !(event.target instanceof Element &&
    event.target.closest('.evidence-trigger[aria-expanded="false"]'))) return;
  evidencePosition = readingPosition();
}

function evidenceStateChanged(event: Event) {
  if (!(event as CustomEvent<{ open: boolean }>).detail?.open) evidencePosition = undefined;
}

function onClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || anchor.target || anchor.hasAttribute('download') || anchor.relList.contains('external')) return;
  const destination = new URL(anchor.href);
  if (destination.origin !== location.origin || (destination.hash && destination.href !== returnToManuscript.value) ||
    /^\/(api|assets|vue|frontend)(\/|$)/.test(destination.pathname)) return;
  event.preventDefault();
  navigate(destination.href);
}

function announce(message: string) {
  clearTimeout(announcementTimer);
  announcement.value = message;
  announcementTimer = setTimeout(() => { announcement.value = ''; }, 4200);
}

function onReplace(event: Event) { navigate((event as CustomEvent<string>).detail, true); }
function onAnnounce(event: Event) { announce((event as CustomEvent<string>).detail); }
function onPopstate(event: PopStateEvent) {
  const position: ReadingPosition | undefined = event.state?.sthManuscriptPosition;
  void updateRoute(position?.href === location.href ? position : undefined);
}

window.addEventListener('popstate', onPopstate);
onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopstate);
  clearTimeout(announcementTimer);
  routeChange++;
  cancelReadingRestore?.();
});
onErrorCaptured(() => {
  cancelReadingRestore?.();
  routeError.value = true;
  document.title = '页面暂时无法打开 · Sth';
  return false;
});
</script>

<template>
  <div class="sth-app" @click.capture="rememberEvidencePosition" @click="onClick" @sth:open-evidence.capture="rememberEvidencePosition"
    @sth:evidence-state="evidenceStateChanged" @sth:replace="onReplace" @sth:announce="onAnnounce">
    <a class="skip-link" href="#main" @click="skipToContent">跳到正文</a>
    <ManuscriptFrame v-if="workbench && !routeError" :url="url" @navigate="navigate" v-slot="{ editorUrl }">
      <RouteDocument :key="editorUrl.href + ':' + refreshVersion" :url="editorUrl" @navigate="navigate" @refresh="refresh" @ready="focusPage" />
    </ManuscriptFrame>
    <div v-else class="shell sth-shell">
      <header class="sth-mobile-toolbar" aria-label="全局导航">
        <button type="button" class="sth-library-toggle" aria-label="打开资料库导航" aria-controls="library-navigation"
          :aria-expanded="navigationOpen" @click="openNavigation"><AppIcon name="panels" /></button>
        <a href="/" class="sth-mobile-brand" aria-label="Sth 首页" :aria-current="isHome ? 'page' : undefined">Sth</a>
        <span class="sth-mobile-location">{{ navigationTitle }}</span>
      </header>
      <header class="sidebar sth-sidebar">
        <a class="brand" href="/" aria-label="Sth 首页" :aria-current="isHome ? 'page' : undefined">
          <span class="brand-mark"><img :src="bookMark" width="24" height="24" alt=""></span>
          <span>Sth</span>
        </a>
        <nav id="navigation" aria-label="主导航">
          <a v-for="item in destinations" :key="item.href" :href="item.href" :class="{ 'sth-navigation-task': item.href === '/jobs' }" :aria-current="active === item.href ? 'page' : undefined">
            <AppIcon :name="item.icon" /><span>{{ item.name }}</span>
          </a>
        </nav>
        <nav id="settings-navigation" aria-label="应用设置">
          <a href="/settings" :aria-current="active === '/settings' ? 'page' : undefined"><AppIcon name="settings" /><span>设置</span></a>
        </nav>
      </header>
      <dialog id="library-navigation" ref="libraryNavigation" class="sth-mobile-navigation" aria-labelledby="library-navigation-title"
        @close="navigationClosed" @click.capture="selectNavigation">
        <header class="sth-navigation-heading">
          <h1 id="library-navigation-title">资料库</h1>
          <form method="dialog"><button type="submit" class="button quiet" autofocus>关闭</button></form>
        </header>
        <nav aria-label="主导航">
          <a href="/" :aria-current="isHome ? 'page' : undefined"><AppIcon name="library" /><span>首页</span></a>
          <a v-for="item in destinations" :key="item.href" :href="item.href" :class="{ 'sth-navigation-task': item.href === '/jobs' }" :aria-current="active === item.href ? 'page' : undefined">
            <AppIcon :name="item.icon" /><span>{{ item.name }}</span>
          </a>
        </nav>
        <nav class="sth-navigation-secondary" aria-label="应用设置">
          <a href="/settings" :aria-current="active === '/settings' ? 'page' : undefined"><AppIcon name="settings" /><span>设置</span></a>
        </nav>
      </dialog>
      <main id="main" tabindex="-1" :class="{ 'sth-home-main': isHome }">
        <a v-if="returnToManuscript" :href="returnToManuscript" class="button quiet"><AppIcon name="back" />返回原稿</a>
        <div v-if="routeError" class="sth-route-error">
          <h1 tabindex="-1">页面暂时无法打开</h1>
          <p role="alert">页面加载失败，请重试。</p>
          <button type="button" class="button primary" @click="refresh">重试</button>
          <a href="/" class="button quiet">返回首页</a>
        </div>
        <RouteDocument v-else :key="url.href + ':' + refreshVersion" :url="url" @navigate="navigate" @refresh="refresh" @ready="focusPage" />
      </main>
    </div>
    <div id="announcement" class="toast" role="status" aria-atomic="true">{{ announcement }}</div>
  </div>
</template>
