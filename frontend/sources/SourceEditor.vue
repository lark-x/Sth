<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { errorText, href, kinds, read, step } from './api';
import type { Project, Source } from './api';
import { copy, dirty, forgetDraft, getDraft, persistDraft, valuesFor } from './drafts';
import type { SourceValues } from './drafts';
import { useDraftWrite } from './useDraftWrite';

const props = defineProps<{ source?: Source; projects: Project[]; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const key = props.source ? `revise:${props.source.sourceId}` : `new:${props.url.searchParams.get('projectId') ?? ''}`;
const blank: SourceValues = { kind: 'setting', title: '', body: '', origin: '',
  projectIds: props.url.searchParams.get('projectId') ? [props.url.searchParams.get('projectId')!] : [] };
const draft = getDraft(key, props.source ? valuesFor(props.source) : blank, props.source);
const form = ref<HTMLFormElement>();
const latest = ref<Source>();
const latestError = ref('');
const latestLoading = ref(false);
const controller = new AbortController();
const changed = computed(() => dirty(draft));
const projectOptions = computed(() => [
  ...props.projects,
  ...draft.values.projectIds.filter(id => !props.projects.some(item => item.projectId === id)).map(projectId => ({ projectId, title: projectId })),
]);
async function showLatest() {
  if (!props.source) return;
  latestLoading.value = true;
  latestError.value = '';
  try { latest.value = await read<Source>('source.read', { sourceId: props.source.sourceId }, controller.signal); }
  catch (reason) { if (!controller.signal.aborted) latestError.value = errorText(reason); }
  finally { latestLoading.value = false; }
}
const { locked, save } = useDraftWrite(key, draft, path => emit('navigate', path), showLatest);
function applyLatest(replace: boolean) {
  if (!latest.value) return;
  draft.base = copy(latest.value);
  draft.initial = valuesFor(latest.value);
  if (replace) draft.values = valuesFor(latest.value);
  draft.conflict = false;
  draft.error = '';
  persistDraft(key, draft);
}
function discard() {
  if (locked.value) return;
  draft.values = copy(draft.initial);
  draft.error = '';
}
function clearValidity() {
  for (const control of form.value?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ?? []) control.setCustomValidity('');
}
function submit() {
  if (!draft.call) {
    for (const name of ['title', 'body']) {
      const control = form.value?.elements.namedItem(name) as HTMLInputElement | null;
      if (!draft.values[name as 'title' | 'body'].trim()) control?.setCustomValidity('请填写非空白内容。');
    }
    if (!form.value?.reportValidity()) return;
    if (draft.values.projectIds.length > 50) { draft.error = '最多关联 50 个项目。'; return; }
  }
  void save<Source>(() => {
    const values = copy(draft.values);
    return props.source ? step('source.revise', { ...values, sourceId: props.source.sourceId,
      expectedRevision: draft.base!.revision, origin: values.origin.trim() ? values.origin : null }) :
      step('source.create', { ...values, origin: values.origin.trim() ? values.origin : undefined });
  }, result => href(result.sourceId));
}
onMounted(() => {
  if (draft.conflict) void showLatest();
});
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <div v-if="draft.saved" role="status">资料已保存。<a :href="draft.saved" @click="forgetDraft(key)">查看已保存资料</a></div>
  <form v-else id="editor" ref="form" class="sources-editor" :aria-label="source ? '修订资料' : '新建资料'" @submit.prevent="submit" @input="clearValidity">
    <fieldset :disabled="locked"><legend class="sources-sr-only">资料内容</legend>
      <div class="sources-field"><label for="source-kind">类型</label><select id="source-kind" v-model="draft.values.kind" name="kind" required><option v-for="(label, value) in kinds" :key="value" :value="value">{{ label }}</option></select></div>
      <div class="sources-field"><label for="source-title">标题</label><input id="source-title" v-model="draft.values.title" name="title" maxlength="300" required autocomplete="off"></div>
      <div class="sources-field"><label for="source-body">正文</label><textarea id="source-body" v-model="draft.values.body" name="body" maxlength="100000" rows="12" required /></div>
      <div class="sources-field"><label for="source-origin">出处</label><textarea id="source-origin" v-model="draft.values.origin" name="origin" maxlength="4000" rows="2" /></div>
      <fieldset class="sources-projects"><legend>关联项目</legend><p v-if="!projectOptions.length" class="sources-muted">个人资料</p>
        <label v-for="project in projectOptions" :key="project.projectId" class="sources-check"><input v-model="draft.values.projectIds" type="checkbox" name="projectIds" :value="project.projectId">{{ project.title }}</label>
      </fieldset>
    </fieldset>
    <p v-if="draft.error" id="save-error" role="alert">{{ draft.error }}</p>
    <section v-if="draft.conflict" class="sources-conflict" aria-label="版本冲突"><h2>这条资料已有新版</h2><p>本地草稿基于第 {{ draft.base?.revision }} 版。请核对最新内容后继续。</p>
      <p v-if="latestLoading" role="status">正在读取最新版本…</p>
      <template v-else-if="latest"><h3>最新版本 · 第 {{ latest.revision }} 版 · {{ latest.title }}</h3><div class="sources-prose">{{ latest.body }}</div>
        <p class="sources-muted">{{ kinds[latest.kind] }} · {{ latest.origin || '未填写出处' }} · 关联项目 {{ latest.projectIds.map(id => projectOptions.find(project => project.projectId === id)?.title ?? id).join('、') || '个人资料' }}</p>
        <div class="sources-actions"><button class="sources-button" type="button" @click="applyLatest(false)">保留我的修改并采用新版</button><button class="sources-button" type="button" @click="applyLatest(true)">改用最新版</button></div>
      </template>
      <div v-else><p role="alert">{{ latestError }}</p><button class="sources-button" type="button" @click="showLatest">重新读取最新版</button></div>
    </section>
    <div class="sources-actions"><button class="sources-button sources-primary" type="submit" :disabled="draft.busy || draft.conflict">{{ draft.busy ? '正在保存…' : draft.call ? '重试同一次提交' : source ? '保存修订' : '新建资料' }}</button>
      <a :href="source ? href(source.sourceId) : '/sources'">返回</a><button v-if="changed && !locked" class="sources-button" type="button" @click="discard">清除草稿</button></div>
    <p class="sources-muted" role="status">{{ draft.call ? '正在确认同一次提交的结果，内容已保留。' : changed ? '有未保存的修改' : '标题和正文为必填项。' }}</p>
  </form>
</template>
