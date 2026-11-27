<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { errorText, href, integer, localHref, rangeFrom, read, resourceHref, resourceNames } from './api';
import type { Impact, Source } from './api';

const props = defineProps<{ source: Source; url: URL }>();
const emit = defineEmits<{ navigate: [href: string] }>();
const controller = new AbortController();
const loading = ref(true);
const error = ref('');
const items = ref<Impact[]>([]);
const nextOffset = ref<number>();
const offset = integer(props.url.searchParams.get('offset')) ?? 0;
const kind = ref(
  Object.hasOwn(resourceNames, props.url.searchParams.get('kind') ?? '')
    ? props.url.searchParams.get('kind')!
    : '',
);
const currentOnly = ref(props.url.searchParams.get('currentOnly') === '1' ? '1' : '');
const pinned = integer(props.url.searchParams.get('revision'), 1);
const range = rangeFrom(props.url, props.source.body);
function pageHref(target?: number) {
  return href(props.source.sourceId, pinned, range, {
    action: 'impact',
    kind: kind.value,
    currentOnly: currentOnly.value,
    offset: target,
  });
}
// Pagination follows the submitted URL filters, even if a select was changed
// without submitting the form.
function paginationHref(target: number) {
  return href(props.source.sourceId, pinned, range, {
    action: 'impact',
    kind: props.url.searchParams.get('kind'),
    currentOnly: props.url.searchParams.get('currentOnly') === '1' ? '1' : undefined,
    offset: target,
  });
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const result = await read<{ items: Impact[]; nextOffset?: number }>(
      'source.impact',
      {
        sourceId: props.source.sourceId,
        ...(pinned ? { revision: pinned } : {}),
        ...(Object.hasOwn(resourceNames, props.url.searchParams.get('kind') ?? '')
          ? { kind: props.url.searchParams.get('kind') }
          : {}),
        currentOnly: props.url.searchParams.get('currentOnly') === '1',
        limit: 20,
        offset,
      },
      controller.signal,
    );
    if (!controller.signal.aborted) {
      items.value = result.items;
      nextOffset.value = result.nextOffset;
    }
  } catch (reason) {
    if (!controller.signal.aborted) error.value = errorText(reason);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => controller.abort());
</script>

<template>
  <section aria-label="资料影响" :aria-busy="loading">
    <form id="impact-filter" class="sources-filter" @submit.prevent="emit('navigate', pageHref())">
      <div class="sources-field">
        <label for="impact-kind">资源类型</label
        ><select id="impact-kind" v-model="kind" name="kind">
          <option value="">全部资源</option>
          <option v-for="(label, value) in resourceNames" :key="value" :value="value">{{ label }}</option>
        </select>
      </div>
      <div class="sources-field">
        <label for="impact-current">版本范围</label
        ><select id="impact-current" v-model="currentOnly" name="currentOnly">
          <option value="">全部版本和快照</option>
          <option value="1">当前版本</option>
        </select>
      </div>
      <button class="sources-button" type="submit">筛选</button>
    </form>
    <p v-if="loading" role="status">正在读取资料影响…</p>
    <div v-else-if="error">
      <p role="alert">{{ error }}</p>
      <button class="sources-button" type="button" @click="load">重试</button>
    </div>
    <template v-else>
      <ul v-if="items.length" class="sources-list">
        <li v-for="item in items" :key="`${item.kind}-${item.id}-${item.revision}-${item.sourceRevision}`">
          <h2>
            <a :href="localHref(item.href)">{{ item.title }}</a>
          </h2>
          <p class="sources-muted">
            {{ resourceNames[item.kind]
            }}<template v-if="item.revision"> · 第 {{ item.revision }} 版</template> ·
            {{ { current: '当前版本', historical: '历史版本', snapshot: '固定快照' }[item.state] }} ·
            引用资料第 {{ item.sourceRevision }} 版
          </p>
          <p v-if="item.via.length">
            经由
            <template v-for="(via, index) in item.via" :key="index"
              ><span v-if="index"> → </span
              ><a :href="resourceHref(via.kind, via.id, via.revision)"
                >{{ resourceNames[via.kind] }} · 第 {{ via.revision }} 版</a
              ></template
            >
          </p>
        </li>
      </ul>
      <p v-else class="sources-empty">没有匹配的引用</p>
      <nav class="sources-actions" aria-label="资料影响分页">
        <a v-if="offset" :href="paginationHref(Math.max(0, offset - 20))">上一页</a
        ><a v-if="nextOffset !== undefined" :href="paginationHref(nextOffset)">下一页</a>
      </nav>
    </template>
  </section>
</template>
