<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import Button from '../ui/Button.vue';
import SourceEditor from './SourceEditor.vue';
import SourcePassage from './SourcePassage.vue';
import SourceAdoption from './SourceAdoption.vue';
import SourceImpact from './SourceImpact.vue';
import {
  ApiError,
  catalog,
  errorText,
  href,
  integer,
  kinds,
  listAll,
  localHref,
  rangeFrom,
  read,
  resourceHref,
  resourceNames,
} from './api';
import type { Backlink, Character, CharacterBacklink, Operation, Project, Source, Summary } from './api';
import type { SourceRoute } from './routes';
import { manuscriptReturn } from '../manuscript/return-link';

const props = defineProps<{ url: URL; route: SourceRoute }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const returnTo = computed(() => manuscriptReturn(props.url));
function contextual(path: string) {
  if (!returnTo.value || path.startsWith('#')) return path;
  const destination = new URL(path, props.url);
  if (destination.origin !== props.url.origin || !/^\/(?:characters|sources)(?:\/|$)/.test(destination.pathname)) return path;
  destination.searchParams.set('returnTo', returnTo.value);
  return destination.pathname + destination.search + destination.hash;
}
function navigate(path: string) { emit('navigate', contextual(path)); }
function retainReturn(event: MouseEvent) {
  if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
  const destination = contextual(anchor.getAttribute('href')!);
  if (destination === anchor.getAttribute('href')) return;
  event.preventDefault();
  navigate(destination);
}
const loading = ref(true);
const error = ref('');
const contextErrors = ref<string[]>([]);
const operations = shallowRef(new Map<string, Operation>());
const source = ref<Source>();
const snapshots = ref<Summary[]>([]);
const projects = ref<Project[]>([]);
const characters = ref<Character[]>([]);
const backlinks = ref<Backlink[]>([]);
const evidence = ref<CharacterBacklink[]>([]);
const matches = ref<{ start: number; end: number }[]>([]);
const latestRevision = ref<number>();
let controller = new AbortController();
const pinned = integer(props.url.searchParams.get('revision'), 1);
const q = props.url.searchParams.get('q')?.trim() ?? '';
const matchOffset = Math.min(100000, integer(props.url.searchParams.get('matchOffset')) ?? 0);
const selectedRange = computed(() => (source.value ? rangeFrom(props.url, source.value.body) : undefined));
const isEditing = computed(
  () =>
    props.route.page === 'new' ||
    (props.route.page === 'revise' && (!pinned || pinned === latestRevision.value)),
);
const heading = computed(() =>
  props.route.page === 'new'
    ? '新建资料'
    : isEditing.value
      ? '修订资料'
      : props.route.page === 'adopt-entry'
        ? '采纳为角色条目'
        : props.route.page === 'impact'
          ? '资料影响'
          : (source.value?.title ?? '资料'),
);
const detailHref = computed(() =>
  source.value ? href(source.value.sourceId, pinned, selectedRange.value) : '/sources',
);
const canRevise = computed(
  () => operations.value.has('source.revise') && (!pinned || pinned === latestRevision.value),
);
const versionIdentity = computed(() => {
  if (pinned && !latestRevision.value) return '固定版本';
  return source.value && latestRevision.value && source.value.revision < latestRevision.value ? '历史版本' : '当前版本';
});

async function load() {
  controller.abort();
  controller = new AbortController();
  const signal = controller.signal;
  loading.value = true;
  error.value = '';
  contextErrors.value = [];
  source.value = undefined;
  snapshots.value = [];
  projects.value = [];
  characters.value = [];
  backlinks.value = [];
  evidence.value = [];
  matches.value = [];
  latestRevision.value = undefined;
  async function context<T>(label: string, promise: Promise<T>, assign: (value: T) => void) {
    try {
      const result = await promise;
      if (!signal.aborted) assign(result);
    } catch (reason) {
      if (!signal.aborted) contextErrors.value.push(`${label}读取失败。${errorText(reason)}`);
    }
  }
  try {
    operations.value = await catalog(signal);
    if (signal.aborted) return;
    if (props.route.page === 'new') {
      await context('项目列表', listAll<Project>(operations.value, 'project.list', {}, signal), (result) => {
        projects.value = result;
      });
    } else if ('sourceId' in props.route) {
      if (props.url.searchParams.has('revision') && !pinned) throw new ApiError(400, 'invalid_revision');
      const record = await read<Source>(
        'source.read',
        { sourceId: props.route.sourceId, ...(pinned ? { revision: pinned } : {}) },
        signal,
      );
      if (signal.aborted) return;
      source.value = record;
      if (props.route.page === 'adopt-entry') {
        if (!selectedRange.value) throw new ApiError(400, 'selection_required', '请从原文选中一段有效内容。');
        await context(
          '角色列表',
          listAll<Character>(operations.value, 'character.list', {}, signal),
          (result) => {
            characters.value = result;
          },
        );
      } else if (props.route.page !== 'impact') {
        if (pinned) {
          const current = await read<Source>('source.read', { sourceId: record.sourceId }, signal);
          latestRevision.value = current.revision;
        } else latestRevision.value = record.revision;
        const tasks = [
          context('项目列表', listAll<Project>(operations.value, 'project.list', {}, signal), (result) => {
            projects.value = result;
          }),
        ];
        if (!isEditing.value) {
          for (const [operationId, label, input, assign] of [
            [
              'source.history',
              '版本历史',
              { sourceId: record.sourceId },
              (items: Summary[]) => {
                snapshots.value = items;
              },
            ],
            [
              'source.backlinks',
              '反向引用',
              { sourceId: record.sourceId, ...(pinned ? { revision: pinned } : {}) },
              (items: Backlink[]) => {
                backlinks.value = items;
              },
            ],
            [
              'character.backlinks',
              '角色证据',
              { kind: 'source', id: record.sourceId, revision: record.revision },
              (items: CharacterBacklink[]) => {
                evidence.value = items;
              },
            ],
          ] as const) {
            if (operations.value.has(operationId))
              tasks.push(
                context(
                  label,
                  listAll(operations.value, operationId, input, signal),
                  assign as (items: unknown[]) => void,
                ),
              );
          }
          if (q && operations.value.has('source.search'))
            tasks.push(
              context(
                '原文匹配',
                read<{ items: Summary[] }>(
                  'source.search',
                  {
                    sourceId: record.sourceId,
                    revision: record.revision,
                    query: q,
                    matchLimit: 11,
                    matchOffset,
                  },
                  signal,
                ),
                (result) => {
                  matches.value = result.items[0]?.matches ?? [];
                },
              ),
            );
        }
        await Promise.all(tasks);
      }
    }
    if (!signal.aborted) document.title = `${heading.value} · Sth`;
  } catch (reason) {
    if (!signal.aborted)
      error.value =
        reason instanceof ApiError && reason.code === 'selection_required'
          ? reason.message
          : errorText(reason);
  } finally {
    if (!signal.aborted) loading.value = false;
  }
}
function snippet(range: { start: number; end: number }) {
  const body = source.value?.body ?? '';
  return {
    before: (range.start > 30 ? '…' : '') + body.slice(Math.max(0, range.start - 30), range.start),
    selected: body.slice(range.start, range.end),
    after: body.slice(range.end, range.end + 30) + (range.end + 30 < body.length ? '…' : ''),
  };
}
onMounted(load);
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <section class="sources-route" :aria-busy="loading" aria-label="资料" @click="retainReturn">
    <p v-if="loading" role="status">正在读取资料…</p>
    <template v-else-if="error"
      ><h1 tabindex="-1">页面暂时无法打开</h1>
      <p role="alert">{{ error }}</p>
      <div class="sources-actions">
        <Button class="sources-button" variant="outline" type="button" @click="load">重试</Button
        ><a :href="returnTo || '/sources'">{{ returnTo ? '返回原稿' : '返回资料' }}</a>
      </div></template
    >
    <template v-else>
      <header class="sources-heading sources-toolbar">
        <a class="sources-back" :href="returnTo || contextual(route.page === 'adopt-entry' || route.page === 'impact' ? detailHref : '/sources')">{{ returnTo ? '返回原稿' : route.page === 'adopt-entry' || route.page === 'impact' ? '返回原文' : '资料' }}</a>
        <div class="sources-title">
          <h1 tabindex="-1">{{ heading }}</h1>
          <p v-if="source" class="sources-muted">{{ versionIdentity }} · 第 {{ source.revision }} 版 · {{ kinds[source.kind] }}</p>
        </div>
        <details
          v-if="source && !isEditing && route.page !== 'adopt-entry' && route.page !== 'impact'"
          class="sources-more"
        ><summary>更多</summary><div class="sources-menu sources-actions">
          <a
            v-if="canRevise"
            :href="contextual(href(source.sourceId, undefined, undefined, { action: 'revise' }))"
            >修订资料</a
          >
          <a v-if="pinned" :href="contextual(href(source.sourceId))">查看当前版本</a>
          <a
            v-if="operations.has('source.impact')"
            :href="contextual(href(source.sourceId, pinned, selectedRange, { action: 'impact' }))"
            >查看影响</a
          >
          <a v-if="returnTo" :href="contextual('/sources')">资料</a>
        </div></details>
      </header>
      <div v-if="contextErrors.length" class="sources-notice">
        <p v-for="message in contextErrors" :key="message" role="alert">{{ message }}</p>
        <Button class="sources-button" variant="outline" type="button" @click="load">重新读取关联信息</Button>
      </div>
      <SourceEditor
        v-if="isEditing"
        :source="source"
        :projects="projects"
        :url="url"
        :contextual-href="contextual"
        @navigate="navigate"
      />
      <SourceAdoption
        v-else-if="source && route.page === 'adopt-entry' && selectedRange"
        :source="source"
        :range="selectedRange"
        :characters="characters"
        @navigate="navigate"
      />
      <SourceImpact
        v-else-if="source && route.page === 'impact'"
        :source="source"
        :url="url"
        :contextual-href="contextual"
        @navigate="navigate"
      />
      <template v-else-if="source">
        <p v-if="route.page === 'revise'" role="status">这是历史版本，请查看当前版本后修订。</p>
        <SourcePassage
          :source="source"
          :range="selectedRange"
          :operations="operations"
          @navigate="navigate"
        />
        <details class="sources-disclosure sources-context"><summary>资料信息</summary>
        <section v-if="source.origin">
          <h2>出处</h2>
          <div class="sources-prose">{{ source.origin }}</div>
        </section>
        <section v-if="source.external">
          <h2>外部文档</h2>
          <dl>
            <template v-for="(value, key) in source.external" :key="key"
              ><dt>{{ key }}</dt>
              <dd class="sources-prose">
                {{ typeof value === 'object' ? JSON.stringify(value, null, 2) : value }}
              </dd></template
            >
          </dl>
        </section>
        <section>
          <h2>关联项目</h2>
          <ul v-if="source.projectIds.length">
            <li v-for="id in source.projectIds" :key="id">
              <a :href="`/projects/${encodeURIComponent(id)}`">{{
                projects.find((item) => item.projectId === id)?.title ?? id
              }}</a>
            </li>
          </ul>
          <p v-else class="sources-muted">个人资料</p>
        </section>
        </details>
        <section v-if="q" aria-label="原文匹配">
          <h2>原文匹配</h2>
          <ol v-if="matches.length" class="sources-list" :start="matchOffset + 1">
            <li v-for="(range, index) in matches.slice(0, 10)" :key="range.start">
              <p class="sources-prose">
                {{ snippet(range).before }}<mark>{{ snippet(range).selected }}</mark
                >{{ snippet(range).after }}
              </p>
              <a :href="contextual(href(source.sourceId, source.revision, range))"
                >定位第 {{ matchOffset + index + 1 }} 处</a
              >
            </li>
          </ol>
          <p v-else class="sources-muted">关键词可能位于标题或出处。</p>
          <nav class="sources-actions" aria-label="原文匹配分页">
            <a
              v-if="matchOffset"
              :href="
                contextual(href(source.sourceId, source.revision, undefined, {
                  q,
                  matchOffset: Math.max(0, matchOffset - 10),
                }))
              "
              >上一页</a
            ><a
              v-if="matches.length > 10"
              :href="contextual(href(source.sourceId, source.revision, undefined, { q, matchOffset: matchOffset + 10 }))"
              >下一页</a
            >
          </nav>
        </section>
        <details v-if="operations.has('source.backlinks') || evidence.length" class="sources-disclosure sources-context"><summary>引用这条资料的内容</summary>
        <section v-if="operations.has('source.backlinks')">
          <h2>引用这条资料的内容</h2>
          <ul v-if="backlinks.length" class="sources-list">
            <li v-for="(item, index) in backlinks" :key="index">
              <a :href="contextual(localHref(item.owner.href))"
                >{{ resourceNames[item.owner.kind] ?? item.owner.kind }} · {{ item.owner.title }} · 第
                {{ item.owner.revision }} 版</a
              >
              <p v-if="item.stance" class="sources-muted">
                {{ item.stance === 'support' ? '依据' : '反证' }}
              </p>
              <blockquote class="sources-prose">{{ item.pin.excerpt }}</blockquote>
              <a v-if="item.pin.range" :href="contextual(href(item.pin.sourceId, item.pin.revision, item.pin.range))"
                >原文位置 {{ item.pin.range.start }}–{{ item.pin.range.end }}</a
              ><a v-else :href="contextual(href(item.pin.sourceId, item.pin.revision))"
                >原文 · 第 {{ item.pin.revision }} 版</a
              >
            </li>
          </ul>
          <p v-else class="sources-muted">暂无引用</p>
        </section>
        <section v-if="evidence.length">
          <h2>引用此记录的角色证据</h2>
          <ul class="sources-list">
            <li v-for="(item, index) in evidence" :key="index">
              <a :href="contextual(resourceHref('character', item.characterId, item.revision))"
                >{{ item.name }} · 第 {{ item.revision }} 版 · {{ item.label || '未命名条目' }}</a
              >
              <blockquote v-if="item.reference.excerpt" class="sources-prose">
                {{ item.reference.excerpt }}
              </blockquote>
            </li>
          </ul>
        </section>
        </details>
        <details v-if="snapshots.length" class="sources-disclosure sources-context">
          <summary>版本历史</summary>
          <ul class="sources-history">
            <li v-for="item in snapshots" :key="item.revision">
              <a :href="contextual(href(source.sourceId, item.revision))" :aria-current="item.revision === source.revision ? 'page' : undefined">第 {{ item.revision }} 版</a
              ><span v-if="item.title !== source.title"> · {{ item.title }}</span
              ><span v-if="item.revision === source.revision" class="sources-muted"> · 正在阅读</span>
            </li>
          </ul>
        </details>
      </template>
    </template>
  </section>
</template>
