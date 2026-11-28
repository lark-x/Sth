<script setup lang="ts">
import { computed } from 'vue';
import type { Generation } from '../../src/generation/contracts.ts';
import { evidenceHref, referenceQuotes, type EvidenceQuote } from './evidence-model.ts';
const props = defineProps<{ generation: Generation; returnTo?: string; confirmed?: boolean }>();
type Citation = { label: string; href?: string; quotes: EvidenceQuote[] };
const groups = computed(() => {
  const groups: { kind: string; label: string; references: Citation[] }[] = [
    { kind: 'source', label: '引用原文', references: [] },
    { kind: 'character', label: '人物', references: [] },
    { kind: 'decision', label: '当时确认的决定', references: [] },
    { kind: 'other', label: '其他引用', references: [] },
  ];
  for (const reference of props.generation.composition.references) {
    const group = groups.find(item => item.kind === reference.kind) ?? groups.at(-1)!;
    group.references.push({ label: `${reference.title} · 第 ${reference.revision} 版`,
      href: evidenceHref(reference.kind, reference.id, reference.revision, reference.range, props.returnTo),
      quotes: referenceQuotes(reference, props.returnTo) });
  }
  return groups.filter(group => group.references.length || (group.kind === 'decision' && decisions.value.length));
});
const context = computed(() => props.generation.composition.authorContext);
const contextHref = computed(() => context.value ? `/author-context?${new URLSearchParams({ projectId: context.value.projectId,
  revision: String(context.value.contextRevision), ...(context.value.branchId ? { branchId: context.value.branchId } : {}) })}` : undefined);
const decisions = computed(() => context.value?.policy === 'full' ? context.value.confirmedDecisions : []);

function excerpt(text: string) {
  const leading = /^.{0,84}/su.exec(text)![0];
  return leading.length < text.length ? `${leading.trimEnd()}…` : text;
}
</script>

<template>
  <section class="evidence-content" aria-label="组稿固定输入">
    <template v-for="group in groups" :key="group.kind">
      <div v-if="group.kind === 'decision'" class="evidence-section">
        <h3>{{ group.label }}</h3>
        <article v-for="item in decisions" :key="item.decisionId">
          <p>{{ item.body }}</p>
          <p class="evidence-meta">{{ item.title }} · 第 {{ item.revision }} 版 · {{ item.confirmation.confirmedBy }} · 确认提案第 {{ item.confirmation.proposalRevision }} 版</p>
        </article>
      </div>
      <component v-else :is="group.kind === 'other' ? 'details' : 'div'" class="evidence-section"
        :class="`evidence-${group.kind}`">
        <summary v-if="group.kind === 'other'">{{ group.label }}</summary>
        <h3 v-else>{{ group.label }}</h3>
        <div v-for="({ label, href, quotes }, index) in group.references" :key="index" class="evidence-reference">
          <figure v-for="quote in quotes" :key="quote.key" class="evidence-quote">
            <component :is="group.kind === 'character' ? 'p' : 'blockquote'"
              class="evidence-quote-preview" :cite="group.kind === 'character' ? undefined : quote.href">{{ excerpt(quote.text) }}</component>
            <details v-if="excerpt(quote.text) !== quote.text">
              <summary>查看完整内容</summary>
              <component :is="group.kind === 'character' ? 'p' : 'blockquote'"
                :cite="group.kind === 'character' ? undefined : quote.href">{{ quote.text }}</component>
            </details>
            <figcaption>
              <a v-if="quote.href" :href="quote.href">{{ quote.title }} · 第 {{ quote.revision }} 版</a>
              <span v-else>{{ quote.title }}</span>
            </figcaption>
          </figure>
          <a v-if="href && !quotes.some(quote => quote.href === href)" :href="href">{{ label }}</a>
          <p v-if="!quotes.length" class="evidence-meta">结构化内容见完整提示词。</p>
        </div>
      </component>
    </template>
    <p v-if="!groups.length">这条记录没有保存额外引用或确认决定。</p>
    <details class="evidence-section evidence-record">
      <summary>查看来源记录</summary>
      <p class="evidence-record-title">{{ generation.title }}</p>
      <p class="evidence-meta">{{ generation.mode === 'current-chat' ? '当前对话' : '委托生成' }} · {{ generation.createdAt.slice(0, 10) }}<template v-if="confirmed"> · 作者已确认关联</template></p>
      <template v-if="context?.policy === 'full'">
        <p v-if="!decisions.length">这版作者上下文没有已确认决定。</p>
        <p v-if="context.pendingDecisions.length || context.openQuestions.length">待确认提案 {{ context.pendingDecisions.length }} 项、待决问题 {{ context.openQuestions.length }} 项。</p>
      </template>
      <p v-else-if="context">本次采用人物视角，作者自由文本按可见性规则保留在视角外。</p>
      <p v-else>此组稿没有保存作者决定上下文。</p>
      <nav aria-label="组稿追溯">
        <a v-if="contextHref" :href="contextHref">当时的作者上下文 · 第 {{ context!.contextRevision }} 版</a>
        <a :href="`/generations/${encodeURIComponent(generation.generationId)}/prompt`">完整提示词与出处</a>
        <a :href="`/generations/${encodeURIComponent(generation.generationId)}`">查看生成记录</a>
      </nav>
    </details>
  </section>
</template>

<style scoped>
.evidence-content { min-inline-size: 0; font-size: .875rem; overflow-wrap: anywhere; }
.evidence-section { padding-block: 1.5rem; border-block-end: 1px solid var(--line, #e5e5e5); }
h3 { margin: 0 0 .75rem; color: var(--muted, #686868); font-size: .8125rem; font-weight: 600; line-height: 1.5; }
p, blockquote { margin: 0 0 .5rem; padding: 0; border: 0; color: var(--ink, #252525); white-space: pre-wrap; line-height: 1.8; }
figure { margin: 0; }
figure + figure, .evidence-reference + .evidence-reference, article + article { margin-block-start: 1.25rem; }
.evidence-source blockquote { font-size: 1.125rem; }
figcaption, .evidence-meta { color: var(--muted, #686868); font-size: .8125rem; line-height: 1.6; }
figcaption a { color: inherit; }
.evidence-meta { margin: 0; }
.evidence-record { padding-block: .25rem; }
.evidence-record[open] { padding-block-end: 1rem; }
.evidence-record-title { margin-block-start: .5rem; font-weight: 500; }
nav { display: grid; gap: .25rem; margin-block-start: .5rem; }
a { display: inline-block; padding-block: .25rem; overflow-wrap: anywhere; text-underline-offset: .2em; text-decoration-thickness: 1px; }
a:hover { color: var(--ink, #252525); }
summary { box-sizing: border-box; min-block-size: 2.25rem; padding-block: .5rem; color: var(--muted, #686868); line-height: 1.6; cursor: pointer; }
summary:hover { color: var(--ink, #252525); }
.evidence-quote:has(details[open]) .evidence-quote-preview { display: none; }
:focus-visible { outline: 2px solid var(--focus-ring, var(--ink, #252525)); outline-offset: 3px; }
@media (pointer: coarse), (width < 640px) {
  a, summary { min-block-size: 2.75rem; box-sizing: border-box; }
  a { display: inline-flex; align-items: center; }
}
</style>
