<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import {
  all,
  ApiError,
  draftKey,
  href,
  read,
  recordHref,
  revisionParam,
  version,
} from './api.ts';
import type { Draft, DraftSummary, Scene } from './api.ts';
import type { WritingRoute } from './routes.ts';
import { retain, stored, useRead } from './state.ts';
import { returnHref } from './reading.ts';
import { compareLines } from './diff.ts';
import ReadState from './ReadState.vue';
import SceneContext from './SceneContext.vue';
import './review.css';
const props = defineProps<{ route: WritingRoute; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const pinnedScene = props.url.searchParams.has('revision');
const leftKey = ref('');
const rightKey = ref('');
const differences = ref(true);
const comparison = ref<HTMLElement>();
const activeSide = ref<'left' | 'right'>('left');
const smallScreen = matchMedia('(max-width: 48rem)');
const compact = ref(smallScreen.matches);
const heights = ref<number[]>([]);
const headerHeight = ref(0);
const { data, busy, error, reload } = useRead(async (signal) => {
  const sceneId = 'id' in props.route ? props.route.id : '';
  const scene = await read<Scene>(
    'scene.read',
    { sceneId, revision: revisionParam(props.url.searchParams) },
    signal,
  );
  const drafts = await all<DraftSummary>('draft.list', { sceneId }, signal);
  const versions = (
    await Promise.all(
      drafts.map((draft) =>
        all<DraftSummary>(
          'draft.revisions',
          { draftId: draft.draftId },
          signal,
        ),
      ),
    )
  ).flat();
  const select = (key: string | null) =>
    versions.find((draft) => draftKey(draft) === key);
  const left =
    select(props.url.searchParams.get('left')) ??
    (props.url.searchParams.has('left') ? undefined : versions[0]);
  const right =
    select(props.url.searchParams.get('right')) ??
    (props.url.searchParams.has('right')
      ? undefined
      : (versions.find((draft) => draft.draftId !== left?.draftId) ??
        versions[1]));
  if (
    (props.url.searchParams.has('left') && !left) ||
    (props.url.searchParams.has('right') && !right)
  )
    throw new ApiError(404, 'draft_version_not_found', '未找到所选稿件版本。');
  leftKey.value = left ? draftKey(left) : '';
  rightKey.value = right ? draftKey(right) : '';
  const compared =
    left && right
      ? await read<{ left: Draft; right: Draft }>(
          'draft.compare',
          {
            sceneId,
            left: { draftId: left.draftId, revision: left.revision },
            right: { draftId: right.draftId, revision: right.revision },
          },
          signal,
        )
      : undefined;
  const contexts = compared
    ? await Promise.all(
        [compared.left, compared.right].map((draft) =>
          read<Scene>(
            'scene.read',
            { sceneId, revision: draft.sceneRevision },
            signal,
          ),
        ),
      )
    : [];
  if (!signal.aborted) document.title = `对照候选稿 · ${scene.title} · Sth`;
  return { scene, drafts, versions, compared, contexts };
});
const adoptionLabels = computed(() => {
  const sceneVersion = data.value ? `场景${version(data.value.scene.revision)}` : '';
  return pinnedScene
    ? { scope: `${sceneVersion} · 采用状态`, adopted: `${sceneVersion}采用`, other: `${sceneVersion}未采用` }
    : { scope: `${sceneVersion} · 当前采用状态`, adopted: '采用稿', other: '候选稿' };
});
const lines = computed(() =>
  data.value?.compared
    ? compareLines(
        data.value.compared.left.body,
        data.value.compared.right.body,
      )
    : undefined,
);
const back = computed(() =>
  returnHref(
    props.url,
    data.value
      ? recordHref(
          'scenes',
          data.value.scene.sceneId,
          revisionParam(props.url.searchParams),
        )
      : '/create',
  ),
);
function positionKey() {
  const compared = data.value?.compared;
  return `sth:writing:comparison:${data.value?.scene.sceneId}:${compared ? draftKey(compared.left) : ''}:${compared ? draftKey(compared.right) : ''}`;
}
function paragraphPosition() {
  const article = comparison.value?.querySelector<HTMLElement>(
    `[data-side="${activeSide.value}"]`,
  );
  const top = Math.max(
    88,
    (comparison.value
      ?.closest('.writing-route')
      ?.querySelector('.wr-compare-switch')
      ?.getBoundingClientRect().bottom ?? 0) + 12,
  );
  const rows = Array.from(
    article?.querySelectorAll<HTMLElement>('[data-compare-row]') ?? [],
  );
  const row = rows.find((item) => item.getBoundingClientRect().bottom > top);
  return row
    ? {
        row: Number(row.dataset.compareRow),
        top: row.getBoundingClientRect().top,
      }
    : undefined;
}
function moveToParagraph(position: { row: number; top: number }) {
  const row = comparison.value?.querySelector<HTMLElement>(
    `[data-side="${activeSide.value}"] [data-compare-row="${position.row}"]`,
  );
  if (row)
    window.scrollBy({
      top: row.getBoundingClientRect().top - position.top,
      behavior: 'instant',
    });
}
async function switchSide(side: 'left' | 'right') {
  if (activeSide.value === side) return;
  const position = paragraphPosition();
  activeSide.value = side;
  await nextTick();
  if (position) moveToParagraph(position);
  rememberPosition();
}
function rememberPosition() {
  const position = paragraphPosition();
  if (position) retain(positionKey(), { ...position, side: activeSide.value });
}
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
function onScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(rememberPosition, 140);
}
let observer: ResizeObserver | undefined;
let lastWidth = 0;
async function alignParagraphs() {
  heights.value = [];
  headerHeight.value = 0;
  await nextTick();
  if (compact.value || !comparison.value) return;
  const columns = ['left', 'right'].map((side) =>
    comparison.value!.querySelector<HTMLElement>(`[data-side="${side}"]`)!,
  );
  const rowHeights = columns.map((column) =>
    Array.from(column.querySelectorAll<HTMLElement>('[data-compare-row]')).map(
      (row) => row.getBoundingClientRect().height,
    ),
  );
  heights.value = rowHeights[0]!.map((height, index) =>
    Math.max(height, rowHeights[1]![index] ?? 0),
  );
  headerHeight.value = Math.max(
    ...columns.map(
      (column) =>
        column.querySelector('header')!.getBoundingClientRect().height,
    ),
  );
}
function resized() {
  compact.value = smallScreen.matches;
  void alignParagraphs();
}
watch(
  [comparison, differences],
  async () => {
    await alignParagraphs();
    if (comparison.value && !observer) {
      observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (Math.abs(width - lastWidth) > 1) {
          lastWidth = width;
          void alignParagraphs();
        }
      });
      observer.observe(comparison.value);
    }
  },
  { flush: 'post' },
);
watch(busy, async (value) => {
  if (value || error.value) return;
  const position = stored<{ row: number; top: number; side: 'left' | 'right' }>(
    positionKey(),
  );
  if (!position || props.url.hash) return;
  if (position.side === 'left' || position.side === 'right')
    activeSide.value = position.side;
  await nextTick();
  if (Number.isSafeInteger(position.row) && Number.isFinite(position.top))
    requestAnimationFrame(() => moveToParagraph(position));
});
onMounted(() => {
  smallScreen.addEventListener('change', resized);
  window.addEventListener('scroll', onScroll, { passive: true });
});
onBeforeUnmount(() => {
  rememberPosition();
  clearTimeout(scrollTimer);
  observer?.disconnect();
  smallScreen.removeEventListener('change', resized);
  window.removeEventListener('scroll', onScroll);
});
function compare() {
  if (!data.value) return;
  emit(
    'navigate',
    href(recordHref('scenes', data.value.scene.sceneId), {
      revision: revisionParam(props.url.searchParams),
      action: 'compare',
      left: leftKey.value,
      right: rightKey.value,
      returnTo: props.url.searchParams.get('returnTo'),
    }),
  );
}
function isAdopted(draft: DraftSummary) {
  const adopted = data.value?.scene.adopted;
  return !!adopted && draftKey(adopted) === draftKey(draft);
}
function latestRevision(draft: DraftSummary) {
  return data.value?.drafts.find(item => item.draftId === draft.draftId)?.revision;
}
</script>
<template>
  <ReadState :busy="busy" :error="error" @retry="reload" />
  <template v-if="data && !busy && !error">
    <header class="wr-heading wr-reader-heading wr-compare-heading wr-review-page wr-review-compare">
      <a :href="back">返回{{ data.scene.title }}</a>
      <h1>对照候选稿</h1>
      <p class="wr-muted">{{ adoptionLabels.scope }}</p>
      <p v-if="data.scene.branchFrom || data.scene.branchId" class="wr-muted">IF 分支</p>
    </header>
    <template v-if="data.compared && lines">
      <details class="wr-compare-versions">
        <summary>选择对照版本</summary>
      <form
        class="wr-compare-form"
        aria-label="选择对照版本"
        method="get"
        :action="recordHref('scenes', data.scene.sceneId)"
        @submit.prevent="compare"
      >
        <div>
          <label for="wr-left">左稿</label
          ><select id="wr-left" v-model="leftKey" name="left">
            <option
              v-for="draft in data.versions"
              :key="draftKey(draft)"
              :value="draftKey(draft)"
            >
              {{ draft.title }} · {{ version(draft.revision) }}{{ isAdopted(draft) ? ` · ${adoptionLabels.adopted}` : '' }}{{ latestRevision(draft) === draft.revision ? ' · 最新' : '' }}
            </option>
          </select>
        </div>
        <div>
          <label for="wr-right">右稿</label
          ><select id="wr-right" v-model="rightKey" name="right">
            <option
              v-for="draft in data.versions"
              :key="draftKey(draft)"
              :value="draftKey(draft)"
            >
              {{ draft.title }} · {{ version(draft.revision) }}{{ isAdopted(draft) ? ` · ${adoptionLabels.adopted}` : '' }}{{ latestRevision(draft) === draft.revision ? ' · 最新' : '' }}
            </option>
          </select>
        </div>
        <button type="submit" class="wr-button">对照</button>
      </form>
      </details>
      <nav class="wr-compare-switch wr-review-controls" aria-label="同段切换">
        <button
          type="button"
          class="wr-tool"
          :aria-pressed="activeSide === 'left'"
          @click="switchSide('left')"
        >
          左稿</button
        ><button
          type="button"
          class="wr-tool"
          :aria-pressed="activeSide === 'right'"
          @click="switchSide('right')"
        >
          右稿</button
        ><label class="wr-check"
          ><input
            v-model="differences"
            type="checkbox"
            name="differences"
          />显示段落差异</label
        ><span class="wr-diff-legend" aria-label="差异图例">
          <span class="wr-diff-key"><span class="wr-diff-swatch wr-diff-removed">删</span>左稿删去</span>
          <span class="wr-diff-key"><span class="wr-diff-swatch wr-diff-added">增</span>右稿新增</span>
          <span class="wr-diff-key"><span class="wr-diff-swatch wr-diff-missing">—</span>无对应段</span>
        </span>
      </nav>
      <p
        v-if="data.compared.left.body === data.compared.right.body"
        role="status"
        class="wr-muted"
      >
        两稿正文一致。
      </p>
      <div ref="comparison" class="wr-comparison wr-aligned-comparison wr-review-comparison">
        <article
          v-for="(side, index) in ['left', 'right'] as const"
          v-show="!compact || activeSide === side"
          :key="side"
          :data-side="side"
          :aria-label="index ? '右稿' : '左稿'"
        >
          <header
            :style="
              !compact && headerHeight
                ? { minHeight: `${headerHeight}px` }
                : undefined
            "
          >
            <h2 class="wr-review-draft-title">
              {{ index ? '右稿' : '左稿' }} ·
              <a
                :href="
                  href(recordHref('drafts', data.compared[side].draftId), {
                    revision: data.compared[side].revision,
                    returnTo: url.pathname + url.search,
                  })
                "
                >{{ data.compared[side].title }} ·
                {{ version(data.compared[side].revision) }}</a
              >
            </h2>
            <p class="wr-compare-meta">
              <span :class="{ 'wr-adopted-label': isAdopted(data.compared[side]) }">{{ isAdopted(data.compared[side]) ? adoptionLabels.adopted : adoptionLabels.other }}</span>
              <span>{{ latestRevision(data.compared[side]) === data.compared[side].revision ? '最新修订' : '旧版' }}</span>
              <a
                :href="
                  recordHref(
                    'scenes',
                    data.scene.sceneId,
                    data.compared[side].sceneRevision,
                  )
                "
                >上下文 · {{ version(data.compared[side].sceneRevision) }}</a
              >
            </p>
            <details class="wr-compare-actions" @toggle="alignParagraphs">
              <summary>采用与 IF</summary>
              <nav
                class="wr-actions"
                :aria-label="index ? '右稿操作' : '左稿操作'"
              >
                <a
                  class="wr-button wr-primary"
                  :href="
                    href(recordHref('drafts', data.compared[side].draftId), {
                      revision: data.compared[side].revision,
                      action: 'adopt',
                      returnTo: url.pathname + url.search + url.hash,
                    })
                  "
                  >采纳{{ index ? '右稿' : '左稿' }}</a
                ><a
                  :href="
                    href(recordHref('scenes', data.scene.sceneId), {
                      revision: data.compared[side].sceneRevision,
                      action: 'branch',
                      draftId: data.compared[side].draftId,
                      draftRevision: data.compared[side].revision,
                    })
                  "
                  >从此稿建立 IF</a
                >
              </nav>
            </details>
          </header>
          <div
            v-for="(paragraph, i) in lines.paragraphs"
            :key="i"
            :data-compare-row="i"
            class="wr-prose wr-diff wr-compare-line"
            :style="
              !compact && heights[i]
                ? { minHeight: `${heights[i]}px` }
                : undefined
            "
          >
            <span v-if="!paragraph[side]" class="wr-muted">本稿无对应段落</span
            ><del
              v-else-if="differences && paragraph[side]?.changed && !index"
              >{{ paragraph[side]?.text || '\u200b' }}</del
            ><ins v-else-if="differences && paragraph[side]?.changed">{{
              paragraph[side]?.text || '\u200b'
            }}</ins
            ><template v-else>{{ paragraph[side]?.text || '\u200b' }}</template>
          </div>
          <details class="wr-context-details">
            <summary>核对本稿引用上下文</summary>
            <SceneContext
              v-if="data.contexts[index]"
              :scene="data.contexts[index]!"
            />
          </details>
        </article>
      </div>
    </template>
    <div v-else class="wr-section">
      <h2>需要两份稿件版本</h2>
      <p>新建另一候选稿，或修订已有稿件，再返回对照。</p>
      <a
        class="wr-button"
        :href="
          href('/drafts/new', {
            sceneId: data.scene.sceneId,
            revision: data.scene.revision,
          })
        "
        >新建候选稿</a
      >
    </div>
  </template>
</template>
