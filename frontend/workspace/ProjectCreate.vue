<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Project } from './api.ts';
import { retain, savedText, useSubmission } from './useSubmission.ts';

const emit = defineEmits<{ created: [project: Project] }>();
const title = ref(savedText('sth:creative-entry:project-title'));
const titleInput = ref<HTMLInputElement>();
const { pending, busy, error, submit } = useSubmission<Project>('sth:creative-entry:project-submit', 'project.create',
  value => typeof value.projectId === 'string' && Boolean(value.projectId), value => {
    retain('sth:creative-entry:project-title', '');
    emit('created', value);
  });
watch(title, value => retain('sth:creative-entry:project-title', value));

function create() {
  if (!pending.value && !title.value.trim()) {
    titleInput.value?.setCustomValidity('请填写作品名称。');
    titleInput.value?.reportValidity();
    return;
  }
  void submit({ title: title.value.trim() });
}
</script>

<template>
  <section class="ce-form-region" aria-labelledby="ce-new-title">
    <h2 id="ce-new-title">给作品起个名字</h2>
    <p class="ce-muted" id="ce-title-help">先保存名称，之后再写场景、整理章节。</p>
    <form action="/api/web/invoke" method="post" aria-labelledby="ce-new-title" @submit.prevent="create">
      <div class="ce-field">
        <label for="ce-project-title">作品名称（必填）</label>
        <input id="ce-project-title" ref="titleInput" v-model="title" name="title" required maxlength="300"
          aria-describedby="ce-title-help" enterkeyhint="done" :disabled="busy || !!pending"
          @input="titleInput?.setCustomValidity('')">
      </div>
      <p v-if="error" role="alert" class="ce-error">{{ error }}</p>
      <button class="ce-button ce-primary" type="submit" :disabled="busy">
        {{ busy ? '正在保存…' : pending ? '重试同一次提交' : '创建作品' }}
      </button>
    </form>
  </section>
</template>
