<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from '../AppIcon.vue';
import ManuscriptViewControls from '../manuscript/ManuscriptViewControls.vue';
import { manuscriptView } from '../manuscript/view.ts';
import SourcePins from './SourcePins.vue';
import { dateLabel, indexHref, resourceHref } from './drafts';
import { useDiaryRoute } from './useDiaryRoute';
import './diary.css';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const view = inject(manuscriptView, undefined);
const { loading, pageError, contextError, sourceError, record, draft, projects, sources, backlinks,
  latest, latestError, latestLoading, form, saveButton, heading, isNew, isEditing, pinned, cancelHref,
  title, locked, changed, properties, canCite, projectName, narrator, characterOptions,
  load, navigate, selectCharacter, selectProject, showLatest, applyLatest, save, discard, clearValidity, invalid } = useDiaryRoute(props, emit);
const bodyEditor = ref<HTMLTextAreaElement>();
const supplement = ref<HTMLElement>();
const evidenceButton = ref<HTMLButtonElement>();
const evidenceOpen = ref(false);
const characters = computed(() => Array.from((draft.value?.values.body ?? record.value?.body ?? '').replace(/\s/g, '')).length);
let returnPosition: { top: number; start?: number; end?: number } | undefined;
let bodyObserver: ResizeObserver | undefined;

function fitBody() {
  const textarea = bodyEditor.value;
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function syncEvidenceState() {
  evidenceOpen.value = Boolean(supplement.value?.querySelector(':scope > details[open]'));
}

function returnToBody() {
  for (const details of supplement.value?.querySelectorAll<HTMLDetailsElement>(':scope > details') ?? []) details.open = false;
  if (bodyEditor.value) {
    bodyEditor.value.focus({ preventScroll: true });
    if (returnPosition?.start !== undefined) bodyEditor.value.setSelectionRange(returnPosition.start, returnPosition.end ?? returnPosition.start);
  } else evidenceButton.value?.focus({ preventScroll: true });
  if (returnPosition) window.scrollTo({ top: returnPosition.top, behavior: 'instant' });
  returnPosition = undefined;
}

async function toggleEvidence() {
  if (evidenceOpen.value) { returnToBody(); return; }
  returnPosition = { top: window.scrollY, start: bodyEditor.value?.selectionStart, end: bodyEditor.value?.selectionEnd };
  for (const details of supplement.value?.querySelectorAll<HTMLDetailsElement>(':scope > details') ?? []) details.open = true;
  await nextTick();
  const summary = supplement.value?.querySelector('summary');
  summary?.focus({ preventScroll: true });
  summary?.scrollIntoView({ block: 'start', behavior: 'instant' });
}

watch(() => [loading.value, draft.value?.values.body], () => void nextTick(fitBody), { flush: 'post' });
watch(bodyEditor, textarea => {
  bodyObserver?.disconnect();
  if (!textarea) return;
  let width = 0;
  bodyObserver = new ResizeObserver(entries => {
    const nextWidth = entries[0]?.contentRect.width;
    if (nextWidth && nextWidth !== width) { width = nextWidth; fitBody(); }
  });
  bodyObserver.observe(textarea);
});
watch(loading, value => {
  if (value) { evidenceOpen.value = false; returnPosition = undefined; }
});
onBeforeUnmount(() => bodyObserver?.disconnect());
</script>

<template>
  <section class="diary-route diary-route-sheet" :aria-busy="loading" aria-label="日记">
    <p v-if="loading" class="diary-loading" role="status">正在读取日记…</p>
    <div v-else-if="pageError" class="diary-error-page">
      <h1 ref="heading" tabindex="-1">页面暂时无法打开</h1>
      <p role="alert">{{ pageError }}</p>
      <div class="diary-actions">
        <button type="button" class="diary-button diary-primary" @click="load">重试</button>
        <a href="/diaries" class="diary-button diary-quiet" @click="navigate($event, '/diaries')">返回日记</a>
      </div>
    </div>
    <template v-else>
      <header class="diary-toolbar" aria-label="日记操作">
        <ManuscriptViewControls />
        <a v-if="!view" class="diary-back" :href="isEditing ? cancelHref : indexHref(record?.projectId)"
          @click="navigate($event, isEditing ? cancelHref : indexHref(record?.projectId))"><AppIcon name="back" />{{ isEditing && !isNew ? '返回日记' : isNew && url.searchParams.has('characterId') ? '返回角色' : '日记' }}</a>
        <span class="diary-toolbar-count">{{ characters.toLocaleString('zh-CN') }} 字</span>
        <div class="diary-toolbar-actions">
          <button ref="evidenceButton" type="button" class="diary-button diary-quiet" aria-controls="diary-supplement" :aria-expanded="evidenceOpen" @click="toggleEvidence">依据与修订</button>
          <button v-if="draft && isEditing" ref="saveButton" form="editor" type="submit" class="diary-button diary-primary" :disabled="draft.busy || draft.conflict">{{ draft.busy ? '正在保存…' : draft.call ? '重试保存' : isNew ? '保存日记' : '保存修改' }}</button>
          <a v-else-if="record" :href="resourceHref('diaries', record.noteId) + (pinned ? '' : '?edit=1')"
            class="diary-button diary-secondary" @click="navigate($event, resourceHref('diaries', record.noteId) + (pinned ? '' : '?edit=1'))">{{ pinned ? '查看当前版本' : '编辑' }}</a>
        </div>
      </header>

      <h1 v-if="isEditing" ref="heading" class="diary-sr-only" tabindex="-1">{{ title }}</h1>
      <form v-if="draft && isEditing" id="editor" ref="form" class="diary-editor" :aria-label="isNew ? '保存日记' : '保存修改'"
        @submit.prevent="save" @input="clearValidity" @invalid.capture="invalid">
        <p v-if="draft.error" id="save-error" class="diary-notice" role="alert">{{ draft.error }}</p>
        <section v-if="draft.conflict" class="diary-notice diary-conflict" aria-label="版本冲突">
          <p role="alert">{{ isNew ? '写作期间角色设定已更新。请核对新版设定后再保存日记。' : '这篇日记已有新版。请核对最新内容，再决定如何继续。' }}</p>
          <p v-if="latestLoading" role="status">正在读取最新版本…</p>
          <template v-else-if="latest">
            <details open><summary>最新版本 · 第 {{ latest.revision }} 版</summary>
              <p class="diary-revision-title">{{ 'noteId' in latest ? latest.title : latest.name }}</p>
              <p v-if="'noteId' in latest" class="diary-muted"><time :datetime="latest.diaryDate">{{ dateLabel(latest.diaryDate) }}</time></p>
              <div class="diary-context-prose">{{ 'noteId' in latest ? latest.body : latest.persona }}</div>
            </details>
            <div class="diary-actions">
              <button type="button" class="diary-button diary-secondary" @click="applyLatest(false)">{{ isNew ? '采用最新角色设定' : '保留我的修改并采用新版' }}</button>
              <button v-if="!isNew" type="button" class="diary-button diary-quiet" @click="applyLatest(true)">改用最新版</button>
            </div>
          </template>
          <template v-else-if="latestError"><p role="alert">{{ latestError }}</p>
            <button type="button" class="diary-button diary-secondary" @click="showLatest">重新读取最新版</button>
          </template>
        </section>
        <fieldset class="diary-writing" :disabled="locked">
          <legend class="diary-sr-only">日记内容</legend>
          <div class="diary-top-fields">
            <div class="diary-field diary-title-field">
              <label for="diary-title" class="diary-sr-only">标题<span aria-hidden="true"> *</span></label>
              <input id="diary-title" v-model="draft.values.title" name="title" required :maxlength="properties?.title?.maxLength ?? 300" autocomplete="off" placeholder="为这篇日记起个标题">
            </div>
            <div class="diary-field diary-date-field">
              <label for="diary-date">日期<span aria-hidden="true"> *</span></label>
              <input id="diary-date" v-model="draft.values.diaryDate" name="diaryDate" type="date" min="0001-01-01" max="9999-12-31" required>
            </div>
          </div>
          <div class="diary-field diary-body-field">
            <label for="diary-body" class="diary-sr-only">正文<span aria-hidden="true"> *</span></label>
            <textarea id="diary-body" ref="bodyEditor" v-model="draft.values.body" name="body" rows="12" required :maxlength="properties?.body?.maxLength ?? 100000" placeholder="从这一刻写起。" :aria-describedby="draft.error ? 'save-error' : 'diary-save-status'" />
          </div>
        </fieldset>

        <div class="diary-save-bar">
          <p id="diary-save-status" class="diary-muted" role="status">{{ draft.busy ? '保存中' : draft.uncertain ? '正在等待保存结果，请重试同一次保存。' : changed ? '有未保存的修改' : '带 * 的字段为必填项。' }}</p>
          <div class="diary-actions">
            <a :href="cancelHref" class="diary-button diary-quiet" @click="navigate($event, cancelHref)">{{ !isNew ? '返回日记' : url.searchParams.has('characterId') ? '返回角色' : '返回日记列表' }}</a>
            <button v-if="changed && !locked" type="button" class="diary-button diary-quiet" @click="discard">清除草稿</button>
          </div>
        </div>

        <aside id="diary-supplement" ref="supplement" class="diary-supplement" aria-label="依据与修订" @toggle.capture="syncEvidenceState">
          <details class="diary-context">
            <summary>写作上下文 · {{ narrator }} · {{ projectName }}</summary>
            <fieldset v-if="isNew" class="diary-context-fields" :disabled="locked">
              <legend class="diary-sr-only">写作上下文</legend>
              <div class="diary-field">
                <label for="diary-project">项目</label>
                <select id="diary-project" v-model="draft.values.projectId" name="projectId" @change="selectProject">
                  <option value="">不归入项目</option>
                  <option v-if="draft.values.projectId && !projects.some(project => project.projectId === draft!.values.projectId)" :value="draft.values.projectId">当前项目</option>
                  <option v-for="project in projects" :key="project.projectId" :value="project.projectId">{{ project.title }}</option>
                </select>
              </div>
              <div class="diary-field">
                <label for="diary-character">叙述者</label>
                <select id="diary-character" v-model="draft.values.characterId" name="characterId" @change="selectCharacter">
                  <option value="">作为个人日记</option>
                  <option v-if="draft.values.characterId && !characterOptions.some(character => character.characterId === draft!.values.characterId)" :value="draft.values.characterId">当前叙述者</option>
                  <option v-for="character in characterOptions" :key="character.characterId" :value="character.characterId">{{ character.name }}</option>
                </select>
              </div>
              <p v-if="draft.character" class="diary-muted">角色设定 · 第 {{ draft.character.revision }} 版</p>
              <p v-if="draft.character?.persona" class="diary-context-prose">{{ draft.character.persona }}</p>
            </fieldset>
            <div v-else class="diary-context-fields"><p>{{ narrator }} · {{ projectName }}</p>
              <a v-if="record?.character" :href="resourceHref('characters', record.character.characterId, record.character.revision)"
                @click="navigate($event, resourceHref('characters', record!.character!.characterId, record!.character!.revision))">查看角色证据 · 第 {{ record.character.revision }} 版</a>
            </div>
            <p v-if="contextError" class="diary-notice" role="alert">{{ contextError }}</p>
          </details>

          <details v-if="canCite" class="diary-context" :open="draft.values.sourcePins.length > 0">
            <summary>资料引用<span v-if="draft.values.sourcePins.length"> · {{ draft.values.sourcePins.length }} 处</span></summary>
            <p v-if="sourceError" class="diary-notice" role="alert">{{ sourceError }}</p>
            <SourcePins :pins="draft.values.sourcePins" :sources="sources" :disabled="locked" :max-items="properties?.sourcePins?.maxItems ?? 20"
              @change="draft.values.sourcePins = $event" />
          </details>

          <details v-if="record" class="diary-context">
            <summary>修订记录 · 第 {{ draft.record?.revision ?? record.revision }} 版</summary>
            <div class="diary-context-fields">
              <p class="diary-muted">本次修改基于第 {{ draft.record?.revision ?? record.revision }} 版，保存后生成新修订。</p>
              <a :href="resourceHref('diaries', record.noteId, draft.record?.revision ?? record.revision)" @click="navigate($event, resourceHref('diaries', record!.noteId, draft!.record?.revision ?? record!.revision))">阅读本次修改前的版本</a>
            </div>
          </details>
          <button v-if="evidenceOpen" type="button" class="diary-button diary-quiet diary-return" @click="returnToBody"><AppIcon name="back" />回到正文</button>
        </aside>
      </form>

      <template v-else-if="record">
        <header class="diary-heading diary-reading-heading">
          <div>
            <h1 ref="heading" tabindex="-1">{{ record.title }}</h1>
            <p class="diary-meta"><time :datetime="record.diaryDate">{{ dateLabel(record.diaryDate) }}</time> · {{ narrator }}<span v-if="record.projectId"> · {{ projectName }}</span></p>
            <p v-if="pinned" class="diary-pinned">正在阅读第 {{ record.revision }} 版</p>
          </div>
        </header>
        <article class="diary-entry" aria-label="日记正文"><div class="diary-prose">{{ record.body }}</div></article>
        <aside id="diary-supplement" ref="supplement" class="diary-supplement" aria-label="依据与修订" @toggle.capture="syncEvidenceState">
          <details v-if="record.character || record.sourcePins?.length || backlinks.length || contextError" class="diary-context">
            <summary>写作依据<span v-if="record.sourcePins?.length"> · {{ record.sourcePins.length }} 处引用</span></summary>
            <div class="diary-evidence">
              <a v-if="record.character" :href="resourceHref('characters', record.character.characterId, record.character.revision)"
                class="diary-reference" @click="navigate($event, resourceHref('characters', record!.character!.characterId, record!.character!.revision))">查看角色证据 · 第 {{ record.character.revision }} 版</a>
              <section v-if="record.sourcePins?.length" class="diary-citations"><h2>资料引用</h2>
                <ul><li v-for="(pin, index) in record.sourcePins" :key="index">
                  <a :href="resourceHref('sources', pin.sourceId, pin.revision, pin.range)" @click="navigate($event, resourceHref('sources', pin.sourceId, pin.revision, pin.range))">查看资料原文 · 第 {{ pin.revision }} 版</a>
                  <blockquote>{{ pin.excerpt }}</blockquote>
                </li></ul>
              </section>
              <section v-if="backlinks.length" class="diary-backlinks"><h2>引用此记录的角色证据</h2>
                <ul><li v-for="link in backlinks" :key="`${link.characterId}-${link.revision}-${link.entryId}-${link.blockIndex}`">
                  <a :href="resourceHref('characters', link.characterId, link.revision)" @click="navigate($event, resourceHref('characters', link.characterId, link.revision))">{{ link.name }} · 第 {{ link.revision }} 版 · {{ link.label || '未命名条目' }}</a>
                  <blockquote v-if="link.reference.excerpt">{{ link.reference.excerpt }}</blockquote>
                </li></ul>
              </section>
              <p v-if="contextError" class="diary-notice" role="alert">{{ contextError }}</p>
            </div>
          </details>
          <details class="diary-context">
            <summary>修订记录 · 第 {{ record.revision }} 版</summary>
            <div class="diary-context-fields">
              <p class="diary-muted">{{ pinned ? '链接固定在这一版日记。' : '正在阅读当前版本。' }}</p>
              <nav class="diary-revisions" aria-label="日记修订">
                <a v-if="record.revision > 1" :href="resourceHref('diaries', record.noteId, record.revision - 1)" @click="navigate($event, resourceHref('diaries', record!.noteId, record!.revision - 1))">阅读第 {{ record.revision - 1 }} 版</a>
                <a v-if="record.revision > 2" :href="resourceHref('diaries', record.noteId, 1)" @click="navigate($event, resourceHref('diaries', record!.noteId, 1))">阅读最初版本</a>
              </nav>
            </div>
          </details>
          <button v-if="evidenceOpen" type="button" class="diary-button diary-quiet diary-return" @click="returnToBody"><AppIcon name="back" />回到正文</button>
        </aside>
        <nav class="diary-legacy-navigation" aria-label="日记导航">
          <a :href="indexHref(record.projectId)" @click="navigate($event, indexHref(record!.projectId))">返回日记列表</a>
        </nav>
      </template>
    </template>
  </section>
</template>
