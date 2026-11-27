<script setup lang="ts">
import { assetHref, referenceHref, resources } from './api';
import type { CharacterEntry } from './api';
defineProps<{ entries: CharacterEntry[]; contextualHref: (href: string) => string }>();
</script>

<template>
  <section v-if="entries.length" class="characters-section" aria-label="自定义条目">
    <h2>自定义条目</h2>
    <ol class="characters-entries">
      <li v-for="entry in entries" :key="entry.entryId" :id="`character-entry-${entry.entryId}`">
        <h3>{{ entry.label || '未命名条目' }}</h3>
        <ul class="characters-blocks"><li v-for="(block, index) in entry.blocks" :key="index">
          <div v-if="block.type === 'text'" class="characters-prose">{{ block.text }}</div>
          <template v-else-if="block.type === 'reference'">
            <a :href="contextualHref(referenceHref(block))">{{ resources[block.kind][1] }} · 第 {{ block.revision }} 版</a>
            <blockquote v-if="block.excerpt" class="characters-prose">{{ block.excerpt }}</blockquote>
          </template>
          <img v-else-if="block.type === 'image'" :src="assetHref(block.assetId)" :alt="entry.label || '图片'" loading="lazy">
          <audio v-else :src="assetHref(block.assetId)" controls preload="none" :aria-label="entry.label || '音频'" />
        </li></ul>
      </li>
    </ol>
  </section>
</template>
