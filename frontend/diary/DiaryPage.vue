<script setup lang="ts">
import SourcePins from './SourcePins.vue';
import { dateLabel, indexHref, resourceHref } from './drafts';
import { useDiaryRoute } from './useDiaryRoute';
import './diary.css';

const props = defineProps<{ url: URL }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const { loading, pageError, contextError, sourceError, record, draft, projects, sources, backlinks,
  latest, latestError, latestLoading, form, saveButton, heading, isNew, isEditing, pinned, cancelHref,
  title, locked, changed, properties, canCite, projectName, narrator, characterOptions,
  load, navigate, selectCharacter, selectProject, showLatest, applyLatest, save, discard, clearValidity, invalid } = useDiaryRoute(props, emit);
</script>

<template>
  <section class="diary-route" :aria-busy="loading" aria-label="日记">
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
      <a class="diary-back" :href="isEditing ? cancelHref : indexHref(record?.projectId)"
        @click="navigate($event, isEditing ? cancelHref : indexHref(record?.projectId))">{{ isEditing && !isNew ? '返回日记' : isNew && url.searchParams.has('characterId') ? '返回角色' : '日记' }}</a>
      <header class="diary-heading">
        <div>
          <h1 ref="heading" tabindex="-1">{{ title }}</h1>
          <p v-if="record" class="diary-meta"><time :datetime="record.diaryDate">{{ dateLabel(record.diaryDate) }}</time> · {{ narrator }}<span v-if="record.projectId"> · {{ projectName }}</span> · 第 {{ record.revision }} 版</p>
        </div>
        <a v-if="record && !isEditing" :href="resourceHref('diaries', record.noteId) + (pinned ? '' : '?edit=1')"
          class="diary-button diary-secondary" @click="navigate($event, resourceHref('diaries', record.noteId) + (pinned ? '' : '?edit=1'))">{{ pinned ? '查看当前版本' : '编辑' }}</a>
      </header>

      <form v-if="draft && isEditing" id="editor" ref="form" class="diary-editor" :aria-label="isNew ? '保存日记' : '保存修改'"
        @submit.prevent="save" @input="clearValidity" @invalid.capture="invalid">
        <fieldset class="diary-writing" :disabled="locked">
          <legend class="diary-sr-only">日记内容</legend>
          <div class="diary-top-fields">
            <div class="diary-field diary-title-field">
              <label for="diary-title">标题<span aria-hidden="true"> *</span></label>
              <input id="diary-title" v-model="draft.values.title" name="title" required :maxlength="properties?.title?.maxLength ?? 300" autocomplete="off">
            </div>
            <div class="diary-field diary-date-field">
              <label for="diary-date">日期<span aria-hidden="true"> *</span></label>
              <input id="diary-date" v-model="draft.values.diaryDate" name="diaryDate" type="date" min="0001-01-01" max="9999-12-31" required>
            </div>
          </div>
          <div class="diary-field diary-body-field">
            <label for="diary-body">正文<span aria-hidden="true"> *</span></label>
            <textarea id="diary-body" v-model="draft.values.body" name="body" rows="12" required :maxlength="properties?.body?.maxLength ?? 100000" />
          </div>
        </fieldset>

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
        <div class="diary-save-bar">
          <div class="diary-actions">
            <button ref="saveButton" type="submit" class="diary-button diary-primary" :disabled="draft.busy || draft.conflict">{{ draft.busy ? '正在保存…' : draft.call ? '重试保存' : isNew ? '保存日记' : '保存修改' }}</button>
            <a :href="cancelHref" class="diary-button diary-quiet" @click="navigate($event, cancelHref)">返回</a>
            <button v-if="changed && !locked" type="button" class="diary-button diary-quiet" @click="discard">清除草稿</button>
          </div>
          <p class="diary-muted" role="status">{{ draft.busy ? '保存中' : draft.uncertain ? '正在等待保存结果，请重试同一次保存。' : changed ? '有未保存的修改' : '带 * 的字段为必填项。' }}</p>
        </div>
      </form>

      <template v-else-if="record">
        <article class="diary-entry" aria-label="日记正文"><div class="diary-prose">{{ record.body }}</div></article>
        <aside v-if="record.character || record.sourcePins?.length || backlinks.length || contextError" class="diary-evidence" aria-label="日记上下文与来源">
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
        </aside>
      </template>
    </template>
  </section>
</template>
