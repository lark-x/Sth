<script setup lang="ts">
import { computed } from 'vue';
import SourcesIndex from './SourcesIndex.vue';
import SourcePage from './SourcePage.vue';
import { sourceRoute } from './routes';
import './sources.css';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const route = computed(() => sourceRoute(props.url));
function onClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || anchor.target || anchor.hasAttribute('download') || anchor.relList.contains('external')) return;
  const destination = new URL(anchor.href);
  if (destination.origin !== location.origin || destination.hash || /^\/(api|assets|frontend)(\/|$)/.test(destination.pathname)) return;
  event.preventDefault();
  emit('navigate', destination.pathname + destination.search);
}
</script>

<template>
  <div class="sources-domain" @click="onClick">
    <SourcesIndex v-if="route?.page === 'index'" :key="url.href" :url="url" @navigate="emit('navigate', $event)" />
    <SourcePage v-else-if="route" :key="url.href" :url="url" :route="route" @navigate="emit('navigate', $event)" />
  </div>
</template>
