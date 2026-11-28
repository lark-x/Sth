<script setup lang="ts">
import Button from '../ui/Button.vue';
defineProps<{ busy: boolean; error: string }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <p v-if="busy" role="status" class="wr-muted wr-read-status">正在读取写作内容…</p>
  <div v-else-if="error" class="wr-notice wr-read-error">
    <p role="alert">{{ error }}</p>
    <Button type="button" variant="outline" class="wr-button" @click="$emit('retry')">重试读取</Button>
    <a href="/create">返回创作</a>
  </div>
</template>
