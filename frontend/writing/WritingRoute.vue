<script setup lang="ts">
import { computed } from 'vue';
import { writingRoute } from './routes.ts';
import ScenePage from './ScenePage.vue';
import ComparePage from './ComparePage.vue';
import DraftPage from './DraftPage.vue';
import DraftEditor from './DraftEditor.vue';
import AdoptPage from './AdoptPage.vue';
import BranchPage from './BranchPage.vue';
import './writing.css';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const route = computed(() => writingRoute(props.url));
const view = computed(() => {
  if (route.value?.kind === 'scene') return { read: ScenePage, compare: ComparePage, branch: BranchPage }[route.value.page];
  if (route.value?.kind === 'draft') return { read: DraftPage, new: DraftEditor, revise: DraftEditor, adopt: AdoptPage }[route.value.page];
});
</script>
<template>
  <div class="writing-route">
    <component :is="view" v-if="view && route" :key="url.href" :url="url" :route="route" @navigate="emit('navigate', $event)" />
    <div v-else><h1>此地址尚未迁入写作页</h1><a href="/create">返回创作</a></div>
  </div>
</template>
