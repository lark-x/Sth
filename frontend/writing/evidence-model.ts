import type { Reference, ReferenceInput } from '../../src/generation/contracts.ts';
import type { SourceRange } from '../../src/sources/contracts.ts';

const paths: Record<string, string> = { source: 'sources', character: 'characters', scene: 'scenes', draft: 'drafts',
  judgment: 'judgments', event: 'events', narrative: 'narratives', diary: 'diaries' };
export const evidenceKinds: Record<string, string> = { source: '引用原文', character: '人物', scene: '场景', draft: '参考稿',
  judgment: '判断', event: '事件', narrative: '讲法', diary: '日记' };
export function evidenceHref(kind: string, id: string, revision: number, range?: SourceRange, returnTo?: string) {
  if (!paths[kind] || !id || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  const params = new URLSearchParams({ revision: String(revision) });
  if (range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start) {
    params.set('start', String(range.start));
    params.set('end', String(range.end));
  }
  if (returnTo && (kind === 'source' || kind === 'character')) params.set('returnTo', returnTo);
  return `/${paths[kind]}/${encodeURIComponent(id)}?${params}`;
}
export const referenceKey = (reference: ReferenceInput) => JSON.stringify([reference.kind, reference.id, reference.revision,
  reference.kind === 'source' ? reference.range ?? null : null]);
type Snapshot = Record<string, any>;
function object(value: unknown): Snapshot {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Snapshot : {};
}
export interface EvidenceQuote { key: string; title: string; text: string; revision: number; href?: string }

// Only saved selectors supply passage coordinates. Text similarity never creates a link.
export function referenceQuotes(reference: Reference, returnTo?: string): EvidenceQuote[] {
  const content = object(reference.content);
  const quotes: EvidenceQuote[] = [];
  function quote(key: string, kind: string, id: string, revision: number, title: string, text: unknown, range?: SourceRange) {
    if (typeof text === 'string' && text) quotes.push({ key, title, text, revision, href: evidenceHref(kind, id, revision, range, returnTo) });
  }
  quote('body', reference.kind, reference.id, reference.revision, reference.title,
    reference.excerpt ?? content.body ?? content.persona ?? content.description ?? content.statement ?? content.summary, reference.range);
  for (const [index, pin] of (Array.isArray(content.sources) ? content.sources : []).entries()) {
    quote(`source-${index}`, 'source', pin.sourceId, pin.revision, '引用原文', pin.excerpt, pin.range);
  }
  for (const [index, pin] of (Array.isArray(content.characters) ? content.characters : []).entries()) {
    quote(`character-${index}`, 'character', pin.characterId, pin.revision, pin.name, pin.persona);
  }
  for (const [index, value] of (Array.isArray(content.evidence) ? content.evidence : []).entries()) {
    const pin = object(value.pin ?? value);
    const kind = pin.kind ?? (pin.sourceId ? 'source' : 'draft');
    quote(`evidence-${index}`, kind, pin.sourceId ?? pin.draftId ?? pin.judgmentId, pin.revision,
      evidenceKinds[kind] ?? '依据', pin.excerpt, pin.range);
  }
  if (content.adopted) {
    const draft = object(content.adopted);
    quote('adopted', 'draft', draft.draftId, draft.revision, draft.title, draft.body);
  }
  for (const [entryIndex, entry] of (Array.isArray(content.entries) ? content.entries : []).entries()) {
    for (const [blockIndex, block] of (Array.isArray(entry.blocks) ? entry.blocks : []).entries()) {
      quote(`entry-${entryIndex}-${blockIndex}`, block.type === 'reference' ? block.kind : reference.kind,
        block.type === 'reference' ? block.id : reference.id, block.type === 'reference' ? block.revision : reference.revision,
        entry.label || '人物条目', block.type === 'reference' ? block.excerpt : block.text, block.type === 'reference' ? block.range : undefined);
    }
  }
  return quotes;
}

export function validReferences(value: unknown): value is ReferenceInput[] {
  return Array.isArray(value) && value.length <= 32 && value.every(item => item && typeof item === 'object'
    && ['character', 'source', 'scene', 'draft', 'judgment', 'event'].includes(item.kind)
    && typeof item.id === 'string' && item.id.length > 0 && Number.isSafeInteger(item.revision) && item.revision > 0);
}
