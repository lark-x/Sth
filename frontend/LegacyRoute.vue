<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { RouteEvents, RouteProps } from './routes.ts';

const props = defineProps<RouteProps>();
const emit = defineEmits<RouteEvents>();
const host = ref<HTMLElement>();
let controller: AbortController | undefined;
const entry = '/assets/app.js';

watch(() => [host.value, props.url.href] as const, async ([element]) => {
  controller?.abort();
  if (!element) return;
  controller = new AbortController();
  const { signal } = controller;
  const legacy = await import(/* @vite-ignore */ entry);
  if (signal.aborted) return;
  await legacy.mountLegacyRoute({
    main: element, url: props.url, signal, focus: true,
    navigate: (href: string, options?: { replace?: boolean }) => {
      if (signal.aborted) return;
      // Legacy writes used replacement navigation to leave completed forms out
      // of history. The shell accepts this as a DOM navigation request.
      if (options?.replace) element.dispatchEvent(new CustomEvent('sth:replace', { bubbles: true, detail: href }));
      else emit('navigate', href);
    },
    announce: (message: string) => element.dispatchEvent(new CustomEvent('sth:announce', { bubbles: true, detail: message })),
    refresh: () => emit('refresh'),
  });
}, { flush: 'post', immediate: true });

onBeforeUnmount(() => controller?.abort());
</script>

<template><div ref="host" class="legacy-route" /></template>
