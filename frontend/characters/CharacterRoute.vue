<script setup lang="ts">
import { computed } from 'vue';
import CharacterIndex from './CharacterIndex.vue';
import CharacterPage from './CharacterPage.vue';
import { characterRoute } from './routes';
import './characters.css';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const route = computed(() => characterRoute(props.url));

function linkClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
  const destination = new URL(anchor.href, props.url);
  if (destination.origin !== props.url.origin || destination.hash || !['http:', 'https:'].includes(destination.protocol)) return;
  event.preventDefault();
  emit('navigate', `${destination.pathname}${destination.search}`);
}
</script>

<template>
  <div class="characters-route" @click="linkClick">
    <CharacterIndex v-if="route?.page === 'index'" :url="url" @navigate="emit('navigate', $event)" />
    <CharacterPage v-else-if="route" :url="url" :character-id="route.page === 'detail' ? route.characterId : undefined"
      @navigate="emit('navigate', $event)" @refresh="emit('refresh')" />
    <section v-else><h1 tabindex="-1">找不到角色页面</h1><a href="/characters">返回角色</a></section>
  </div>
</template>
