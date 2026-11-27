<script setup lang="ts">
import { computed } from 'vue';
import DiaryIndex from './DiaryIndex.vue';
import DiaryPage from './DiaryPage.vue';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const isIndex = computed(() => ['/', '/diaries', '/diaries/'].includes(props.url.pathname));
</script>

<template>
  <DiaryIndex v-if="isIndex" :url="url" @navigate="emit('navigate', $event)" @refresh="emit('refresh')" />
  <DiaryPage v-else :url="url" @navigate="emit('navigate', $event)" @refresh="emit('refresh')" />
</template>
