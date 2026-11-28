<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import Button from '../ui/Button.vue';
import { href, message, pageOf, recordHref, startHref } from './api.ts';
import type { Character, Diary, Source } from './api.ts';

const props = defineProps<{ kind: 'characters' | 'sources' | 'diaries'; projectId?: string }>();
type Item = Character | Source | Diary;
const items = shallowRef<Item[]>([]);
const busy = ref(false);
const error = ref('');
const more = ref(false);
let controller: AbortController | undefined;
const label = computed(() => ({ characters: '角色', sources: '资料', diaries: '日记' })[props.kind]);
const operationId = computed(() => ({ characters: 'character.list', sources: 'source.list', diaries: 'diary.list' })[props.kind]);
const idOf = (item: Item) => 'characterId' in item ? item.characterId : 'sourceId' in item ? item.sourceId : item.noteId;
const titleOf = (item: Item) => 'name' in item ? item.name : item.title;
const kindOf = (item: Item) => 'characterId' in item ? 'character' : 'sourceId' in item ? 'source' : 'diary';
const previewOf = (item: Item) => ('persona' in item ? item.persona : 'body' in item ? item.body : (item as Source).origin) ?? '';

async function load(reset = false) {
  if (busy.value && !reset) return;
  if (reset) {
    controller?.abort();
    controller = new AbortController();
    items.value = [];
    more.value = false;
  }
  const signal = controller!.signal;
  busy.value = true;
  error.value = '';
  try {
    const page = await pageOf<Item>(operationId.value, props.projectId ? { projectId: props.projectId } : {}, signal, items.value.length);
    if (signal.aborted) return;
    items.value = [...items.value, ...page.items];
    more.value = page.more;
  } catch (reason) {
    if (!signal.aborted) error.value = message(reason);
  } finally { if (!signal.aborted) busy.value = false; }
}
watch(() => [props.kind, props.projectId], () => { void load(true); }, { immediate: true });
onScopeDispose(() => controller?.abort());
</script>

<template>
  <section class="ce-shelf" :aria-label="`已有${label}`" :aria-busy="busy">
    <header class="ce-section-heading">
      <h2>已有{{ label }}</h2>
      <div class="ce-actions">
        <a :href="href(`/${kind}`, { projectId })">查看全部{{ label }}</a>
        <a :href="href(`/${kind}/new`, { projectId })">{{ kind === 'diaries' ? '写日记' : `新建${label}` }}</a>
      </div>
    </header>
    <p v-if="error" role="alert" class="ce-error">{{ error }} <Button class="ce-button" variant="outline" :disabled="busy" @click="load(!items.length)">重新读取</Button></p>
    <p v-if="busy && !items.length" role="status" class="ce-empty">正在读取已有{{ label }}…</p>
    <p v-else-if="!items.length && !error" class="ce-empty">还没有{{ label }}。可以先{{ kind === 'diaries' ? '写下一篇日记' : `保存${label}` }}，再从这里继续。</p>
    <ul v-if="items.length" class="ce-items">
      <li v-for="item in items" :key="idOf(item)">
        <h3><a :href="recordHref(kind, idOf(item), item.revision)">{{ titleOf(item) }}</a></h3>
        <p class="ce-muted">{{ 'diaryDate' in item ? `${item.diaryDate} · ` : '' }}第 {{ item.revision }} 版</p>
        <p v-if="previewOf(item)" class="ce-preview">{{ previewOf(item).slice(0, 220) }}</p>
        <div class="ce-actions">
          <a :href="startHref(kindOf(item), idOf(item), item.revision)">{{ kind === 'diaries' ? '接着这篇日记' : kind === 'sources' ? '从这份资料构思' : '从这个角色构思' }}</a>
          <a v-if="'characterId' in item" :href="href('/diaries/new', { characterId: item.characterId })">写角色日记</a>
          <a v-if="'noteId' in item" :href="href(recordHref('diaries', item.noteId), { edit: '1' })">继续编辑</a>
        </div>
      </li>
    </ul>
    <Button v-if="more" class="ce-button" variant="outline" :disabled="busy" @click="load()">{{ busy ? '正在读取…' : `加载更多${label}` }}</Button>
    <p v-if="items.length" role="status" class="ce-muted ce-list-status">已载入 {{ items.length }} 条{{ label }}</p>
  </section>
</template>
