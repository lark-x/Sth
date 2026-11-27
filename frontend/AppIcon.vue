<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string[]> = {
  panels: ['M3 4h18v16H3z', 'M9 4v16'],
  library: ['M4 4v16m4-16v16m4-16v16', 'm15 5 4-1 3 15-4 1z'],
  diary: ['M8 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V9', 'M2 7h4M2 12h4M2 17h4', 'm12 8 6-6 4 4-6 6-5 1z'],
  pen: ['m4 16-1 5 5-1L21 7l-4-4z', 'm14 6 4 4'],
  people: ['M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2', 'M20 21v-2a4 4 0 0 0-3-3.9', 'M12.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0', 'M16 3.5a3.5 3.5 0 0 1 0 7'],
  book: ['M4 3h16v18H4z', 'M4 17h16'],
  tasks: ['m3 6 2 2 3-4', 'M12 6h9', 'm3 13 2 2 3-4', 'M12 13h9', 'M12 20h9'],
  settings: ['M3 6h5m4 0h9M3 18h9m4 0h5M8 3v6m8 6v6', 'M3 12h18'],
  arrow: ['M5 12h14', 'm14 7 5 5-5 5'],
  next: ['M5 12h14', 'm14 7 5 5-5 5'],
  back: ['M19 12H5', 'm10 7-5 5 5 5'],
  plus: ['M12 5v14', 'M5 12h14'],
  refresh: ['M20 7v5h-5', 'M19 16a8 8 0 1 1 .6-8.4L20 12'],
};
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path v-for="(path, index) in paths[name] ?? paths.arrow" :key="index" :d="path" />
  </svg>
</template>
