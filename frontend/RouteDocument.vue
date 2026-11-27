<script setup lang="ts">
import { computed, defineAsyncComponent, defineComponent, h } from 'vue';
import type { Component } from 'vue';
import HomePage from './HomePage.vue';
import LegacyRoute from './LegacyRoute.vue';
import { routeLoader } from './routes.ts';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: []; ready: [] }>();
const loading = defineComponent({ setup: () => () => h('p', { class: 'loading', role: 'status' }, '正在打开…') });
const route = computed<Component>(() => {
  if (props.url.pathname === '/' && !props.url.searchParams.has('projectId')) return HomePage;
  const loader = routeLoader(props.url);
  return loader ? defineAsyncComponent({ loader, loadingComponent: loading, delay: 100, timeout: 15_000 }) : LegacyRoute;
});
</script>
<template>
  <component :is="route" :url="url" @navigate="emit('navigate', $event)" @refresh="emit('refresh')" @vue:mounted="emit('ready')" />
</template>
