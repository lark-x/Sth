<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { href, read, recordHref, requiredId, revisionParam, version } from './api.ts';
import type { Draft, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { retain, stored, useMutation, useRead } from './state.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
const props = defineProps<{ route: WritingRoute; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const editing = props.route.page === 'revise';
const draftId = 'id' in props.route ? props.route.id : '';
const key = `sth:writing:editor:${editing ? draftId : props.url.search}`;
const initial = stored<{ title: string; body: string; expectedRevision?: number; sceneRevision?: number }>(key);
const form = reactive({ title: '', body: '', expectedRevision: undefined as number | undefined, sceneRevision: undefined as number | undefined });
const initialized = ref(false);
const latest = ref<Draft>();
const conflictReadError = ref('');
const { state: save, submit } = useMutation<Draft>(`${key}:call`, editing ? 'draft.revise' : 'draft.create', 'draftId', result => {
  retain(key);
  emit('navigate', recordHref('drafts', result.draftId));
});
const { data, busy, error, reload } = useRead(async signal => {
  revisionParam(props.url.searchParams);
  const draft = editing ? await read<Draft>('draft.read', { draftId }, signal) : undefined;
  const sceneId = draft?.sceneId ?? requiredId(props.url.searchParams.get('sceneId'));
  const pending = save.pending?.input;
  const sceneRevision = pending?.sceneRevision ?? initial?.sceneRevision ?? draft?.sceneRevision ?? revisionParam(props.url.searchParams);
  const scene = await read<Scene>('scene.read', { sceneId, revision: sceneRevision }, signal);
  if (!initialized.value) {
    form.title = String(pending?.title ?? initial?.title ?? draft?.title ?? '');
    form.body = String(pending?.body ?? initial?.body ?? draft?.body ?? '');
    form.expectedRevision = Number(pending?.expectedRevision ?? initial?.expectedRevision ?? draft?.revision) || undefined;
    form.sceneRevision = scene.revision;
    if (draft && !save.pending && form.expectedRevision !== draft.revision) { latest.value = draft; save.conflict = true; save.error = '稿件已有更新。核对最新版本后再保存你的文字。'; }
    initialized.value = true;
  }
  document.title = `${editing ? '修订候选稿' : '新建候选稿'} · Sth`;
  return { scene, draft };
});
watch(form, () => { if (initialized.value) retain(key, { ...form }); });
async function loadLatest() {
  conflictReadError.value = '';
  try { latest.value = await read<Draft>('draft.read', { draftId }, AbortSignal.timeout(15_000)); }
  catch { conflictReadError.value = '最新版本读取失败，请重试。'; }
}
function useLatest() {
  if (!latest.value) return;
  form.expectedRevision = latest.value.revision;
  save.conflict = false;
  save.error = '';
  latest.value = undefined;
}
function saveDraft(event: Event) {
  if (!data.value) return;
  const element = event.currentTarget as HTMLFormElement;
  const title = element.elements.namedItem('title') as HTMLInputElement;
  const body = element.elements.namedItem('body') as HTMLTextAreaElement;
  title.setCustomValidity(form.title.trim() ? '' : '请输入稿件标题。');
  body.setCustomValidity(form.body.trim() ? '' : '请输入稿件正文。');
  if (!element.reportValidity()) return;
  void submit(editing ? { draftId, expectedRevision: form.expectedRevision, title: form.title.trim(), body: form.body }
    : { sceneId: data.value.scene.sceneId, sceneRevision: form.sceneRevision, title: form.title.trim(), body: form.body });
}
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && !busy && !error">
    <header class="wr-heading"><a :href="editing ? recordHref('drafts', draftId) : recordHref('scenes', data.scene.sceneId)">返回{{ editing ? '候选稿' : data.scene.title }}</a><h1>{{ editing ? '修订候选稿' : '新建候选稿' }}</h1><p class="wr-muted">{{ data.scene.title }} · 场景上下文 {{ version(data.scene.revision) }}</p></header>
    <div class="wr-reading-layout">
      <form class="wr-editor" aria-label="编辑候选稿" action="/api/web/invoke" method="post" @submit.prevent="saveDraft">
        <label for="wr-title">标题</label><input id="wr-title" v-model="form.title" name="title" required maxlength="300" :readonly="save.busy || !!save.pending" @input="($event.target as HTMLInputElement).setCustomValidity('')">
        <label for="wr-body">正文</label><textarea id="wr-body" v-model="form.body" name="body" required maxlength="100000" rows="20" :readonly="save.busy || !!save.pending" @input="($event.target as HTMLTextAreaElement).setCustomValidity('')" />
        <p class="wr-muted">保存的稿件可继续修订，随后可对照并选择采用。</p>
        <p v-if="save.error" role="alert" class="wr-notice">{{ save.error }}</p>
        <div v-if="save.conflict" class="wr-conflict">
          <button type="button" class="wr-button" @click="loadLatest">读取最新版本</button>
          <p v-if="conflictReadError" role="alert">{{ conflictReadError }}</p>
          <section v-if="latest"><h2>最新稿件 · {{ version(latest.revision) }}</h2><h3>{{ latest.title }}</h3><p class="wr-prose">{{ latest.body }}</p><button type="button" class="wr-button" @click="useLatest">保留我的文字，以此版本继续修订</button></section>
        </div>
        <div class="wr-actions"><button type="submit" class="wr-button wr-primary" :disabled="save.busy || save.conflict">{{ save.busy ? '正在保存…' : save.pending ? '重试同一次提交' : editing ? '保存修订' : '新建候选稿' }}</button><a :href="href(recordHref('scenes', data.scene.sceneId), { action: 'compare' })">返回对照</a></div>
      </form>
      <aside><SceneContext :scene="data.scene" /></aside>
    </div>
  </template>
</template>
