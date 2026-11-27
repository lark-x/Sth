<script setup lang="ts">
import { inject } from 'vue';
import AppIcon from '../AppIcon.vue';
import { manuscriptView } from './view.ts';
const view = inject(manuscriptView, undefined);
</script>
<template>
  <span v-if="view" class="ms-view-controls">
    <button class="ms-tool ms-wide-focus" type="button" :aria-pressed="view.focus.value" :aria-label="view.focus.value ? '显示目录' : '专注阅读'" :title="view.focus.value ? '显示目录' : '专注阅读'" @click="view.toggleFocus"><AppIcon name="panels" /></button>
    <button class="ms-tool ms-tablet-library" type="button" aria-label="资料库" title="资料库" :aria-expanded="view.library.value" @click="view.toggleLibrary"><AppIcon name="library" /></button>
    <button class="ms-tool ms-phone-sheets" type="button" aria-label="返回文稿列表" title="返回文稿列表" @click="view.showSheets"><AppIcon name="back" /></button>
  </span>
</template>
