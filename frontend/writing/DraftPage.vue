<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import {
  all,
  draftKey,
  href,
  read,
  recordHref,
  revisionParam,
  version,
} from './api.ts';
import type { Backlink, Draft, DraftSummary, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { retain, stored, useRead } from './state.ts';
import { returnHref } from './reading.ts';
import type { PassageRange } from './reading.ts';
import { rememberManuscript } from '../manuscript/recent.ts';
import ReadState from './ReadState.vue';
import DraftEditor from './DraftEditor.vue';
import ManuscriptBody from './ManuscriptBody.vue';
import ManuscriptTools from './ManuscriptTools.vue';
import ManuscriptEvidence from './ManuscriptEvidence.vue';
import SceneContext from './SceneContext.vue';
import EvidenceLinks from './EvidenceLinks.vue';

const props = defineProps<{ route: WritingRoute; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const readerUrl = new URL(props.url);
readerUrl.searchParams.delete('edit');
const passage = ref<InstanceType<typeof ManuscriptBody>>();
const editor = ref<InstanceType<typeof DraftEditor>>();
const historyDetails = ref<HTMLDetailsElement>();
const modeKey = `sth:writing:mode:${props.url.pathname}@${props.url.searchParams.get('revision') ?? 'current'}`;
const editing = ref(
  props.url.searchParams.get('edit') === '1' ||
    stored<boolean>(modeKey) === true,
);
const selection = ref<PassageRange>();
const selectionError = ref('');
const savedMessage = ref('');
const { data, busy, error, reload } = useRead(async (signal) => {
  const draftId = 'id' in props.route ? props.route.id : '';
  const draft = await read<Draft>(
    'draft.read',
    { draftId, revision: revisionParam(props.url.searchParams) },
    signal,
  );
  const [scene, revisions, drafts, evidence] = await Promise.all([
    read<Scene>(
      'scene.read',
      { sceneId: draft.sceneId, revision: draft.sceneRevision },
      signal,
    ),
    all<DraftSummary>('draft.revisions', { draftId }, signal),
    all<DraftSummary>('draft.list', { sceneId: draft.sceneId }, signal),
    all<Backlink>(
      'character.backlinks',
      { kind: 'draft', id: draftId, revision: draft.revision },
      signal,
    ),
  ]);
  if (!signal.aborted) {
    document.title = `${draft.title} · Sth`;
    rememberManuscript({
      kind: 'draft',
      id: draftId,
      href: readerUrl.pathname + readerUrl.search + readerUrl.hash,
      title: draft.title,
      sceneId: draft.sceneId,
    }, true);
  }
  return { draft, scene, revisions, drafts, evidence };
});
const back = computed(() =>
  returnHref(
    props.url,
    data.value ? recordHref('scenes', data.value.draft.sceneId) : '/create',
  ),
);
const historical = computed(
  () =>
    !!data.value &&
    data.value.revisions[0]?.revision !== data.value.draft.revision,
);
function edit() {
  if (!editing.value) {
    selection.value = passage.value?.selection();
    passage.value?.remember();
  }
  if (location.pathname !== props.url.pathname) {
    const destination = new URL(readerUrl);
    if (!editing.value) {
      destination.searchParams.set('edit', '1');
      if (selection.value) {
        destination.searchParams.set('start', String(selection.value.start));
        destination.searchParams.set('end', String(selection.value.end));
      }
    } else retain(modeKey);
    emit('navigate', destination.pathname + destination.search + destination.hash);
    return;
  }
  if (editing.value && props.url.searchParams.get('edit') === '1') {
    finishEditing();
    emit('navigate', readerUrl.pathname + readerUrl.search + readerUrl.hash);
    return;
  }
  editing.value = !editing.value;
  retain(modeKey, editing.value);
}
function finishEditing() {
  editing.value = false;
  retain(modeKey);
}
async function saved(draft: Draft) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    draft,
    drafts: data.value.drafts.map((item) =>
      item.draftId === draft.draftId ? draft : item,
    ),
    revisions: [
      draft,
      ...data.value.revisions.filter(
        (item) => item.revision !== draft.revision,
      ),
    ],
  };
  finishEditing();
  savedMessage.value = '修订已保存为候选稿。核对后可采用此版本。';
  document.title = `${draft.title} · Sth`;
  const destination = href(recordHref('drafts', draft.draftId), {
    returnTo: props.url.searchParams.get('returnTo'),
  });
  if (
    props.url.searchParams.has('revision') ||
    props.url.searchParams.has('edit') ||
    props.url.searchParams.has('start') ||
    props.url.hash
  )
    emit('navigate', destination);
  await nextTick();
  rememberManuscript({
    kind: 'draft',
    id: draft.draftId,
    href: destination,
    title: draft.title,
    sceneId: draft.sceneId,
  });
}
function switchDraft(event: Event) {
  emit(
    'navigate',
    href(recordHref('drafts', (event.target as HTMLSelectElement).value), {
      returnTo: back.value,
    }),
  );
}
function switchVersion(event: Event) {
  if (!data.value) return;
  emit(
    'navigate',
    versionHref(Number((event.target as HTMLSelectElement).value)),
  );
}
function versionHref(revision?: number) {
  return href(props.url.pathname, {
    revision,
    returnTo: props.url.searchParams.get('returnTo'),
  });
}
function cite(kind: 'character' | 'event') {
  if (!data.value) return;
  const chosen = passage.value?.selection();
  if (
    !chosen ||
    !data.value.draft.body.slice(chosen.start, chosen.end).trim()
  ) {
    selectionError.value = '请先选中一段原文。';
    return;
  }
  const draft = data.value.draft;
  emit(
    'navigate',
    kind === 'character'
      ? href(recordHref('drafts', draft.draftId), {
          revision: draft.revision,
          ...chosen,
          action: 'adopt-entry',
        })
      : href('/events/new', {
          draftId: draft.draftId,
          draftRevision: draft.revision,
          ...chosen,
        }),
  );
}
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && !busy && !error">
    <ManuscriptTools
      :back="back"
      :back-label="`返回${data.scene.title}`"
      :title="data.draft.title"
      :editing="editing"
      :saveable="editing"
      :save-disabled="!editor || editor.saving"
      :edit-label="historical && !editing ? '编辑旧版' : undefined"
      @edit="edit"
      @save="editor?.requestSave()"
    >
      <a
        :href="
          href(recordHref('drafts', data.draft.draftId), {
            revision: data.draft.revision,
            action: 'adopt',
          })
        "
        >采纳此版本</a
      >
      <a
        :href="
          href(recordHref('scenes', data.scene.sceneId), {
            revision: data.scene.revision,
            action: 'branch',
            draftId: data.draft.draftId,
            draftRevision: data.draft.revision,
          })
        "
        >从此稿建立 IF</a
      >
      <a
        :href="
          href(recordHref('scenes', data.scene.sceneId), {
            action: 'compare',
            left: draftKey(data.draft),
            returnTo: url.pathname + url.search + url.hash,
          })
        "
        >对照候选稿</a
      >
      <a
        :href="
          href('/generations/new', {
            draftId: data.draft.draftId,
            draftRevision: data.draft.revision,
          })
        "
        >用此稿准备写作</a
      >
      <a
        :href="
          href(recordHref('drafts', data.draft.draftId), {
            revision: data.draft.revision,
            action: 'revise',
            returnTo: url.searchParams.get('returnTo'),
          })
        "
        >修订候选稿</a
      >
      <button type="button" @click="cite('character')">采纳为角色条目</button>
      <button type="button" @click="cite('event')">提炼为事件</button>
      <a
        href="#draft-history"
        @click="historyDetails && (historyDetails.open = true)"
        >版本历史</a
      >
      <a
        v-if="historical || url.searchParams.has('revision')"
        :href="versionHref()"
        >查看当前版本</a
      >
    </ManuscriptTools>
    <header class="wr-heading wr-reader-heading">
      <h1>{{ data.draft.title }}</h1>
      <div class="wr-version-bar">
        <label
          >稿件<select
            aria-label="切换稿件"
            :value="data.draft.draftId"
            @change="switchDraft"
          >
            <option
              v-for="draft in data.drafts"
              :key="draft.draftId"
              :value="draft.draftId"
            >
              {{ draft.title }}
            </option>
          </select></label
        >
        <label
          >版本<select
            aria-label="切换稿件版本"
            :value="data.draft.revision"
            @change="switchVersion"
          >
            <option
              v-for="item in data.revisions"
              :key="item.revision"
              :value="item.revision"
            >
              {{ version(item.revision)
              }}{{
                item.revision === data.revisions[0]?.revision ? ' · 最新' : ''
              }}
            </option>
          </select></label
        >
        <span class="wr-muted"
          >候选稿<span v-if="historical"> · 正在阅读旧版</span></span
        >
      </div>
    </header>
    <p v-if="savedMessage" role="status" class="wr-save-message">
      {{ savedMessage }}
    </p>
    <section
      class="wr-section wr-manuscript wr-reader-sheet"
      aria-label="稿件正文"
    >
      <DraftEditor
        v-if="editing"
        ref="editor"
        :key="draftKey(data.draft)"
        :route="route"
        :url="url"
        inline
        :draft="data.draft"
        :scene="data.scene"
        :selection="selection"
        @saved="saved"
        @cancel="edit"
        @navigate="emit('navigate', $event)"
      />
      <ManuscriptBody
        v-else
        ref="passage"
        :body="data.draft.body"
        :reading-key="`draft:${draftKey(data.draft)}`"
        :url="url"
      />
      <p v-if="selectionError" role="status">{{ selectionError }}</p>
    </section>
    <ManuscriptEvidence :scene="data.scene" :draft="data.draft" />
    <details class="wr-section">
      <summary>引用上下文与角色证据</summary>
      <SceneContext :scene="data.scene" /><EvidenceLinks
        :items="data.evidence"
      />
    </details>
    <details
      id="draft-history"
      ref="historyDetails"
      class="wr-section wr-history-details"
    >
      <summary>版本历史 · {{ data.revisions.length }} 版</summary>
      <ul class="wr-history">
        <li v-for="item in data.revisions" :key="item.revision">
          <a
            :href="versionHref(item.revision)"
            :aria-current="
              item.revision === data.draft.revision ? 'page' : undefined
            "
            >{{ version(item.revision) }}</a><span
            v-if="item.revision === data.draft.revision"
            class="wr-muted"
            >正在阅读</span
          >
        </li>
      </ul>
    </details>
  </template>
</template>
