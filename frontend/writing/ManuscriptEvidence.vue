<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import type { Generation, GenerationAuthorContextRef } from '../../src/generation/contracts.ts';
import type { ManuscriptEvidenceItem, ManuscriptEvidencePage } from '../../src/generation/evidence-contracts.ts';
import type { Draft, Scene } from '../../src/story/contracts.ts';
import type { StoryContext } from '../../src/story/decision-contracts.ts';
import { errorText, invoke, operation } from '../api.ts';
import AppIcon from '../AppIcon.vue';
import PrepareWriting from '../context/PrepareWriting.vue';
import EvidenceAttachment from './evidence-attachment.vue';
import EvidenceContent from './evidence-content.vue';
import { evidenceHref } from './evidence-model.ts';

const props = defineProps<{ scene: Scene; draft?: Draft }>();
const uid = useId();
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const open = ref(false);
const loading = ref(false);
const failure = ref('');
const items = shallowRef<ManuscriptEvidenceItem[]>([]);
const more = ref(false);
const selected = ref('');
const record = shallowRef<Generation>();
const recordLoading = ref(false);
const recordFailure = ref('');
const preparing = ref(false);
const prepareLoading = ref(false);
const prepareFailure = ref('');
const authorContext = shallowRef<GenerationAuthorContextRef>();
const compactQuery = window.matchMedia('(width < 640px)');
const compact = ref(compactQuery.matches);
const scope = computed(() => `${props.scene.sceneId}@${props.scene.revision}:${props.draft?.draftId ?? ''}@${props.draft?.revision ?? ''}`);
const mismatch = computed(() => props.draft && (props.draft.sceneId !== props.scene.sceneId || props.draft.sceneRevision !== props.scene.revision));
const selectedItem = computed(() => items.value.find(item => item.generation.generationId === selected.value));
let controller: AbortController | undefined;
let recordController: AbortController | undefined;
let prepareController: AbortController | undefined;
let loaded = false;
let editor: HTMLElement | undefined;
let selection: Range | undefined;
let inputSelection: { start: number; end: number; direction: 'forward' | 'backward' | 'none'; scrollTop: number } | undefined;
let position = { x: 0, y: 0 };
let opener: HTMLElement | undefined;
let owner: HTMLElement | undefined;
let scrollers: { element: HTMLElement; top: number; left: number }[] = [];
let inertElements: HTMLElement[] = [];
let lockedBody: { property: string; value: string; priority: string }[] | undefined;
let lockedPosition = { x: 0, y: 0 };

function announceState() {
  root.value?.dispatchEvent(new CustomEvent('sth:evidence-state', {
    bubbles: true, detail: { open: open.value, panelId: `${uid}-panel` },
  }));
}
function releaseBackground(restoreScroll = true) {
  for (const element of inertElements) element.inert = false;
  inertElements = [];
  if (!lockedBody) return;
  for (const { property, value, priority } of lockedBody) {
    if (value) document.body.style.setProperty(property, value, priority);
    else document.body.style.removeProperty(property);
  }
  lockedBody = undefined;
  if (restoreScroll) window.scrollTo(lockedPosition.x, lockedPosition.y);
}
function updateBackground() {
  if (!open.value || !compact.value) { releaseBackground(); return; }
  if (lockedBody) return;
  lockedPosition = { x: window.scrollX, y: window.scrollY };
  const properties = ['position', 'top', 'left', 'width', 'overflow'];
  lockedBody = properties.map(property => ({ property, value: document.body.style.getPropertyValue(property),
    priority: document.body.style.getPropertyPriority(property) }));
  Object.assign(document.body.style, { position: 'fixed', top: `${-lockedPosition.y}px`, left: `${-lockedPosition.x}px`, width: '100%', overflow: 'hidden' });
  let branch: HTMLElement | null | undefined = panel.value;
  while (branch?.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && sibling instanceof HTMLElement && !sibling.inert) {
        sibling.inert = true;
        inertElements.push(sibling);
      }
    }
    if (branch.parentElement === document.body) break;
    branch = branch.parentElement;
  }
}
function sizeChanged() { compact.value = compactQuery.matches; updateBackground(); }
function toolbarOpen(event: Event) {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button') : undefined;
  void openPanel(target ?? undefined);
}
function keyboard(event: KeyboardEvent) {
  if (!open.value || event.defaultPrevented) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); void closePanel(); return;
  }
  if (event.key !== 'Tab' || !compact.value || !panel.value) return;
  const controls = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
    .filter(element => element.getClientRects().length && !element.closest('[inert]'));
  const first = controls[0];
  const last = controls.at(-1);
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === panel.value)) {
    event.preventDefault(); (last ?? panel.value).focus({ preventScroll: true });
  } else if (!event.shiftKey && (active === last || !first)) {
    event.preventDefault(); (first ?? panel.value).focus({ preventScroll: true });
  }
}

function rememberEditor(event?: FocusEvent) {
  if (open.value) return;
  const target = event?.target ?? document.activeElement;
  if (!(target instanceof HTMLElement) || root.value?.contains(target)) return;
  if (!target.matches('textarea, input[type="text"], [contenteditable="true"], #passage-body')) return;
  const owner = root.value?.closest('main') ?? root.value?.parentElement;
  if (!owner?.contains(target)) return;
  editor = target;
  inputSelection = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
    ? { start: target.selectionStart ?? 0, end: target.selectionEnd ?? 0, direction: target.selectionDirection ?? 'none', scrollTop: target.scrollTop } : undefined;
  if (inputSelection) selection = undefined;
}
function rememberSelection() {
  if (open.value) return;
  const current = window.getSelection();
  if (!current?.rangeCount || current.isCollapsed) return;
  const range = current.getRangeAt(0);
  const container = range.commonAncestorContainer.parentElement?.closest('#passage-body, [contenteditable="true"]');
  if (container instanceof HTMLElement && (root.value?.closest('main') ?? root.value?.parentElement)?.contains(container)) {
    selection = range.cloneRange(); editor = container;
  }
}
async function openPanel(source?: HTMLElement) {
  if (open.value) return;
  rememberEditor(); rememberSelection();
  opener = source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : trigger.value);
  position = { x: window.scrollX, y: window.scrollY };
  scrollers = [];
  for (let element = root.value?.parentElement; element && element !== document.body; element = element.parentElement) {
    if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
      scrollers.push({ element, top: element.scrollTop, left: element.scrollLeft });
    }
  }
  open.value = true;
  await nextTick();
  if (!open.value) return;
  updateBackground(); announceState();
  panel.value?.focus({ preventScroll: true });
  if (!loaded) void load();
}
async function closePanel() {
  if (!open.value) return;
  open.value = false;
  await nextTick();
  releaseBackground(); announceState();
  const target = editor?.isConnected ? editor : opener?.isConnected ? opener : trigger.value;
  target?.focus({ preventScroll: true });
  if (inputSelection && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
    target.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction);
    target.scrollTop = inputSelection.scrollTop;
  } else if (selection?.startContainer.isConnected && selection.endContainer.isConnected) {
    const current = window.getSelection();
    current?.removeAllRanges(); current?.addRange(selection);
  }
  for (const { element, top, left } of scrollers) if (element.isConnected) element.scrollTo(left, top);
  window.scrollTo(position.x, position.y);
  const location = inputSelection ? target?.getBoundingClientRect() : selection?.getBoundingClientRect() ?? target?.getBoundingClientRect();
  if (location && (location.top < 0 || location.bottom > window.innerHeight)) {
    if (selection && !inputSelection) window.scrollBy(0, location.top - window.innerHeight / 3);
    else target?.scrollIntoView({ block: 'nearest' });
  }
}
async function load(append = false) {
  controller?.abort();
  const active = controller = new AbortController();
  failure.value = '';
  if (mismatch.value) { failure.value = '稿件与场景版本不匹配，请传入稿件固定的场景版本。'; return; }
  loading.value = true;
  if (!append) { items.value = []; record.value = undefined; selected.value = ''; more.value = false; }
  try {
    const page = await invoke<ManuscriptEvidencePage>(operation('generations.evidence.list', {
      sceneId: props.scene.sceneId, sceneRevision: props.scene.revision,
      ...(props.draft ? { draftId: props.draft.draftId, draftRevision: props.draft.revision } : {}),
      limit: 20, offset: append ? items.value.length : 0,
    }), active.signal);
    if (active.signal.aborted) return;
    if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw new Error('invalid evidence');
    items.value = [...items.value, ...page.items]; more.value = page.hasMore; loaded = true;
    if (!selected.value && items.value[0]) { selected.value = items.value[0].generation.generationId; void readRecord(); }
  } catch (reason) { if (!active.signal.aborted) failure.value = `本次依据读取失败。${errorText(reason)}`; }
  finally { if (!active.signal.aborted) loading.value = false; }
}
async function readRecord() {
  recordController?.abort();
  const active = recordController = new AbortController();
  record.value = undefined; recordFailure.value = '';
  if (!selectedItem.value) return;
  recordLoading.value = true;
  try {
    const result = await invoke<Generation>(operation('generations.get', { generationId: selected.value }), active.signal);
    if (!active.signal.aborted) {
      if (result.generationId !== selected.value || !Array.isArray(result.composition?.references)) throw new Error('invalid generation');
      record.value = result;
    }
  } catch (reason) { if (!active.signal.aborted) recordFailure.value = `组稿快照读取失败。${errorText(reason)}`; }
  finally { if (!active.signal.aborted) recordLoading.value = false; }
}
async function prepare() {
  if (prepareLoading.value || mismatch.value) return;
  prepareController?.abort();
  const active = prepareController = new AbortController();
  prepareLoading.value = true; prepareFailure.value = ''; authorContext.value = undefined;
  try {
    if (props.scene.placement) {
      const projectId = props.scene.placement.projectId;
      const branchId = props.scene.branchId ?? (props.scene.branchFrom ? props.scene.sceneId : null);
      const context = await invoke<StoryContext>(operation('story.context', { projectId, branchId, limit: 1 }), active.signal);
      if (active.signal.aborted) return;
      authorContext.value = { projectId, branchId, contextRevision: context.revision };
    }
    if (!active.signal.aborted) preparing.value = true;
  } catch (reason) { if (!active.signal.aborted) prepareFailure.value = `写作上下文读取失败。${errorText(reason)}`; }
  finally { if (!active.signal.aborted) prepareLoading.value = false; }
}
watch(scope, () => {
  controller?.abort(); recordController?.abort(); prepareController?.abort();
  loaded = false; items.value = []; record.value = undefined; selected.value = ''; more.value = false;
  failure.value = ''; recordFailure.value = ''; prepareFailure.value = ''; preparing.value = false;
  loading.value = false; recordLoading.value = false; prepareLoading.value = false;
  editor = undefined; selection = undefined; inputSelection = undefined;
  if (open.value) void load();
});
onMounted(() => {
  owner = root.value?.closest('main') ?? root.value?.parentElement ?? undefined;
  owner?.addEventListener('sth:open-evidence', toolbarOpen);
  compactQuery.addEventListener('change', sizeChanged);
  document.addEventListener('keydown', keyboard);
  document.addEventListener('focusout', rememberEditor);
  document.addEventListener('selectionchange', rememberSelection);
  announceState();
});
onBeforeUnmount(() => {
  controller?.abort(); recordController?.abort(); prepareController?.abort();
  open.value = false; announceState(); releaseBackground(false);
  owner?.removeEventListener('sth:open-evidence', toolbarOpen);
  compactQuery.removeEventListener('change', sizeChanged);
  document.removeEventListener('keydown', keyboard);
  document.removeEventListener('focusout', rememberEditor); document.removeEventListener('selectionchange', rememberSelection);
});
defineExpose({ open: openPanel, close: closePanel });
</script>

<template>
  <div ref="root" class="manuscript-evidence">
    <button ref="trigger" class="evidence-trigger" type="button" :aria-expanded="open" :aria-controls="`${uid}-panel`"
      @pointerdown="rememberEditor(); rememberSelection()" @click="open ? closePanel() : openPanel()"><AppIcon name="book" /><span>本次依据</span></button>
    <aside v-show="open" :id="`${uid}-panel`" ref="panel" class="evidence-panel" tabindex="-1" :aria-labelledby="`${uid}-heading`"
      :role="compact ? 'dialog' : undefined" :aria-modal="compact && open ? true : undefined">
      <header><h2 :id="`${uid}-heading`">本次依据</h2><button class="evidence-close" type="button" @click="closePanel">关闭依据</button></header>
      <p v-if="loading" role="status">正在读取本次依据…</p>
      <p v-if="failure" role="alert">{{ failure }} <button v-if="!mismatch" type="button" :disabled="loading" @click="load()">重新读取本次依据</button></p>
      <template v-if="!mismatch">
        <template v-if="loaded && !items.length">
          <p v-if="draft">此稿尚无明确关联的组稿记录。普通助手草稿与手写稿可保留这一状态。</p>
          <p v-else>此场景版本还没有保存的组稿。</p>
        </template>
        <template v-if="items.length">
          <label :for="`${uid}-generation`">{{ draft ? '此版本确认关联的组稿' : '为此场景准备的组稿' }}</label>
          <select :id="`${uid}-generation`" v-model="selected" @change="readRecord">
            <option v-for="item in items" :key="item.generation.generationId" :value="item.generation.generationId">{{ item.generation.title }} · {{ item.generation.createdAt.slice(0, 10) }}</option>
          </select>
          <p v-if="draft">此关联由作者明确确认，固定在稿件第 {{ draft.revision }} 版。</p>
          <p v-else>这些记录按准备时指定的场景版本列出。稿件使用哪次组稿，由作者在对应稿件版本确认。</p>
          <button v-if="more" type="button" :disabled="loading" @click="load(true)">读取更早组稿</button>
        </template>
        <p v-if="recordLoading" role="status">正在读取组稿快照…</p>
        <p v-if="recordFailure" role="alert">{{ recordFailure }} <button type="button" @click="readRecord">重试组稿快照</button></p>
        <EvidenceContent v-if="record" :generation="record" />
        <nav v-if="draft && selectedItem?.passages.length" aria-label="明确关联的稿件片段">
          <a v-for="(passage, index) in selectedItem.passages" :key="index"
            :href="evidenceHref('draft', draft.draftId, draft.revision, passage)">定位稿件片段 {{ index + 1 }} · 依据 {{ passage.referenceIndex + 1 }}</a>
        </nav>
        <EvidenceAttachment v-if="draft && loaded && !items.length" :key="scope" :draft="draft" @attached="load()" />
        <details class="evidence-scene-links">
          <summary>场景关联资料 · 第 {{ scene.revision }} 版</summary>
          <p>以下为该场景版本保存的关联。各次组稿的实际输入显示在对应记录中。</p>
          <p v-if="!scene.sources.length && !scene.characters.length">此版场景没有关联原文或人物。</p>
          <figure v-for="(source, index) in scene.sources" :key="index"><blockquote>{{ source.excerpt }}</blockquote>
            <figcaption><a :href="evidenceHref('source', source.sourceId, source.revision, source.range)">场景引用原文 {{ index + 1 }} · 第 {{ source.revision }} 版</a></figcaption></figure>
          <article v-for="character in scene.characters" :key="character.characterId"><h3><a :href="evidenceHref('character', character.characterId, character.revision)">{{ character.name }} · 第 {{ character.revision }} 版</a></h3><p>{{ character.persona }}</p></article>
        </details>
        <button v-if="!preparing" type="button" :disabled="prepareLoading" @click="prepare">{{ prepareLoading ? '正在读取写作上下文…' : '选择本次依据，准备新稿' }}</button>
        <p v-if="prepareFailure" role="alert">{{ prepareFailure }}</p>
        <PrepareWriting v-if="preparing" :key="scope" :scene="scene" :author-context="authorContext"
          :return-href="evidenceHref('scene', scene.sceneId, scene.revision)!" @prepared="!draft && load()" />
      </template>
    </aside>
  </div>
</template>

<style scoped>
.manuscript-evidence, .evidence-panel { min-inline-size: 0; max-inline-size: 100%; }
.evidence-trigger, .evidence-close { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; min-inline-size: 2.75rem; padding: .4rem .65rem; border: 0; border-radius: 4px; background: transparent; color: var(--accent, #285a46); font-size: .875rem; line-height: 1.5; }
.evidence-trigger .icon { flex-shrink: 0; inline-size: 1.1rem; block-size: 1.1rem; }
.evidence-trigger:hover, .evidence-close:hover { background: var(--sidebar, #eaf0e9); }
.evidence-trigger[aria-expanded="true"] { background: var(--selection, #d7e6d6); font-weight: 600; }
.evidence-panel { position: fixed; z-index: 20; inset-block: 0; inset-inline-end: 0; box-sizing: border-box; inline-size: var(--ms-evidence-width, min(320px, 40vw)); block-size: 100dvh; margin: 0; padding: 0 1rem max(1rem, env(safe-area-inset-bottom)); border: 0; border-inline-start: 1px solid var(--line-strong, #87968c); background: var(--sheet, #fff); color: var(--ink, #23332c); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scroll-padding-block: 5rem 1rem; overflow-wrap: anywhere; }
header { position: sticky; z-index: 1; inset-block-start: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem 1rem; margin: 0 -1rem 1rem; padding: max(.75rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) .75rem max(1rem, env(safe-area-inset-left)); border-block-end: 1px solid var(--line, #d7dfd6); background: var(--sheet, #fff); }
h2 { margin: 0; font-size: 1.125rem; font-weight: 650; line-height: 1.5; }
h3 { font-size: 1rem; }
p, blockquote { white-space: pre-wrap; line-height: 1.75; }
figure { margin: 1rem 0; }
blockquote { margin: 0 0 .5rem; }
label { display: block; margin-block: 1rem .4rem; }
select { box-sizing: border-box; inline-size: 100%; min-inline-size: 0; max-inline-size: 100%; min-block-size: 2.75rem; padding: .5rem; border: 1px solid var(--line-strong); background: var(--sheet, #fff); color: inherit; font: inherit; }
button, summary { min-block-size: 2.75rem; cursor: pointer; }
button { font: inherit; }
nav { display: flex; flex-wrap: wrap; gap: .75rem; }
.evidence-scene-links { margin-block: 1.25rem; border-block: 1px solid var(--line); padding-block: .5rem; }
[role="alert"] { color: var(--danger); }
:focus-visible { outline: 2px solid var(--accent, #285a46); outline-offset: 3px; }
@media (width < 640px) { .evidence-panel { inset: 0; inline-size: 100%; border: 0; padding-inline: max(1rem, env(safe-area-inset-left)) max(1rem, env(safe-area-inset-right)); scrollbar-gutter: auto; } }
@media (forced-colors: active) { .evidence-trigger[aria-expanded="true"] { outline: 1px solid Highlight; } }
</style>
