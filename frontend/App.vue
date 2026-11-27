<script setup lang="ts">
import { computed, defineAsyncComponent, defineComponent, h, nextTick, onBeforeUnmount, onErrorCaptured, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import HomePage from './HomePage.vue';
import LegacyRoute from './LegacyRoute.vue';
import { currentNavigation, routeLoader } from './routes.ts';
import bookMark from '../web/assets/book.svg';

const url = ref(new URL(location.href));
const refreshVersion = ref(0);
const main = ref<HTMLElement>();
const announcement = ref('');
const routeError = ref(false);
let announcementTimer: ReturnType<typeof setTimeout> | undefined;
let focusNextMount = false;
const destinations = [
  { href: '/diaries', name: '日记', icon: 'diary' },
  { href: '/create', name: '创作', icon: 'pen' },
  { href: '/characters', name: '角色', icon: 'people' },
  { href: '/sources', name: '资料', icon: 'book' },
  { href: '/jobs', name: '任务', icon: 'tasks' },
];
const active = computed(() => currentNavigation(url.value));
const isHome = computed(() => url.value.pathname === '/' && !url.value.searchParams.has('projectId'));
const loading = defineComponent({ setup: () => () => h('p', { class: 'loading', role: 'status' }, '正在打开…') });
const route = computed(() => {
  if (isHome.value) return HomePage;
  const loader = routeLoader(url.value);
  return loader ? defineAsyncComponent({ loader, loadingComponent: loading, delay: 100, timeout: 15_000 }) : LegacyRoute;
});

async function updateRoute(focus = true) {
  focusNextMount = focus;
  routeError.value = false;
  url.value = new URL(location.href);
  if (isHome.value) document.title = '首页 · Sth';
  await nextTick();
  if (focus) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const target = main.value?.querySelector<HTMLElement>('h1') ?? main.value;
    target?.setAttribute('tabindex', '-1');
    target?.focus({ preventScroll: true });
  }
}

function focusPage() {
  if (!focusNextMount) return;
  const heading = main.value?.querySelector<HTMLElement>('h1');
  if (!heading) return;
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  focusNextMount = false;
}

function navigate(href: string, replace = false) {
  const destination = new URL(href, location.href);
  if (destination.origin !== location.origin || !['http:', 'https:'].includes(destination.protocol)) return;
  if (destination.href === location.href) return;
  if (replace) history.replaceState(null, '', destination);
  else history.pushState(null, '', destination);
  void updateRoute();
}

function refresh() {
  refreshVersion.value++;
  void updateRoute();
}

function onClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || anchor.target || anchor.hasAttribute('download') || anchor.relList.contains('external')) return;
  const destination = new URL(anchor.href);
  if (destination.origin !== location.origin || destination.hash || /^\/(api|assets|vue|frontend)(\/|$)/.test(destination.pathname)) return;
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
function onPopstate() { void updateRoute(); }

window.addEventListener('popstate', onPopstate);
onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopstate);
  clearTimeout(announcementTimer);
});
onErrorCaptured(() => {
  routeError.value = true;
  document.title = '页面暂时无法打开 · Sth';
  return false;
});
</script>

<template>
  <div class="sth-app" @click="onClick" @sth:replace="onReplace" @sth:announce="onAnnounce">
    <a class="skip-link" href="#main">跳到正文</a>
    <div class="shell sth-shell">
      <header class="sidebar sth-sidebar">
        <a class="brand" href="/" aria-label="Sth 首页" :aria-current="isHome ? 'page' : undefined">
          <span class="brand-mark"><img :src="bookMark" width="24" height="24" alt=""></span>
          <span>Sth</span>
        </a>
        <nav id="navigation" aria-label="主导航">
          <a v-for="item in destinations" :key="item.href" :href="item.href" :aria-current="active === item.href ? 'page' : undefined">
            <AppIcon :name="item.icon" /><span>{{ item.name }}</span>
          </a>
        </nav>
        <nav id="settings-navigation" aria-label="应用设置">
          <a href="/settings" :aria-current="active === '/settings' ? 'page' : undefined"><AppIcon name="settings" /><span>设置</span></a>
        </nav>
      </header>
      <main id="main" ref="main" tabindex="-1" :class="{ 'sth-home-main': isHome }">
        <div v-if="routeError" class="sth-route-error">
          <h1 tabindex="-1">页面暂时无法打开</h1>
          <p role="alert">页面加载失败，请重试。</p>
          <button type="button" class="button primary" @click="refresh">重试</button>
          <a href="/" class="button quiet">返回首页</a>
        </div>
        <component :is="route" v-else :key="url.href + ':' + refreshVersion" :url="url" @navigate="navigate" @refresh="refresh" @vue:mounted="focusPage" />
      </main>
    </div>
    <div id="announcement" class="toast" role="status" aria-atomic="true">{{ announcement }}</div>
  </div>
</template>
