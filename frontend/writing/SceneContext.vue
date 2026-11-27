<script setup lang="ts">
import type { Scene } from './api.ts';
import { href, recordHref, version } from './api.ts';
defineProps<{ scene: Scene }>();
</script>
<template>
  <section class="wr-context" aria-label="场景上下文">
    <h2>写作上下文</h2>
    <p class="wr-muted"><a :href="recordHref('scenes', scene.sceneId, scene.revision)">{{ scene.title }} · {{ version(scene.revision) }}</a></p>
    <dl v-if="scene.time || scene.place" class="wr-facts">
      <div v-if="scene.time"><dt>时间</dt><dd>{{ scene.time }}</dd></div>
      <div v-if="scene.place"><dt>地点</dt><dd>{{ scene.place }}</dd></div>
    </dl>
    <h3>出场角色</h3>
    <ul v-if="scene.characters.length" class="wr-list">
      <li v-for="character in scene.characters" :key="character.characterId">
        <details><summary>{{ character.name }} · {{ version(character.revision) }}</summary>
          <p class="wr-prose">{{ character.persona }}</p>
          <a :href="recordHref('characters', character.characterId, character.revision)">查看角色证据</a>
        </details>
      </li>
    </ul>
    <p v-else class="wr-muted">本版本未固定出场角色。</p>
    <h3>资料引用</h3>
    <ul v-if="scene.sources.length" class="wr-list">
      <li v-for="(pin, index) in scene.sources" :key="index">
        <a :href="href(recordHref('sources', pin.sourceId), { revision: pin.revision, start: pin.range?.start, end: pin.range?.end })">查看资料原文 · {{ version(pin.revision) }}</a>
        <blockquote class="wr-prose">{{ pin.excerpt }}</blockquote>
        <p v-if="pin.range" class="wr-muted">原文位置 {{ pin.range.start }}–{{ pin.range.end }}</p>
      </li>
    </ul>
    <p v-else class="wr-muted">本版本未引用资料。</p>
  </section>
</template>
