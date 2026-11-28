<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  all,
  draftKey,
  href,
  read,
  recordHref,
  revisionParam,
  version,
} from './api.ts';
import type {
  Backlink,
  Draft,
  DraftSummary,
  Narrative,
  Scene,
  SceneSummary,
} from './api.ts';
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
const readerHref = props.url.pathname + props.url.search + props.url.hash;
const passage = ref<InstanceType<typeof ManuscriptBody>>();
const editor = ref<InstanceType<typeof DraftEditor>>();
const modeKey = `sth:writing:mode:${props.url.pathname}@${props.url.searchParams.get('revision') ?? 'current'}`;
const editing = ref(stored<boolean>(modeKey) === true);
const selection = ref<PassageRange>();
const revisedDraft = ref<Draft>();
const sceneHistory = ref<HTMLDetailsElement>();
const sceneActions = ref<HTMLDetailsElement>();
const { data, busy, error, reload } = useRead(async (signal) => {
  const sceneId = 'id' in props.route ? props.route.id : '';
  const scene = await read<Scene>(
    'scene.read',
    { sceneId, revision: revisionParam(props.url.searchParams) },
    signal,
  );
  const [drafts, revisions, branches, narratives, chapter, evidence] =
    await Promise.all([
      all<DraftSummary>('draft.list', { sceneId }, signal),
      all<SceneSummary>('scene.revisions', { sceneId }, signal),
      all<SceneSummary>('scene.list', { branchOf: sceneId }, signal),
      all<Narrative>('narrative.list', { sceneId }, signal),
      scene.placement
        ? read<{ title: string }>(
            'chapter.read',
            { chapterId: scene.placement.chapterId },
            signal,
          )
        : undefined,
      all<Backlink>(
        'character.backlinks',
        { kind: 'scene', id: sceneId, revision: scene.revision },
        signal,
      ),
    ]);
  const candidate =
    !scene.adopted && drafts[0]
      ? await read<Draft>(
          'draft.read',
          { draftId: drafts[0].draftId, revision: drafts[0].revision },
          signal,
        )
      : undefined;
  const manuscript = scene.adopted ?? candidate;
  const context =
    manuscript && manuscript.sceneRevision !== scene.revision
      ? await read<Scene>(
          'scene.read',
          { sceneId, revision: manuscript.sceneRevision },
          signal,
        )
      : scene;
  if (!signal.aborted) {
    document.title = `${scene.title} · Sth`;
    rememberManuscript({
      kind: 'scene',
      id: sceneId,
      href: readerHref,
      title: scene.title,
      sceneId,
    }, true);
  }
  return {
    scene,
    drafts,
    revisions,
    branches,
    narratives,
    chapter,
    candidate,
    context,
    evidence,
  };
});
const manuscript = computed(
  () =>
    revisedDraft.value ?? data.value?.scene.adopted ?? data.value?.candidate,
);
const adopted = computed(
  () =>
    manuscript.value &&
    data.value?.scene.adopted &&
    draftKey(manuscript.value) === draftKey(data.value.scene.adopted),
);
const historicalAdoption = computed(() => {
  const loaded = data.value;
  if (loaded && loaded.scene.revision !== loaded.revisions[0]?.revision)
    return `场景${version(loaded.scene.revision)}采用`;
});
const adoptedDraftLabel = computed(() => {
  const draft = data.value?.scene.adopted;
  if (!draft) return;
  const draftRevision = version(draft.revision);
  return historicalAdoption.value
    ? `${historicalAdoption.value} · 稿件${draftRevision}`
    : `已采用${draftRevision}`;
});
const latestManuscriptRevision = computed(() =>
  data.value?.drafts.find(draft => draft.draftId === manuscript.value?.draftId)?.revision,
);
const back = computed(() =>
  returnHref(
    props.url,
    data.value?.scene.placement
      ? recordHref('chapters', data.value.scene.placement.chapterId)
      : '/create',
  ),
);
function edit() {
  if (!manuscript.value || !data.value) {
    if (data.value)
      emit(
        'navigate',
        href('/drafts/new', {
          sceneId: data.value.scene.sceneId,
          revision: data.value.scene.revision,
        }),
      );
    return;
  }
  if (!editing.value) {
    selection.value = passage.value?.selection();
    passage.value?.remember();
  }
  if (location.pathname !== props.url.pathname) {
    emit('navigate', href(recordHref('drafts', manuscript.value.draftId), {
      revision: manuscript.value.revision,
      returnTo: readerHref,
      ...selection.value,
      edit: editing.value ? undefined : '1',
    }));
    if (editing.value) retain(modeKey);
    return;
  }
  editing.value = !editing.value;
  retain(modeKey, editing.value);
}
function finishEditing() {
  editing.value = false;
  retain(modeKey);
}
function saved(draft: Draft) {
  revisedDraft.value = draft;
  if (data.value)
    data.value = {
      ...data.value,
      drafts: data.value.drafts.map((item) =>
        item.draftId === draft.draftId ? draft : item,
      ),
    };
  finishEditing();
  rememberManuscript({
    kind: 'draft',
    id: draft.draftId,
    href: href(recordHref('drafts', draft.draftId), {
      returnTo: readerHref,
    }),
    title: draft.title,
    sceneId: draft.sceneId,
  });
}
function switchDraft(event: Event) {
  const key = (event.target as HTMLSelectElement).value;
  const adopted = data.value?.scene.adopted;
  const draft = data.value?.drafts.find((item) => draftKey(item) === key) ??
    (adopted && draftKey(adopted) === key ? adopted : undefined);
  if (draft)
    emit(
      'navigate',
      href(recordHref('drafts', draft.draftId), {
        revision: draft.revision,
        returnTo: readerHref,
      }),
    );
}
function switchVersion(event: Event) {
  if (data.value)
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
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && !busy && !error">
    <ManuscriptTools
      :back="back"
      :back-label="data.scene.placement ? '返回章节' : '返回场景列表'"
      :title="manuscript?.title ?? data.scene.title"
      :revision="manuscript?.revision"
      :latest-revision="latestManuscriptRevision"
      :status="adopted ? '采用稿' : manuscript ? '候选稿' : '暂无稿件'"
      :adopted-label="adopted ? historicalAdoption : undefined"
      :scene-historical="!!historicalAdoption"
      :alternate="!!(data.scene.branchFrom || data.scene.branchId)"
      :placement="data.scene.placement"
      :chapter-title="data.chapter?.title"
      :scene-title="data.scene.title"
      :editing="editing"
      :saveable="editing"
      :save-disabled="!editor || editor.saving"
      :edit-label="!manuscript ? '写作' : undefined"
      @edit="edit"
      @save="editor?.requestSave()"
    >
      <template #versions>
        <label v-if="manuscript">稿件<select aria-label="切换稿件" :value="draftKey(manuscript)" @change="switchDraft">
          <option v-if="data.scene.adopted" :value="draftKey(data.scene.adopted)">
            {{ data.scene.adopted.title }} · {{ adoptedDraftLabel }}
          </option>
          <option
            v-for="draft in data.drafts.filter(item => !data!.scene.adopted || draftKey(item) !== draftKey(data!.scene.adopted))"
            :key="draftKey(draft)"
            :value="draftKey(draft)"
          >{{ draft.title }} · {{ version(draft.revision) }} · 最新</option>
        </select></label>
        <label>场景版本<select aria-label="切换场景版本" :value="data.scene.revision" @change="switchVersion">
          <option v-for="item in data.revisions" :key="item.revision" :value="item.revision">
            {{ version(item.revision) }}{{ item.revision === data.revisions[0]?.revision ? ' · 最新' : '' }}
          </option>
        </select></label>
      </template>
      <a
        :href="
          href('/drafts/new', {
            sceneId: data.scene.sceneId,
            revision: data.scene.revision,
          })
        "
        >新建候选稿</a
      >
      <a
        v-if="manuscript"
        :href="
          href(recordHref('drafts', manuscript.draftId), {
            revision: manuscript.revision,
            action: 'adopt',
          })
        "
        >采纳此版本</a
      >
      <a
        :href="
          href(recordHref('scenes', data.scene.sceneId), {
            action: 'compare',
            revision: revisionParam(url.searchParams),
            returnTo: readerHref,
          })
        "
        >对照候选稿</a
      >
      <a
        :href="
          href(recordHref('scenes', data.scene.sceneId), {
            revision: data.scene.revision,
            action: 'branch',
          })
        "
        >建立 IF 分支</a
      >
      <a
        v-if="data.revisions[0]?.revision === data.scene.revision"
        :href="
          href(recordHref('scenes', data.scene.sceneId), { action: 'revise' })
        "
        >修订场景</a
      >
      <a href="#candidates" @click="sceneActions && (sceneActions.open = true)"
        >候选稿与场景操作</a
      >
      <a
        href="#scene-history"
        @click="sceneHistory && (sceneHistory.open = true)"
        >版本历史</a
      >
      <a
        v-if="url.searchParams.has('revision')"
        :href="versionHref()"
        >查看当前版本</a
      >
      <a
        v-if="data.scene.placement"
        :href="recordHref('projects', data.scene.placement.projectId)"
        >返回作品</a
      >
    </ManuscriptTools>
    <header class="wr-heading wr-reader-heading">
      <h1>{{ data.scene.title }}</h1>
    </header>
    <p v-if="revisedDraft" role="status" class="wr-save-message">
      修订已保存为候选稿。核对后可采用此版本。
    </p>
    <section
      id="manuscript"
      class="wr-section wr-manuscript wr-reader-sheet"
      :aria-label="adopted ? (historicalAdoption ?? '当前采用稿') : '稿件正文'"
    >
      <template v-if="manuscript">
        <DraftEditor
          v-if="editing"
          ref="editor"
          :key="draftKey(manuscript)"
          :route="route"
          :url="url"
          inline
          :draft="manuscript"
          :scene="data.context"
          :selection="selection"
          @saved="saved"
          @cancel="finishEditing"
          @navigate="emit('navigate', $event)"
        />
        <ManuscriptBody
          v-else
          ref="passage"
          :body="manuscript.body"
          :reading-key="`scene:${data.scene.sceneId}@${data.scene.revision}:${draftKey(manuscript)}`"
          :url="url"
        />
      </template>
      <div v-else class="wr-empty-manuscript">
        <h2>写下这一幕</h2>
        <p class="wr-muted">尚未采纳候选稿。可从当前场景上下文开始写作。</p>
        <a
          class="wr-button wr-primary"
          :href="
            href('/drafts/new', {
              sceneId: data.scene.sceneId,
              revision: data.scene.revision,
            })
          "
          >新建候选稿</a
        >
      </div>
    </section>
    <ManuscriptEvidence :scene="data.context" :draft="manuscript" />
    <details class="wr-section">
      <summary>场景上下文与角色证据</summary>
      <SceneContext :scene="data.scene" /><EvidenceLinks
        :items="data.evidence"
      />
    </details>
    <details id="candidates" ref="sceneActions" class="wr-section">
      <summary>候选稿与场景操作</summary>
      <section>
        <h2>候选稿</h2>
        <ul v-if="data.drafts.length" class="wr-candidates">
          <li v-for="draft in data.drafts" :key="draft.draftId">
            <div>
              <h3>
                <a :href="href(recordHref('drafts', draft.draftId), { returnTo: readerHref })">{{
                  draft.title
                }}</a>
              </h3>
              <p class="wr-muted">
                {{ version(draft.revision) }} · 场景上下文
                {{ version(draft.sceneRevision) }}
              </p>
              <p
                v-if="data.scene.adopted?.draftId === draft.draftId"
                class="wr-selected"
              >
                {{ adoptedDraftLabel }}<span v-if="draft.revision !== data.scene.adopted.revision"
                  >，当前候选稿另有修订</span
                >
              </p>
            </div>
            <a
              :href="
                href(recordHref('drafts', draft.draftId), {
                  revision: draft.revision,
                  action: 'adopt',
                })
              "
              >核对并采纳</a
            >
          </li>
        </ul>
        <p v-else class="wr-muted">还没有候选稿。</p>
        <a
          :href="
            href('/drafts/new', {
              sceneId: data.scene.sceneId,
              revision: data.scene.revision,
            })
          "
          >新建候选稿</a
        >
      </section>
      <section v-if="data.scene.branchFrom" class="wr-section">
        <h2>IF 分歧来源</h2>
        <p class="wr-prose">{{ data.scene.branchFrom.divergence }}</p>
        <nav class="wr-actions" aria-label="IF 来源">
          <a
            :href="
              recordHref(
                'scenes',
                data.scene.branchFrom.sceneId,
                data.scene.branchFrom.revision,
              )
            "
            >原场景 · {{ version(data.scene.branchFrom.revision) }}</a
          ><a
            v-if="data.scene.branchFrom.draft"
            :href="
              recordHref(
                'drafts',
                data.scene.branchFrom.draft.draftId,
                data.scene.branchFrom.draft.revision,
              )
            "
            >原候选稿 · {{ version(data.scene.branchFrom.draft.revision) }}</a
          >
        </nav>
      </section>
      <section class="wr-section">
        <h2>事件与讲述</h2>
        <nav class="wr-actions" aria-label="讲述操作">
          <a
            :href="
              href('/narratives/new', {
                sceneId: data.scene.sceneId,
                sceneRevision: data.scene.revision,
              })
            "
            >新建讲述</a
          ><a
            :href="
              href('/events', {
                branchId:
                  data.scene.branchId ??
                  (data.scene.branchFrom ? data.scene.sceneId : undefined),
              })
            "
            >查看事件</a
          ><a
            v-if="data.scene.branchId || data.scene.branchFrom"
            :href="
              recordHref('branches', data.scene.branchId ?? data.scene.sceneId)
            "
            >查看 IF 接续</a
          >
        </nav>
        <ul class="wr-list">
          <li v-for="item in data.narratives" :key="item.narrativeId">
            <a :href="recordHref('narratives', item.narrativeId, item.revision)"
              >{{ item.title }} · {{ version(item.revision) }}</a
            >
          </li>
        </ul>
      </section>
      <section v-if="data.branches.length" class="wr-section">
        <h2>IF 分支场景</h2>
        <ul class="wr-list">
          <li v-for="branch in data.branches" :key="branch.sceneId">
            <a :href="recordHref('scenes', branch.sceneId)"
              >{{ branch.title }} · {{ version(branch.revision) }}</a
            >
          </li>
        </ul>
      </section>
      <section v-if="data.scene.placement" class="wr-section">
        <h2>场景构图</h2>
        <nav class="wr-actions" aria-label="构图操作">
          <a
            :href="
              href('/compositions/new', {
                sceneId: data.scene.sceneId,
                revision: data.scene.revision,
              })
            "
            >新建构图</a
          ><a
            :href="
              href('/compositions', {
                projectId: data.scene.placement.projectId,
                sceneId: data.scene.sceneId,
              })
            "
            >查看构图</a
          ><a :href="recordHref('chapters', data.scene.placement.chapterId)"
            >{{ data.chapter?.title }} · 位置
            {{ data.scene.placement.position }}</a
          ><a
            :href="
              href('/author-context', {
                projectId: data.scene.placement.projectId,
                branchId: data.scene.branchId,
              })
            "
            >创作决定</a
          >
        </nav>
      </section>
    </details>
    <details
      id="scene-history"
      ref="sceneHistory"
      class="wr-section wr-history-details"
    >
      <summary>版本历史 · {{ data.revisions.length }} 版</summary>
      <ul class="wr-history">
        <li v-for="item in data.revisions" :key="item.revision">
          <a
            :href="versionHref(item.revision)"
            :aria-current="
              item.revision === data.scene.revision ? 'page' : undefined
            "
            >{{ version(item.revision) }}</a><span
            v-if="item.revision === data.scene.revision"
            class="wr-muted"
            >正在阅读</span
          >
        </li>
      </ul>
    </details>
  </template>
</template>
