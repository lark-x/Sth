<script setup lang="ts">
defineProps<{ busy: boolean; error: string }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <p v-if="busy" role="status" class="wr-muted">正在读取写作内容…</p>
  <div v-else-if="error" class="wr-notice">
    <p role="alert">{{ error }}</p>
    <button type="button" class="wr-button" @click="$emit('retry')">重试读取</button>
    <a href="/create">返回创作</a>
  </div>
</template>
