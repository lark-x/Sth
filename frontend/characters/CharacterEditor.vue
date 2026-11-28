<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue';
import Button from '../ui/Button.vue';
import { errorText, href, listAll, readCharacter, resources } from './api';
import type { AuthorEntry, Character, Choices, Operation, Project, Resource } from './api';

const props = defineProps<{ url: URL; character?: Character; projects: Project[]; projectId: string;
  operations: Map<string, Operation>; cancel: string }>();
const emit = defineEmits<{ navigate: [href: string]; refresh: [] }>();
const host = ref<HTMLElement>();
const busy = ref(true);
const error = ref('');
const controller = new AbortController();
interface Values { name: string; persona: string; projectId?: string; entries?: string }
interface Draft { values: Values; record: Character }

async function resourceChoices(): Promise<Choices> {
  const pairs = await Promise.all(Object.entries(resources).filter(([kind]) => kind !== 'draft' && props.operations.has(`${kind}.list`))
    .map(async ([kind, [, , key]]) => {
      const records = await listAll<Resource>(props.operations, `${kind}.list`, {}, controller.signal);
      return [kind, records.map(record => [String(record[key]), `${record.title ?? record.name ?? record.label ?? '未命名'} · 第 ${record.revision} 版`, record])] as const;
    }));
  const choices = Object.fromEntries(pairs) as Choices;
  if (props.operations.has('draft.list')) {
    choices.draft = [];
    const scenes = choices.scene ?? [];
    for (let offset = 0; offset < scenes.length; offset += 8) {
      const groups = await Promise.all(scenes.slice(offset, offset + 8).map(async ([sceneId, , scene]) =>
        (await listAll<Resource>(props.operations, 'draft.list', { sceneId }, controller.signal)).map(record =>
          [String(record.draftId), `${record.title} · ${scene.title} · 第 ${record.revision} 版`, record] as [string, string, Resource])));
      choices.draft.push(...groups.flat());
    }
  }
  return choices;
}

// Only the established form, ordered-entry editor and upload machinery cross
// this boundary. Page loading, navigation and reading belong to Vue components.
async function renderForm() {
  busy.value = true;
  error.value = '';
  try {
    const uiUrl = '/assets/ui.js';
    const editorUrl = '/assets/editor.js';
    const blocksUrl = '/assets/character-blocks.js';
    const apiUrl = '/assets/api.js';
    const [ui, shared, blocks, api] = await Promise.all([
      import(/* @vite-ignore */ uiUrl), import(/* @vite-ignore */ editorUrl), import(/* @vite-ignore */ blocksUrl),
      import(/* @vite-ignore */ apiUrl),
    ]);
    const operationId = props.character ? 'character.revise' : 'character.create';
    const operation = props.operations.get(operationId);
    if (!operation) throw new Error('角色编辑操作暂时不可用。');
    const schema = operation.inputSchema.properties ?? {};
    const extended = Boolean(schema.entries);
    const required = (operation.inputSchema as { required?: string[] }).required ?? [];
    const choices = extended ? await resourceChoices() : {};
    if (controller.signal.aborted || !host.value) return;
    const { character } = props;
    const label = character ? '保存设定' : '创建角色';
    const characterValues = (record: Character): Values => ({ name: extended ? record.authorName ?? '' : record.name,
      persona: record.persona ?? '', ...(extended ? { entries: JSON.stringify(record.entries ?? []) } : {}) });
    const draft = shared.getDraft(props.url.pathname + props.url.search, character, character ? characterValues(character) : {
      name: '', projectId: props.projectId, persona: '', ...(extended ? { entries: '[]' } : {}),
    }) as Draft;
    const { values } = draft;
    const fields = ui.field('name', '角色名称', { value: values.name, schema: schema.name, required: required.includes('name') }) +
      (character ? '' : ui.field('projectId', '项目', { value: values.projectId, required: false,
        options: ui.projectOptions(props.projects, '不归入项目') })) +
      ui.field('persona', '角色设定', { value: values.persona, type: 'textarea', rows: 6, schema: schema.persona, required: required.includes('persona') }) +
      (extended ? `<fieldset class="workspace-fieldset" id="character-entries"><legend>自定义条目</legend>
        <div class="character-entry-list"></div>${ui.button('add-character-entry', '添加条目', 'plus', 'secondary')}</fieldset>
        <input type="hidden" name="entries" value="${ui.esc(values.entries)}">` : '');
    host.value.innerHTML = shared.editor(fields, { label, cancel: props.cancel, required: !extended });
    for (const field of host.value.querySelectorAll<HTMLElement>('.field')) {
      field.classList.add('ui-field');
      for (const control of field.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input:not([type="checkbox"]), select, textarea',
      )) control.classList.add('ui-input');
    }
    host.value.querySelector('.form-note')?.classList.add('ui-field-note');
    host.value.querySelector('#save-error')?.classList.add('ui-field-error');
    const entryRegion = host.value.querySelector<HTMLElement>('#character-entries');
    const entryValue = host.value.querySelector<HTMLInputElement>('input[name="entries"]');
    let entries: { get(): AuthorEntry[]; render(value: AuthorEntry[]): void } | undefined;
    if (entryRegion && entryValue) {
      entries = blocks.bindEntries(entryRegion, JSON.parse(entryValue.value), choices, {
        canUpload: props.operations.has('asset.import'),
        retain() {
          entryValue.value = JSON.stringify(entries!.get());
          entryValue.dispatchEvent(new Event('input', { bubbles: true }));
        },
      });
    }
    const ctx = {
      main: host.value, signal: controller.signal, key: props.url.pathname + props.url.search,
      active: () => !controller.signal.aborted, refresh: () => emit('refresh'),
      saved(destination: string, announcement: string) {
        if (!controller.signal.aborted) {
          host.value?.dispatchEvent(new CustomEvent('sth:announce', { detail: announcement, bubbles: true }));
          emit('navigate', destination);
        }
      },
    };
    shared.bindEditor(ctx, draft, {
      operation: operationId, label,
      success: character ? '角色设定已保存' : '角色已创建',
      result: (result: Character) => api.entity(result, 'characterId'),
      href: (result: Character) => href(result.characterId),
      input(current: Draft) {
        const { name, persona, projectId } = current.values;
        const input = { name: name.trim(), persona, ...(extended ? { entries: JSON.parse(current.values.entries!) } : {}) };
        if (character) return { ...input, characterId: character.characterId, expectedRevision: current.record.revision };
        return projectId ? { ...input, projectId } : input;
      },
      latestValues: character ? characterValues : undefined,
      applied: () => { if (entryValue) entries?.render(JSON.parse(entryValue.value)); },
      lock: (locked: boolean) => { if (entryRegion) entryRegion.inert = locked; },
      conflictText: '角色设定已有新版。请核对最新设定，再决定如何继续。',
      readLatest: (_: Draft, signal: AbortSignal) => readCharacter(character!.characterId, signal),
      preview: (latest: Character) => `<details open><summary>最新版本 · 第 ${ui.esc(latest.revision)} 版</summary>
        <p class="revision-title">${ui.esc(latest.name)}</p><div class="revision-text">${ui.esc(latest.persona)}</div></details>`,
    });
  } catch (reason) {
    if (!controller.signal.aborted) error.value = reason instanceof Error && !(reason as { status?: number }).status ? reason.message : errorText(reason);
  } finally { if (!controller.signal.aborted) busy.value = false; }
}
onMounted(() => { void renderForm(); });
onScopeDispose(() => controller.abort());
</script>

<template>
  <section class="characters-editor" :aria-busy="busy" aria-label="角色编辑表单">
    <p v-if="busy" role="status">正在读取编辑选项…</p>
    <div v-if="error"><p role="alert">{{ error }}</p><Button type="button" class="characters-button" variant="outline" @click="renderForm">重试</Button></div>
    <div ref="host" v-show="!busy && !error" />
  </section>
</template>
