<script setup lang="ts">
import {
  computed,
  nextTick,
  onScopeDispose,
  reactive,
  ref,
  useId,
  watch,
} from 'vue';
import {
  href,
  read,
  recordHref,
  requiredId,
  revisionParam,
  version,
} from './api.ts';
import type { Draft, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { retain, stored, useMutation, useRead } from './state.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
import { passageRange } from './reading.ts';
import type { PassageRange } from './reading.ts';
import { rememberManuscript } from '../manuscript/recent.ts';
const props = defineProps<{
  route: WritingRoute;
  url: URL;
  inline?: boolean;
  draft?: Draft;
  scene?: Scene;
  selection?: PassageRange;
}>();
const emit = defineEmits<{
  navigate: [href: string];
  saved: [draft: Draft];
  cancel: [];
}>();
const editing = props.inline || props.route.page === 'revise';
const draftId =
  props.draft?.draftId ?? ('id' in props.route ? props.route.id : '');
const returnTo = props.inline && /^\/scenes\//.test(props.url.pathname)
  ? props.url.pathname + props.url.search + props.url.hash
  : props.url.searchParams.get('returnTo');
// A revision-pinned editor has its own recovery buffer. Opening an old source
// must never replace an unfinished edit of the current manuscript.
let pinned = props.draft?.revision;
try {
  pinned ??= revisionParam(props.url.searchParams);
} catch {
  /* The loader reports invalid version links. */
}
const recoveryRevision =
  props.inline &&
  /^\/drafts\//.test(props.url.pathname) &&
  !props.url.searchParams.has('revision')
    ? undefined
    : pinned;
const key = `sth:writing:editor:${editing ? draftId + (recoveryRevision ? `@${recoveryRevision}` : '') : props.url.search}`;
const initial = stored<{
  title: string;
  body: string;
  expectedRevision?: number;
  sceneRevision?: number;
  cursor?: number;
}>(key);
const form = reactive({
  title: '',
  body: '',
  expectedRevision: undefined as number | undefined,
  sceneRevision: undefined as number | undefined,
});
const bodyInput = ref<HTMLTextAreaElement>();
const saveButton = ref<HTMLButtonElement>();
const saveNotice = ref<HTMLElement>();
const formId = useId();
const changed = computed(
  () =>
    form.title !== (data.value?.draft?.title ?? '') ||
    form.body !== (data.value?.draft?.body ?? ''),
);
const initialized = ref(false);
const latest = ref<Draft>();
const conflictReadError = ref('');
let latestRead: AbortController | undefined;
let completed = false;
onScopeDispose(() => latestRead?.abort());
const { state: save, submit } = useMutation<Draft>(
  `${key}:call`,
  editing ? 'draft.revise' : 'draft.create',
  'draftId',
  (result) => {
    completed = true;
    retain(key);
    if (props.inline) emit('saved', result);
    else {
      const destination = href(recordHref('drafts', result.draftId), { returnTo });
      rememberManuscript({
        kind: 'draft', id: result.draftId, href: destination,
        title: result.title, sceneId: result.sceneId,
      });
      emit('navigate', destination);
    }
  },
);
const { data, busy, error, reload } = useRead(async (signal) => {
  revisionParam(props.url.searchParams);
  const current = editing
    ? await read<Draft>('draft.read', { draftId }, signal)
    : undefined;
  const draft =
    props.draft ??
    (current && pinned
      ? await read<Draft>('draft.read', { draftId, revision: pinned }, signal)
      : current);
  const sceneId =
    draft?.sceneId ?? requiredId(props.url.searchParams.get('sceneId'));
  const pending = save.pending?.input;
  const sceneRevision =
    pending?.sceneRevision ??
    initial?.sceneRevision ??
    draft?.sceneRevision ??
    revisionParam(props.url.searchParams);
  const scene = await read<Scene>(
    'scene.read',
    { sceneId, revision: sceneRevision },
    signal,
  );
  if (!initialized.value) {
    form.title = String(pending?.title ?? initial?.title ?? draft?.title ?? '');
    form.body = String(pending?.body ?? initial?.body ?? draft?.body ?? '');
    form.expectedRevision =
      Number(
        pending?.expectedRevision ??
          initial?.expectedRevision ??
          draft?.revision,
      ) || undefined;
    form.sceneRevision = scene.revision;
    if (
      current &&
      !save.pending &&
      form.expectedRevision !== current.revision
    ) {
      latest.value = current;
      save.conflict = true;
      save.error = '稿件已有更新。核对最新版本后再保存你的文字。';
    }
    initialized.value = true;
  }
  if (!signal.aborted && !props.inline)
    document.title = `${editing ? '修订候选稿' : '新建候选稿'} · Sth`;
  if (!signal.aborted && draft && props.url.pathname === location.pathname)
    rememberManuscript({
      kind: 'draft', id: draft.draftId,
      href: href(recordHref('drafts', draft.draftId), {
        revision: recoveryRevision, returnTo,
        start: props.url.searchParams.get('start'),
        end: props.url.searchParams.get('end'),
      }),
      title: draft.title, sceneId: draft.sceneId,
    });
  return { scene, draft };
});
function retainForm() {
  if (initialized.value && !completed)
    retain(key, { ...form, cursor: bodyInput.value?.selectionStart });
}
watch(form, retainForm, { flush: 'sync' });
onScopeDispose(retainForm);
let resizeObserver: ResizeObserver | undefined;
let resizeFrame = 0;
let bodyWidth = 0;
watch(bodyInput, (textarea) => {
  resizeObserver?.disconnect();
  cancelAnimationFrame(resizeFrame);
  if (!props.inline || !textarea) return;
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry && Math.abs(entry.contentRect.width - bodyWidth) > 1) {
      bodyWidth = entry.contentRect.width;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fitBody);
    }
  });
  resizeObserver.observe(textarea);
});
onScopeDispose(() => {
  resizeObserver?.disconnect();
  cancelAnimationFrame(resizeFrame);
});
function fitBody() {
  const textarea = bodyInput.value;
  if (!props.inline || !textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}
function focusBody() {
  const textarea = bodyInput.value;
  if (!textarea) return;
  fitBody();
  const selection = props.selection ?? passageRange(props.url.searchParams, form.body.length);
  const start = selection?.start ?? initial?.cursor ?? 0;
  const end = selection?.end ?? start;
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(
    Math.min(start, form.body.length),
    Math.min(end, form.body.length),
  );
  if (!start) return;
  const mirror = document.createElement('div');
  const style = getComputedStyle(textarea);
  for (const property of [
    'font',
    'line-height',
    'letter-spacing',
    'padding',
    'border',
    'box-sizing',
    'overflow-wrap',
    'tab-size',
  ]) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    whiteSpace: 'pre-wrap',
    width: `${textarea.getBoundingClientRect().width}px`,
  });
  mirror.textContent = form.body.slice(0, start);
  const cursor = document.createElement('span');
  cursor.textContent = form.body.slice(start, start + 1) || '\u200b';
  mirror.append(cursor);
  document.body.append(mirror);
  const offset = cursor.offsetTop;
  mirror.remove();
  if (props.inline)
    window.scrollBy({
      top: textarea.getBoundingClientRect().top + offset - 150,
      behavior: 'instant',
    });
  else textarea.scrollTop = Math.max(0, offset - textarea.clientHeight / 3);
}
watch(busy, async (value) => {
  if (!value && !error.value) {
    await nextTick();
    if (save.pending) {
      fitBody();
      saveButton.value?.focus({ preventScroll: true });
      saveButton.value?.scrollIntoView({ block: 'center', behavior: 'instant' });
    } else if (!save.conflict) focusBody();
  }
});
watch(
  () => save.error,
  async (value) => {
    if (!value) return;
    await nextTick();
    saveNotice.value?.scrollIntoView({ block: 'center', behavior: 'instant' });
  },
);
defineExpose({
  requestSave: () =>
    (
      document.getElementById(formId) as HTMLFormElement | null
    )?.requestSubmit(),
  saving: computed(() => save.busy || save.conflict),
  saveBusy: computed(() => save.busy),
});
async function loadLatest() {
  latestRead?.abort();
  const active = (latestRead = new AbortController());
  conflictReadError.value = '';
  try {
    const result = await read<Draft>('draft.read', { draftId }, active.signal);
    if (!active.signal.aborted) latest.value = result;
  } catch {
    if (!active.signal.aborted)
      conflictReadError.value = '最新版本读取失败，请重试。';
  }
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
  void submit(
    editing
      ? {
          draftId,
          expectedRevision: form.expectedRevision,
          sceneRevision: form.sceneRevision,
          title: form.title.trim(),
          body: form.body,
        }
      : {
          sceneId: data.value.scene.sceneId,
          sceneRevision: form.sceneRevision,
          title: form.title.trim(),
          body: form.body,
        },
  );
}
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && !busy && !error">
    <header v-if="!inline" class="wr-heading">
      <a
        :href="
          editing
            ? href(recordHref('drafts', draftId), { revision: pinned, returnTo })
            : recordHref('scenes', data.scene.sceneId)
        "
        >返回{{ editing ? '候选稿' : data.scene.title }}</a
      >
      <h1>{{ editing ? '修订候选稿' : '新建候选稿' }}</h1>
      <p class="wr-muted">
        {{ data.scene.title }} · 场景上下文 {{ version(data.scene.revision) }}
      </p>
    </header>
    <div :class="inline ? 'wr-inline-editor' : 'wr-reading-layout'">
      <form
        :id="formId"
        class="wr-editor"
        aria-label="编辑候选稿"
        action="/api/web/invoke"
        method="post"
        @submit.prevent="saveDraft"
      >
        <div class="wr-editor-save">
          <button
            ref="saveButton"
            type="submit"
            class="wr-button wr-primary wr-editor-submit"
            :aria-busy="save.busy"
            :disabled="save.busy || save.conflict"
          >
            <span>{{
              save.busy
                ? '正在保存…'
                : save.pending
                  ? '重试同一次提交'
                  : editing
                    ? '保存修订'
                    : '新建候选稿'
            }}</span>
          </button><button
            v-if="inline"
            type="button"
            class="wr-tool"
            @click="emit('cancel')"
          >
            返回阅读
          </button>
        </div>
        <p v-if="save.error" ref="saveNotice" role="alert" class="wr-notice wr-editor-save-error">
          {{ save.error }}
        </p>
        <p class="wr-muted" role="status">
          {{
            initial || changed
              ? '未保存文字保留在本标签页'
              : '保存为候选稿，采用需另行确认'
          }}
        </p>
        <div v-if="save.conflict" class="wr-conflict">
          <button type="button" class="wr-button" @click="loadLatest">
            读取最新版本
          </button>
          <p v-if="conflictReadError" role="alert">{{ conflictReadError }}</p>
          <section v-if="latest">
            <h2>最新稿件 · {{ version(latest.revision) }}</h2>
            <h3>{{ latest.title }}</h3>
            <p class="wr-prose wr-conflict-preview">{{ latest.body }}</p>
            <button type="button" class="wr-button" @click="useLatest">
              保留我的文字，以此版本继续修订
            </button>
          </section>
        </div>
        <label :for="`${formId}-title`">标题</label
        ><input
          :id="`${formId}-title`"
          v-model="form.title"
          name="title"
          required
          maxlength="300"
          :readonly="save.busy || !!save.pending"
          @input="($event.target as HTMLInputElement).setCustomValidity('')"
        />
        <p v-if="pinned && data.draft" class="wr-muted">
          以{{ version(data.draft.revision) }}为底稿 · 场景上下文
          {{ version(data.scene.revision) }}
        </p>
        <label :for="`${formId}-body`">正文</label
        ><textarea
          :id="`${formId}-body`"
          ref="bodyInput"
          v-model="form.body"
          :class="{ 'wr-edit-prose': inline }"
          name="body"
          required
          maxlength="100000"
          :rows="inline ? 4 : 20"
          :readonly="save.busy || !!save.pending"
          @input="
            ($event.target as HTMLTextAreaElement).setCustomValidity('');
            fitBody();
          "
          @select="retainForm"
        />
        <div class="wr-actions">
          <a
            :href="
              href(recordHref('scenes', data.scene.sceneId), {
                action: 'compare',
              })
            "
            >返回对照</a
          >
        </div>
      </form>
      <aside v-if="!inline">
        <details>
          <summary>引用上下文</summary>
          <SceneContext :scene="data.scene" />
        </details>
      </aside>
    </div>
  </template>
</template>
