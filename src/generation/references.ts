import type { DatabaseSync } from 'node:sqlite';
import { maxAssetBytes, readAssetMetadata } from '../assets/index.ts';
import { OperationError } from '../core/index.ts';
import type { CharacterEntry } from '../library/character-contracts.ts';
import { locateExcerpt } from '../library/reference-range.ts';
import { readCharacter } from '../library/storage.ts';
import { readJudgment } from '../sources/judgments.ts';
import { readSource } from '../sources/storage.ts';
import { branchHref } from '../story/branches.ts';
import { eventHref, narrativeHref } from '../story/narrative-storage.ts';
import { readDraft, readScene } from '../story/storage.ts';
import type { GenerationAuthorContext, GenerationAuthorContextRef, GenerationStoryRef, MediaPart, PromptOrigin, Reference, ReferenceInput, StoryProjection } from './contracts.ts';
import { pinAuthorContext, recordAuthorContextOrigins } from './author-context.ts';
import { branchMismatch, storyScope } from './story-scope.ts';

export interface PinnedReferences {
  references: Reference[];
  origins: Map<string, PromptOrigin>;
  media: { origin: PromptOrigin; part: MediaPart }[];
  story?: StoryProjection;
  authorContext?: GenerationAuthorContext;
}

type Scope = ReturnType<typeof storyScope>;
type Target = NonNullable<PromptOrigin['target']>;
const maxMediaParts = 32;
const maxMediaBytes = 16 * 1024 * 1024;

function missingSelection(entryId: string, blockIndex?: number): never {
  throw new OperationError(400, 'generation_character_selection_missing', blockIndex === undefined
    ? `Character entry ${entryId} does not exist in the pinned revision.`
    : `Character entry ${entryId} has no block ${blockIndex} in the pinned revision.`);
}

function pinCharacter(db: DatabaseSync, ref: Extract<ReferenceInput, { kind: 'character' }>,
  origin: PromptOrigin, pins: PinnedReferences, scope: Scope, addMedia: (origin: PromptOrigin, part: MediaPart) => void): Reference {
  const character = readCharacter(db, ref.id, ref.revision);
  const wholeEntries = new Set(ref.entryIds);
  const selectedBlocks = new Map<string, Set<number>>();
  for (const { entryId, blockIndex } of ref.selections ?? []) {
    const blocks = selectedBlocks.get(entryId) ?? new Set<number>();
    blocks.add(blockIndex);
    selectedBlocks.set(entryId, blocks);
  }

  const entries: CharacterEntry[] = [];
  for (const { entryId, label, blocks } of character.entries) {
    const all = wholeEntries.delete(entryId);
    const selected = selectedBlocks.get(entryId);
    if (!all && !selected) continue;
    // Text/media can be derived from citations in the same entry even when only one block is selected.
    for (const block of blocks) {
      if (block.type !== 'reference') continue;
      const { kind, id, revision, range } = block;
      if (kind === 'draft' || kind === 'scene') scope.requireBranch(kind, id, revision);
      if (kind === 'source') scope.requireSource(id, revision, range);
      if (kind === 'judgment') scope.requireJudgment(id, revision);
      if (scope.branchId !== null && (kind === 'diary' || kind === 'character')) branchMismatch();
    }
    for (const blockIndex of selected ?? []) {
      if (blockIndex >= blocks.length) missingSelection(entryId, blockIndex);
    }
    selectedBlocks.delete(entryId);
    const entryOrigin = { ...origin, entryId, entryLabel: label };
    const path = `${origin.path}/content/entries/${entries.length}`;
    const pinnedBlocks: CharacterEntry['blocks'] = [];
    pins.origins.set(path, { ...entryOrigin, path });
    const blockIndices = all ? blocks.keys() : [...(selected ?? [])].sort((left, right) => left - right);
    for (const blockIndex of blockIndices) {
      const block = blocks[blockIndex];
      const blockOrigin = { ...entryOrigin, blockIndex, blockType: block.type };
      const blockPath = `${path}/blocks/${pinnedBlocks.length}`;
      const source = { ...blockOrigin, path: blockPath, ...(block.type === 'reference' ? {
        target: { kind: block.kind, id: block.id, revision: block.revision, ...(block.range ? { range: block.range } : {}) },
      } : {}) };
      pins.origins.set(blockPath, source);
      if (block.type === 'image' || block.type === 'audio') {
        const { assetId, kind, contentType, byteLength, sha256, href } = readAssetMetadata(db, block.assetId);
        if (kind !== block.type) {
          throw new OperationError(400, 'generation_asset_kind_mismatch', `Asset ${assetId} is not a ${block.type} asset.`);
        }
        const metadata = { assetId, contentType, byteLength, sha256, href };
        addMedia(source, block.type === 'image'
          ? { type: 'image', asset: { ...metadata, kind: 'image' } }
          : { type: 'audio', asset: { ...metadata, kind: 'audio' } });
      }
      pinnedBlocks.push(block);
    }
    entries.push({ entryId, label, blocks: pinnedBlocks });
  }
  for (const entryId of wholeEntries) missingSelection(entryId);
  for (const entryId of selectedBlocks.keys()) missingSelection(entryId);

  return { ...ref, title: character.name, href: character.href, content: {
    ...(ref.includeDescription === false ? {} : { persona: character.description ?? character.persona }), projectId: character.projectId ?? null,
    ...(entries.length ? { entries } : {}),
  } };
}

function recordOrigin(pins: PinnedReferences, origin: PromptOrigin, path: string, target: Target) {
  pins.origins.set(path, { ...origin, path, target });
}

function eventTarget(id: string, revision: number): Target {
  return { kind: 'event', id, revision, href: eventHref(id, revision) };
}

function recordStoryOrigins(pins: PinnedReferences, story: StoryProjection) {
  const { narrativeId, revision, viewpoint } = story;
  const href = narrativeHref(narrativeId, revision);
  const origin: PromptOrigin = { kind: 'reference', referenceKind: 'narrative', id: narrativeId, revision, path: '/story' };
  recordOrigin(pins, origin, origin.path, { kind: 'narrative', id: narrativeId, revision, href });
  if (viewpoint.kind === 'character') {
    recordOrigin(pins, origin, '/story/viewpoint', { kind: 'character', id: viewpoint.characterId, revision: viewpoint.revision });
  }
  for (const list of ['knownEvents', 'eventOrder'] as const) {
    story[list].forEach(({ eventId, revision }, index) => {
      recordOrigin(pins, origin, `/story/${list}/${index}`, eventTarget(eventId, revision));
    });
  }
  story.knownEvents.forEach(({ eventId, revision, summary }, index) => {
    recordOrigin(pins, origin, `/story/knownEvents/${index}/summary`, {
      ...eventTarget(eventId, revision), range: { start: 0, end: summary.length },
    });
  });
  if (story.checkpoint) {
    const { branchId, revision, characterState } = story.checkpoint;
    const target = { kind: 'branch', id: branchId, revision, href: branchHref(branchId, revision) };
    recordOrigin(pins, origin, '/story/checkpoint', target);
    if (characterState) {
      const path = '/story/checkpoint/characterState';
      const { characterId, state } = characterState;
      recordOrigin(pins, origin, path, { ...target, characterId });
      recordOrigin(pins, origin, `${path}/state`, { ...target, characterId, range: { start: 0, end: state.length } });
    }
  }
}

export function pinReferences(db: DatabaseSync, inputs: ReferenceInput[], storyRef?: GenerationStoryRef, projectId?: string,
  authorRef?: GenerationAuthorContextRef): PinnedReferences {
  const scope = storyScope(db, inputs, storyRef, authorRef);
  const pins: PinnedReferences = { references: [], origins: new Map(), media: [] };
  if (authorRef) {
    pins.authorContext = pinAuthorContext(db, authorRef, scope.story, projectId, inputs);
    recordAuthorContextOrigins(pins.origins, pins.authorContext);
  }
  if (scope.story) {
    pins.story = scope.story;
    recordStoryOrigins(pins, scope.story);
  }
  const seen = new Set<string>();
  let mediaBytes = 0;
  function addMedia(origin: PromptOrigin, part: MediaPart) {
    mediaBytes += part.asset.byteLength;
    if (part.asset.byteLength > maxAssetBytes || mediaBytes > maxMediaBytes || pins.media.length >= maxMediaParts) {
      throw new OperationError(400, 'generation_media_too_large', 'Select at most 32 media blocks and 16 MiB of media in total. Each asset may be at most 8 MiB.');
    }
    pins.media.push({ origin, part });
  }
  pins.references = inputs.map((ref, index) => {
    const { kind, id, revision, excerpt } = ref;
    const key = kind === 'source' && ref.range !== undefined
      ? `${kind}:${id}:${revision}:${ref.range.start}:${ref.range.end}` : `${kind}:${id}:${revision}`;
    if (seen.has(key)) throw new OperationError(400, 'generation_duplicate_reference', `Reference ${key} appears twice.`);
    seen.add(key);
    if (excerpt !== undefined && kind !== 'source') {
      throw new OperationError(400, 'generation_excerpt_not_supported', 'Only a source reference accepts an excerpt.');
    }
    const origin: PromptOrigin = { kind: 'reference', referenceKind: kind, id, revision, path: `/references/${index}` };
    pins.origins.set(origin.path, origin);
    switch (kind) {
      case 'character':
        return pinCharacter(db, ref, origin, pins, scope, addMedia);
      case 'source': {
        const source = readSource(db, id, revision);
        const selection = locateExcerpt(source.body, excerpt, ref.range, { mismatch: 'source_excerpt_mismatch' });
        const range = selection.excerpt === undefined ? { start: 0, end: source.body.length } : selection.range;
        scope.requireSource(id, revision, range);
        const { body, ...metadata } = source;
        recordOrigin(pins, origin, `${origin.path}/content/body`, { kind, id, revision, href: source.href, ...(range ? { range } : {}) });
        if (excerpt !== undefined) recordOrigin(pins, origin, `${origin.path}/excerpt`, {
          kind, id, revision, href: source.href, ...(range ? { range } : {}),
        });
        return { ...ref, title: source.title, href: source.href, content: { ...metadata, body: selection.excerpt ?? body } };
      }
      case 'scene': {
        const { branchFrom: _, ...scene } = readScene(db, id, revision);
        const href = `/scenes/${id}?revision=${revision}`;
        scene.sources.forEach(({ sourceId, revision, href, excerpt, range: savedRange }, index) => {
          const range = savedRange ?? locateExcerpt(readSource(db, sourceId, revision).body, excerpt, undefined,
            { mismatch: 'source_excerpt_mismatch' }).range;
          scope.requireSource(sourceId, revision, range, true);
          recordOrigin(pins, origin, `${origin.path}/content/sources/${index}`, {
            kind: 'source', id: sourceId, revision, href, ...(range ? { range } : {}),
          });
        });
        if (scene.adopted) {
          const { draftId, revision, href, body } = scene.adopted;
          recordOrigin(pins, origin, `${origin.path}/content/adopted/body`, {
            kind: 'draft', id: draftId, revision, href, range: { start: 0, end: body.length },
          });
        }
        return { ...ref, title: scene.title, href, content: scene };
      }
      case 'draft': {
        const draft = readDraft(db, id, revision);
        recordOrigin(pins, origin, `${origin.path}/content/body`, {
          kind, id, revision, href: draft.href, range: { start: 0, end: draft.body.length },
        });
        return { ...ref, title: draft.title, href: draft.href, content: draft };
      }
      case 'judgment': {
        scope.requireJudgment(id, revision);
        const judgment = readJudgment(db, id, revision);
        if (projectId !== undefined && judgment.projectId !== undefined && judgment.projectId !== projectId) {
          throw new OperationError(409, 'generation_judgment_project_mismatch', 'The judgment belongs to another project.');
        }
        recordOrigin(pins, origin, `${origin.path}/content/statement`, { kind, id, revision, href: judgment.href,
          range: { start: 0, end: judgment.statement.length } });
        judgment.evidence.forEach(({ pin }, index) => {
          recordOrigin(pins, origin, `${origin.path}/content/evidence/${index}/pin`, {
            kind: 'source', id: pin.sourceId, revision: pin.revision, href: pin.href, range: pin.range,
          });
        });
        return { ...ref, title: judgment.title, href: judgment.href, content: judgment };
      }
      case 'event': {
        const visible = scope.knownEvent(id, revision);
        const target = eventTarget(id, revision);
        recordOrigin(pins, origin, origin.path, target);
        if (scope.restricted && visible) {
          recordOrigin(pins, origin, `${origin.path}/content/summary`, {
            ...target, range: { start: 0, end: visible.summary.length },
          });
          return { ...ref, title: visible.title, href: target.href, content: visible };
        }
        const event = scope.loadEvent(id, revision);
        recordOrigin(pins, origin, `${origin.path}/content/summary`, {
          ...target, range: { start: 0, end: event.summary.length },
        });
        if (!visible && event.branchId !== scope.branchId) branchMismatch();
        const evidence: typeof event.evidence = [];
        for (const pin of event.evidence) {
          const path = `${origin.path}/content/evidence/${evidence.length}`;
          if (pin.kind === 'judgment') {
            if (event.branchId !== scope.branchId) continue;
            recordOrigin(pins, origin, path, { kind: pin.kind, id: pin.judgmentId, revision: pin.revision, href: pin.href });
            evidence.push(pin);
            continue;
          }
          const id = pin.kind === 'source' ? pin.sourceId : pin.draftId;
          // An inherited event may carry source quotes. Draft quotes stay in their owning branch.
          if (pin.kind === 'draft' && event.branchId !== scope.branchId) continue;
          if (pin.kind === 'draft') scope.requireBranch(pin.kind, id, pin.revision);
          const body = pin.kind === 'source' ? readSource(db, id, pin.revision).body : readDraft(db, id, pin.revision).body;
          const selected = locateExcerpt(body, pin.excerpt, pin.range,
            { mismatch: 'generation_event_evidence_mismatch', requireUnique: true });
          recordOrigin(pins, origin, path, {
            kind: pin.kind, id, revision: pin.revision, href: pin.href, range: selected.range!,
          });
          evidence.push({ ...pin, range: selected.range! });
        }
        const { evidence: _, branchId: __, ...summary } = event;
        return { ...ref, title: event.title, href: target.href, content: { ...summary, evidence } };
      }
    }
  });
  return pins;
}
