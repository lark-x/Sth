<script setup lang="ts">
import WorkspaceRoute from './WorkspaceRoute.vue';
defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
</script>

<template>
  <WorkspaceRoute :url="url" @navigate="emit('navigate', $event)" @refresh="emit('refresh')" />
</template>
