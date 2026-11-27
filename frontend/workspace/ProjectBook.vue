<script setup lang="ts">
import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import { all, href, message, pageOf, read, recordHref, sourceHref } from './api.ts';
import type { Character, Chapter, Diary, Project, Scene, Source } from './api.ts';
import SceneWriting from './SceneWriting.vue';

const props = defineProps<{ project: Project }>();
const scenes = shallowRef<Scene[]>([]);
const chapters = shallowRef<Chapter[]>([]);
const characters = shallowRef<Character[]>([]);
const sources = shallowRef<Source[]>([]);
const diaries = shallowRef<Diary[]>([]);
const busy = ref(false);
const error = ref('');
const relatedError = ref('');
const more = ref(false);
let offset = 0;
let controller: AbortController | undefined;

async function loadRelated(projectId: string, signal: AbortSignal) {
  const related = await Promise.allSettled([
    all<Chapter>('chapter.list', { projectId }, signal),
    pageOf<Character>('character.list', { projectId }, signal),
    pageOf<Source>('source.list', { projectId }, signal),
    pageOf<Diary>('diary.list', { projectId }, signal),
  ]);
  if (signal.aborted) return;
  const [chapterResult, characterResult, sourceResult, diaryResult] = related;
  if (chapterResult.status === 'fulfilled') chapters.value = chapterResult.value;
  if (characterResult.status === 'fulfilled') characters.value = characterResult.value.items;
  if (sourceResult.status === 'fulfilled') sources.value = sourceResult.value.items;
  if (diaryResult.status === 'fulfilled') diaries.value = diaryResult.value.items;
  if (related.some(result => result.status === 'rejected')) relatedError.value = '部分章节或参考内容暂时无法读取，可以重新读取作品，或打开对应列表。';
}

async function loadScenes(reset = false) {
  if (busy.value && !reset) return;
  if (reset) {
    controller?.abort();
    controller = new AbortController();
    offset = 0;
    scenes.value = [];
    chapters.value = [];
    characters.value = [];
    sources.value = [];
    diaries.value = [];
    more.value = false;
    relatedError.value = '';
  }
  const signal = controller!.signal;
  const projectId = props.project.projectId;
  busy.value = true;
  error.value = '';
  if (reset) void loadRelated(projectId, signal);
  try {
    const page = await pageOf<Scene>('scene.list', { projectId }, signal, offset);
    const details: Scene[] = [];
    for (let start = 0; start < page.items.length; start += 5) {
      const batch = await Promise.all(page.items.slice(start, start + 5).map(scene => read<Scene>('scene.read', { sceneId: scene.sceneId, revision: scene.revision }, signal)));
      details.push(...batch);
    }
    if (signal.aborted) return;
    scenes.value = [...scenes.value, ...details];
    offset += page.items.length;
    more.value = page.more;
  } catch (reason) { if (!signal.aborted) error.value = message(reason); }
  finally { if (!signal.aborted) busy.value = false; }
}
watch(() => props.project.projectId, () => { void loadScenes(true); }, { immediate: true });
onScopeDispose(() => controller?.abort());
</script>

<template>
  <article class="ce-book" :aria-label="project.title" :aria-busy="busy">
    <header class="ce-book-heading">
      <h2>{{ project.title }}</h2>
      <nav class="ce-actions" aria-label="作品内容">
        <a :href="href('/author-context', { projectId: project.projectId })">创作决定</a>
        <a :href="href('/chapters', { projectId: project.projectId })">章节</a>
        <a :href="href('/scenes', { projectId: project.projectId })">全部场景</a>
        <a :href="href('/characters', { projectId: project.projectId })">角色</a>
        <a :href="href('/sources', { projectId: project.projectId })">资料</a>
        <a :href="href('/diaries', { projectId: project.projectId })">日记</a>
      </nav>
    </header>
    <p v-if="relatedError" role="alert" class="ce-error">{{ relatedError }} <button class="ce-button" type="button" :disabled="busy" @click="loadScenes(true)">重新读取作品</button></p>
    <nav v-if="chapters.length" class="ce-chapters" aria-label="作品章节">
      <a v-for="chapter in chapters" :key="chapter.chapterId" :href="recordHref('chapters', chapter.chapterId)">{{ chapter.title }}</a>
    </nav>
    <p v-if="error" role="alert" class="ce-error">{{ error }} <button class="ce-button" type="button" :disabled="busy" @click="loadScenes()">重新读取场景</button></p>
    <p v-if="busy && !scenes.length" role="status" class="ce-empty">正在读取作品内容…</p>
    <section v-else-if="!scenes.length && !error" class="ce-empty" aria-label="开始写作品">
      <h3>从第一个场景开始</h3>
      <p>可以从已存角色或资料构思，也可以先写场景，再安排进章节。</p>
      <div class="ce-actions">
        <a class="ce-button ce-primary" href="/workspace?tab=continue">从已有内容继续</a>
        <a class="ce-button" href="/scenes/new">新建场景</a>
        <a :href="href('/chapters/new', { projectId: project.projectId })">新建章节</a>
      </div>
    </section>
    <section v-for="scene in scenes" :key="`${scene.sceneId}:${scene.revision}`" class="ce-manuscript" :aria-label="scene.title">
      <p v-if="scene.placement" class="ce-muted">{{ chapters.find(chapter => chapter.chapterId === scene.placement?.chapterId)?.title ?? '作品场景' }}</p>
      <h3><a :href="recordHref('scenes', scene.sceneId)">{{ scene.title }}</a></h3>
      <p v-if="scene.time || scene.place" class="ce-muted">{{ [scene.time, scene.place].filter(Boolean).join(' · ') }}</p>
      <template v-if="scene.adopted">
        <p class="ce-adopted"><a :href="recordHref('drafts', scene.adopted.draftId, scene.adopted.revision)">采用稿 · {{ scene.adopted.title }} · 第 {{ scene.adopted.revision }} 版</a></p>
        <p class="ce-prose">{{ scene.adopted.body?.slice(0, 1600) }}</p>
        <a v-if="(scene.adopted.body?.length ?? 0) > 1600" :href="recordHref('drafts', scene.adopted.draftId, scene.adopted.revision)">阅读采用稿全文</a>
      </template>
      <p v-else class="ce-muted ce-no-draft">还没有采用稿。可以进入场景继续写，再选用一个版本。</p>
      <div v-if="scene.characters.length" class="ce-actions ce-cast" aria-label="场景角色">
        <a v-for="character in scene.characters" :key="character.characterId" :href="recordHref('characters', character.characterId, character.revision)">{{ character.name }} · 第 {{ character.revision }} 版</a>
      </div>
      <ul v-if="scene.sources.length" class="ce-reference-list" aria-label="场景引用资料">
        <li v-for="pin in scene.sources" :key="`${pin.sourceId}:${pin.revision}:${pin.range?.start}`">
          <a :href="sourceHref(pin)">{{ sources.find(source => source.sourceId === pin.sourceId)?.title ?? '引用资料' }} · 第 {{ pin.revision }} 版</a>
          <blockquote class="ce-prose">{{ pin.excerpt }}</blockquote>
        </li>
      </ul>
      <div class="ce-actions"><a :href="recordHref('scenes', scene.sceneId)">继续这个场景</a></div>
      <SceneWriting :scene="scene" />
    </section>
    <button v-if="more" type="button" class="ce-button" :disabled="busy" @click="loadScenes()">{{ busy ? '正在读取…' : '加载更多场景' }}</button>
    <section v-if="scenes.length" class="ce-book-footer">
      <div class="ce-actions">
        <a href="/scenes/new">新建场景</a>
        <a :href="href('/chapters/new', { projectId: project.projectId })">新建章节</a>
        <a :href="href('/chapters', { projectId: project.projectId })">安排章节与场景</a>
      </div>
    </section>
    <details v-if="characters.length || sources.length || diaries.length" class="ce-related">
      <summary>作品中的角色、资料与日记</summary>
      <ul class="ce-reference-list">
        <li v-for="character in characters" :key="character.characterId"><a :href="recordHref('characters', character.characterId)">{{ character.name }}</a></li>
        <li v-for="source in sources" :key="source.sourceId"><a :href="recordHref('sources', source.sourceId, source.revision)">{{ source.title }} · 第 {{ source.revision }} 版</a></li>
        <li v-for="diary in diaries" :key="diary.noteId">
          <a :href="recordHref('diaries', diary.noteId)">{{ diary.title }}</a>
          <p class="ce-preview">{{ diary.body.slice(0, 180) }}</p>
        </li>
      </ul>
    </details>
  </article>
</template>
