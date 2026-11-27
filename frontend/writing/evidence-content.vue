<script setup lang="ts">
import { computed } from 'vue';
import type { Generation } from '../../src/generation/contracts.ts';
import { evidenceHref, evidenceKinds, referenceQuotes } from './evidence-model.ts';
const props = defineProps<{ generation: Generation }>();
const references = computed(() => props.generation.composition.references.map(reference => ({ reference, quotes: referenceQuotes(reference) })));
const context = computed(() => props.generation.composition.authorContext);
const contextHref = computed(() => context.value ? `/author-context?${new URLSearchParams({ projectId: context.value.projectId,
  revision: String(context.value.contextRevision), ...(context.value.branchId ? { branchId: context.value.branchId } : {}) })}` : undefined);
</script>

<template>
  <section class="evidence-content" aria-label="组稿固定输入">
    <h3>{{ generation.title }}</h3>
    <p>{{ generation.mode === 'current-chat' ? '提供给当前对话的组稿' : '委托生成的组稿' }} · {{ generation.createdAt.slice(0, 10) }}</p>
    <p>以下内容来自这次组稿保存的输入快照。</p>
    <p v-if="!references.length">此组稿没有额外引用。</p>
    <ol v-else>
      <li v-for="({ reference, quotes }, index) in references" :key="index">
        <h4><a :href="evidenceHref(reference.kind, reference.id, reference.revision)">{{ evidenceKinds[reference.kind] }} · {{ reference.title }} · 第 {{ reference.revision }} 版</a></h4>
        <figure v-for="quote in quotes" :key="quote.key">
          <blockquote>{{ quote.text }}</blockquote>
          <figcaption><a v-if="quote.href" :href="quote.href">{{ quote.title }} · 查看固定版本</a><span v-else>{{ quote.title }}</span></figcaption>
        </figure>
        <p v-if="!quotes.length">此引用保存了结构化内容，可在完整提示词中查看。</p>
      </li>
    </ol>
    <h3>本次采用的确认决定</h3>
    <template v-if="context?.policy === 'full'">
      <p v-if="!context.confirmedDecisions.length">这版作者上下文没有已确认决定。</p>
      <article v-for="item in context.confirmedDecisions" :key="item.decisionId">
        <h4>{{ item.title }} · 第 {{ item.revision }} 版</h4><p>{{ item.body }}</p>
        <p class="evidence-meta">{{ item.confirmation.confirmedBy }} · 确认提案第 {{ item.confirmation.proposalRevision }} 版</p>
      </article>
      <p v-if="context.pendingDecisions.length || context.openQuestions.length">同次保存的待确认提案 {{ context.pendingDecisions.length }} 项、待决问题 {{ context.openQuestions.length }} 项，可在作者上下文版本中查看。</p>
    </template>
    <p v-else-if="context">本次采用人物视角，作者自由文本按可见性规则保留在视角外。</p>
    <p v-else>此组稿没有保存作者决定上下文。</p>
    <nav aria-label="组稿追溯">
      <a v-if="contextHref" :href="contextHref">当时的作者上下文 · 第 {{ context!.contextRevision }} 版</a>
      <a :href="`/generations/${encodeURIComponent(generation.generationId)}/prompt`">完整提示词与出处</a>
      <a :href="`/generations/${encodeURIComponent(generation.generationId)}`">查看生成记录</a>
    </nav>
  </section>
</template>

<style scoped>
.evidence-content { min-inline-size: 0; }
h3 { margin-block: 1.25rem .5rem; font-size: 1.08rem; }
h4 { margin-block: .9rem .4rem; font-size: 1rem; }
p, blockquote { white-space: pre-wrap; line-height: 1.75; }
li, article { padding-block: .5rem; border-block-end: 1px solid var(--line); }
figure { margin: .75rem 0; }
blockquote { margin: 0 0 .4rem; }
figcaption, .evidence-meta { color: var(--muted, #56665b); font-size: .9rem; }
nav { display: flex; flex-wrap: wrap; gap: .75rem 1rem; margin-block: 1rem; }
a { overflow-wrap: anywhere; text-underline-offset: .15em; }
:focus-visible { outline: 2px solid var(--accent, #285a46); outline-offset: 3px; }
@media (max-width: 30rem) { ol { padding-inline-start: 1.25rem; } }
</style>
