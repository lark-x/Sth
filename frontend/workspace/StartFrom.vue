<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Button from '../ui/Button.vue';
import { href, recordHref, sourceHref } from './api.ts';
import type { Scene, SourcePin, StartContext } from './api.ts';
import { retain, savedText, useSubmission } from './useSubmission.ts';

const props = defineProps<{ context: StartContext }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const context = props.context;
const record = context.record;
const id = context.kind === 'character' ? context.record.characterId : context.kind === 'source' ? context.record.sourceId : context.record.noteId;
const storageKey = `sth:creative-entry:scene:${context.kind}:${id}:${record.revision}`;
const title = ref(savedText(`${storageKey}:title`));
const input = ref<HTMLInputElement>();
const sourceText = ref<HTMLTextAreaElement>();
const selectedRange = ref(context.kind === 'source' ? context.range : undefined);
const selectionError = ref('');
const heading = computed(() => context.kind === 'character' ? context.record.name : context.record.title);
const body = computed(() => context.kind === 'character' ? context.record.persona : context.record.body);
const originalHref = computed(() => recordHref(context.kind === 'character' ? 'characters' : context.kind === 'source' ? 'sources' : 'diaries', id, record.revision));
const excerpt = computed(() => selectedRange.value ? body.value.slice(selectedRange.value.start, selectedRange.value.end) : '');
const { pending, busy, error, submit } = useSubmission<Scene>(`${storageKey}:submit`, 'scene.create',
  result => Boolean(result.sceneId) && Number.isSafeInteger(result.revision), result => {
    retain(`${storageKey}:title`, '');
    emit('navigate', recordHref('scenes', result.sceneId));
  });
watch(title, value => retain(`${storageKey}:title`, value));

function selectExcerpt() {
  const start = sourceText.value?.selectionStart ?? 0;
  const end = sourceText.value?.selectionEnd ?? 0;
  if (end <= start || end - start > 4000 || !body.value.slice(start, end).trim()) {
    selectionError.value = '请在原文中选中 1 至 4000 字符后，再引用选中文字。';
    return;
  }
  selectedRange.value = { start, end };
  selectionError.value = '';
}

function createScene() {
  if (pending.value) return void submit({});
  if (!title.value.trim()) {
    input.value?.setCustomValidity('请填写场景标题。');
    input.value?.reportValidity();
    return;
  }
  const characters = context.kind === 'character' ? [{ characterId: context.record.characterId, revision: record.revision }] : [];
  const sources: SourcePin[] = [];
  if (context.kind === 'source') {
    if (!selectedRange.value) {
      selectionError.value = '请先选中要引用的原文。';
      sourceText.value?.focus();
      return;
    }
    sources.push({ sourceId: context.record.sourceId, revision: record.revision, excerpt: excerpt.value, range: selectedRange.value });
  }
  void submit({ title: title.value.trim(), characters, sources });
}
</script>

<template>
  <section class="ce-start" aria-labelledby="ce-start-heading">
    <h2 id="ce-start-heading">{{ heading }}</h2>
    <p class="ce-muted">{{ context.kind === 'character' ? '角色' : context.kind === 'source' ? '资料' : '日记' }} · 第 {{ record.revision }} 版</p>
    <div class="ce-actions">
      <a :href="originalHref">{{ context.kind === 'source' ? '阅读资料原文' : '打开所选版本' }}</a>
      <a v-if="context.kind === 'character'" :href="href('/diaries/new', { characterId: id })">写角色日记</a>
      <a v-if="context.kind === 'diary'" :href="href(recordHref('diaries', id), { edit: '1' })">继续编辑这篇日记</a>
    </div>
    <template v-if="context.kind === 'source'">
      <label for="ce-source-text">选择一段原文作为场景依据</label>
      <textarea id="ce-source-text" ref="sourceText" class="ui-input ce-source-text" :value="body" readonly rows="9" />
      <Button class="ce-button" variant="outline" :disabled="busy || !!pending" @click="selectExcerpt">引用选中文字</Button>
      <p v-if="selectionError" role="alert" class="ce-error">{{ selectionError }}</p>
      <blockquote v-if="excerpt" class="ce-prose">{{ excerpt }}</blockquote>
      <p v-if="selectedRange" class="ce-muted">已选第 {{ selectedRange.start + 1 }} 至 {{ selectedRange.end }} 个字符，引用保留所选版本。</p>
    </template>
    <p v-else-if="body" class="ce-prose ce-context-body">{{ body }}</p>
    <p v-else class="ce-muted">这个角色还没有文字设定，可以打开角色继续补充。</p>
    <template v-if="context.kind === 'diary'">
      <div class="ce-actions">
        <a v-if="context.record.projectId" :href="recordHref('projects', context.record.projectId)">打开所属作品</a>
        <a v-if="context.record.character" :href="recordHref('characters', context.record.character.characterId, context.record.character.revision)">
          {{ context.record.character.name }} · 第 {{ context.record.character.revision }} 版
        </a>
      </div>
      <ul v-if="context.record.sourcePins?.length" class="ce-reference-list">
        <li v-for="pin in context.record.sourcePins" :key="`${pin.sourceId}:${pin.revision}:${pin.range?.start}`">
          <a :href="sourceHref(pin)">引用资料 · 第 {{ pin.revision }} 版</a>
          <blockquote class="ce-prose">{{ pin.excerpt }}</blockquote>
        </li>
      </ul>
    </template>
    <form v-else action="/api/web/invoke" method="post" aria-labelledby="ce-scene-heading" @submit.prevent="createScene">
      <h3 id="ce-scene-heading">从这里写一个场景</h3>
      <p class="ce-muted">{{ context.kind === 'character' ? '场景会引用这个角色的所选版本。' : '场景会引用上面选定的原文和位置。' }}保存后可安排进作品章节。</p>
      <div class="field ce-field">
        <label for="ce-scene-title">场景标题（必填）</label>
        <input id="ce-scene-title" ref="input" v-model="title" name="title" maxlength="300" required enterkeyhint="done"
          :disabled="busy || !!pending" @input="input?.setCustomValidity('')">
      </div>
      <p v-if="error" role="alert" class="ce-error">{{ error }}</p>
      <Button class="ce-button" type="submit" :disabled="busy">{{ busy ? '正在保存…' : pending ? '重试同一次提交' : '保存场景' }}</Button>
    </form>
  </section>
</template>
