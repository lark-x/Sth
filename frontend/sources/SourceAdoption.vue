<script setup lang="ts">
import { ref } from 'vue';
import { forgetDraft, getDraft } from './drafts';
import { resourceHref, step } from './api';
import type { Character, Range, Source } from './api';
import { useDraftWrite } from './useDraftWrite';

const props = defineProps<{ source: Source; range: Range; characters: Character[] }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const key = `adopt:${props.source.sourceId}:${props.source.revision}:${props.range.start}:${props.range.end}`;
const draft = getDraft(key, { characterId: '', label: '', text: '' });
const { locked, save } = useDraftWrite(key, draft, (path) => emit('navigate', path));
const form = ref<HTMLFormElement>();
const excerpt = props.source.body.slice(props.range.start, props.range.end);
function submit() {
  if (!draft.call) {
    const label = form.value?.elements.namedItem('label') as HTMLInputElement;
    label.setCustomValidity(draft.values.label.trim() ? '' : '请填写条目名称。');
    if (!form.value?.reportValidity()) return;
  }
  void save<Character>(
    () =>
      step('character.adopt-entries', {
        characterId: draft.values.characterId,
        entries: [
          {
            label: draft.values.label.trim(),
            ...(draft.values.text.trim() ? { text: draft.values.text } : {}),
            references: [
              {
                kind: 'source',
                id: props.source.sourceId,
                revision: props.source.revision,
                excerpt,
                range: props.range,
              },
            ],
          },
        ],
      }),
    (result) => resourceHref('character', result.characterId),
  );
}
</script>

<template>
  <section>
    <h2>所选原文</h2>
    <blockquote class="sources-prose">{{ excerpt }}</blockquote>
  </section>
  <p v-if="excerpt.length > 4000" role="alert">选文最多 4000 个 UTF-16 字符，请返回原文缩小选区。</p>
  <p v-else-if="draft.saved" role="status">
    角色条目已采纳。<a :href="draft.saved" @click="forgetDraft(key)">查看角色</a>
  </p>
  <form
    v-else-if="characters.length"
    id="adopt-entry"
    ref="form"
    class="sources-editor"
    @submit.prevent="submit"
  >
    <fieldset :disabled="locked">
      <legend class="sources-sr-only">角色条目</legend>
      <div class="sources-field">
        <label for="adopt-character">采纳到角色</label
        ><select id="adopt-character" v-model="draft.values.characterId" name="characterId" required>
          <option value="">请选择</option>
          <option v-for="character in characters" :key="character.characterId" :value="character.characterId">
            {{ character.name }}
          </option>
        </select>
      </div>
      <div class="sources-field">
        <label for="adopt-label">条目名称</label
        ><input
          id="adopt-label"
          v-model="draft.values.label"
          name="label"
          required
          maxlength="300"
          @input="($event.target as HTMLInputElement).setCustomValidity('')"
        />
      </div>
      <div class="sources-field">
        <label for="adopt-text">条目补充文字</label
        ><textarea id="adopt-text" v-model="draft.values.text" name="text" maxlength="100000" rows="4" />
      </div>
    </fieldset>
    <p v-if="draft.error" role="alert">{{ draft.error }}</p>
    <button class="sources-button sources-primary" type="submit" :disabled="draft.busy">
      {{ draft.busy ? '正在采纳…' : draft.call ? '重试同一次提交' : '采纳条目' }}
    </button>
  </form>
  <p v-else>还没有可采纳此条目的角色。<a href="/characters/new">新建角色</a></p>
</template>
