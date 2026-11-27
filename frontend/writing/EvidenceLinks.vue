<script setup lang="ts">
import type { Backlink } from './api.ts';
import { recordHref, version } from './api.ts';
defineProps<{ items: Backlink[] }>();
</script>
<template>
  <section v-if="items.length" class="wr-section">
    <h2>引用此记录的角色证据</h2>
    <ul class="wr-list"><li v-for="(item, index) in items" :key="index">
      <a :href="recordHref('characters', item.characterId, item.revision)">{{ item.name }} · {{ version(item.revision) }} · {{ item.label || '未命名条目' }}</a>
      <blockquote v-if="item.reference.excerpt" class="wr-prose">{{ item.reference.excerpt }}</blockquote>
    </li></ul>
  </section>
</template>
