import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import { locateExcerpt } from '../library/reference-range.ts';
import { readSource } from '../sources/storage.ts';
import type { SourcePin, SourceRange } from '../sources/contracts.ts';
import { sceneBranchId } from '../story/branches.ts';
import type { Event } from '../story/narrative-contracts.ts';
import { projectNarrativeForGeneration, readEvent } from '../story/narrative-storage.ts';
import { readDraft, readScene, readSceneSummary } from '../story/storage.ts';
import type { GenerationAuthorContextRef, GenerationStoryRef, ReferenceInput } from './contracts.ts';

export function storyScope(db: DatabaseSync, inputs: ReferenceInput[], ref: GenerationStoryRef | undefined, author?: GenerationAuthorContextRef) {
  const story = ref && projectNarrativeForGeneration(db, ref);
  const restricted = story?.viewpoint.kind === 'character';
  const known = new Map(story?.knownEvents.map(event => [`${event.eventId}:${event.revision}`, event]));
  const eventCache = new Map<string, Event>();
  function loadEvent(id: string, revision: number) {
    const key = `${id}:${revision}`;
    const event = eventCache.get(key) ?? readEvent(db, id, revision);
    eventCache.set(key, event);
    return event;
  }

  function branchFor(kind: 'scene' | 'draft', id: string, revision: number) {
    const draft = kind === 'draft' ? readDraft(db, id, revision) : undefined;
    const scene = readSceneSummary(db, draft?.sceneId ?? id, draft?.sceneRevision ?? revision);
    return sceneBranchId(db, scene.sceneId, scene.branchFrom !== undefined);
  }

  if (author && story && author.branchId !== story.branchId) {
    throw new OperationError(409, 'generation_author_context_branch_mismatch', 'The author context must use the pinned telling branch.');
  }
  let branchId = story ? story.branchId : author?.branchId;
  for (const { kind, id, revision } of inputs) {
    if (restricted && kind !== 'event') {
      throw new OperationError(409, 'generation_viewpoint_reference_forbidden', 'A character viewpoint only accepts exact events visible in the pinned telling.');
    }
    const branch = kind === 'scene' || kind === 'draft' ? branchFor(kind, id, revision)
      : kind === 'event' && !story ? loadEvent(id, revision).branchId : undefined;
    if (branch === undefined) continue;
    if (branchId === undefined) branchId = branch;
    if (branch !== branchId) branchMismatch();
  }
  branchId ??= null;
  const scopedBranch = branchId;

  function knownEvent(id: string, revision: number) {
    const event = known.get(`${id}:${revision}`);
    if (story && !event) {
      throw new OperationError(409, 'generation_event_not_visible', 'The exact event version is outside the pinned telling.');
    }
    return event;
  }

  function requireBranch(kind: 'scene' | 'draft', id: string, revision: number) {
    if (branchFor(kind, id, revision) !== scopedBranch) branchMismatch();
  }

  function scopedEvents() {
    return story ? [...known.values()].map(({ eventId, revision }) => loadEvent(eventId, revision)) : [...eventCache.values()];
  }

  let sourceRanges: Map<string, SourceRange[]> | undefined;
  function requireSource(id: string, revision: number, range?: SourceRange, pinnedSceneExcerpt = false) {
    if (scopedBranch === null || (!story && pinnedSceneExcerpt)) return;
    if (!range) branchMismatch();
    if (!sourceRanges) {
      sourceRanges = new Map();
      const pins: SourcePin[] = scopedEvents().flatMap(event => event.evidence.filter(pin => pin.kind === 'source'));
      if (!story) {
        for (const ref of inputs) {
          if (ref.kind === 'scene') pins.push(...readScene(db, ref.id, ref.revision).sources);
        }
      }
      for (const pin of pins) {
        const allowed = pin.range ?? locateExcerpt(readSource(db, pin.sourceId, pin.revision).body, pin.excerpt, undefined,
          { mismatch: 'source_excerpt_mismatch' }).range;
        if (!allowed) continue;
        const key = `${pin.sourceId}:${pin.revision}`;
        const ranges = sourceRanges.get(key) ?? [];
        ranges.push(allowed);
        sourceRanges.set(key, ranges);
      }
    }
    if (!sourceRanges.get(`${id}:${revision}`)?.some(allowed => range.start >= allowed.start && range.end <= allowed.end)) {
      branchMismatch();
    }
  }

  function requireJudgment(id: string, revision: number) {
    if (scopedBranch === null) return;
    const allowed = scopedEvents().some(event => event.branchId === scopedBranch && event.evidence.some(pin =>
      pin.kind === 'judgment' && pin.judgmentId === id && pin.revision === revision));
    if (!allowed) branchMismatch();
  }

  return { story, restricted, branchId: scopedBranch, knownEvent, loadEvent, requireBranch, requireSource, requireJudgment };
}

export function branchMismatch(): never {
  throw new OperationError(409, 'generation_reference_branch_mismatch', 'The reference is outside the selected story branch or its pinned evidence.');
}
