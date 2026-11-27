import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import { listDecisions, listQuestions, readContextRevision, requireDecisionScope } from '../story/decision-storage.ts';
import { readDraft, readSceneSummary } from '../story/storage.ts';
import {
  maxAuthorContextBytes, maxAuthorContextItems, type GenerationAuthorContext, type GenerationAuthorContextRef,
} from './author-context-contracts.ts';
import type { PromptOrigin, ReferenceInput, StoryProjection } from './contracts.ts';

function tooLarge(): never {
  throw new OperationError(400, 'generation_author_context_too_large',
    `The pinned author context exceeds ${maxAuthorContextItems} items or ${maxAuthorContextBytes} UTF-8 bytes. Choose a smaller project or branch context.`);
}

export function pinAuthorContext(db: DatabaseSync, ref: GenerationAuthorContextRef, story?: StoryProjection,
  projectId?: string, references: ReferenceInput[] = []): GenerationAuthorContext {
  if (projectId !== undefined && projectId !== ref.projectId) {
    throw new OperationError(409, 'generation_author_context_project_mismatch', 'The author context must belong to the generation project.');
  }
  requireDecisionScope(db, ref);
  readContextRevision(db, ref, ref.contextRevision);
  if (story) {
    if (story.branchId !== ref.branchId) {
      throw new OperationError(409, 'generation_author_context_branch_mismatch', 'The author context must use the pinned telling branch.');
    }
  }
  const scenePins = story ? [{ sceneId: story.sceneId, revision: story.sceneRevision }] : [];
  for (const reference of references) {
    if (reference.kind === 'scene') scenePins.push({ sceneId: reference.id, revision: reference.revision });
    if (reference.kind === 'draft') {
      const draft = readDraft(db, reference.id, reference.revision);
      scenePins.push({ sceneId: draft.sceneId, revision: draft.sceneRevision });
    }
  }
  for (const pin of scenePins) {
    const scene = readSceneSummary(db, pin.sceneId, pin.revision);
    if (scene.placement && scene.placement.projectId !== ref.projectId) {
      throw new OperationError(409, 'generation_author_context_project_mismatch', 'A pinned scene is placed in another project.');
    }
  }
  const empty = { ...ref, confirmedDecisions: [], pendingDecisions: [], openQuestions: [], resolvedQuestions: [] };
  // Free-form author text has no character-visibility declaration. Even its title, basis and IDs may disclose secrets.
  if (story?.viewpoint.kind === 'character') return { ...empty, policy: 'withheld-for-character-viewpoint' };

  const context: GenerationAuthorContext = { ...empty, policy: 'full' };
  let count = 0;
  let bytes = Buffer.byteLength(JSON.stringify(context));
  function collect<T>(read: (limit: number, offset: number) => T[]): T[] {
    const result: T[] = [];
    for (let offset = 0; ; offset += 50) {
      const page = read(50, offset);
      for (const item of page) {
        count++;
        bytes += Buffer.byteLength(JSON.stringify(item)) + (result.length ? 1 : 0);
        if (count > maxAuthorContextItems || bytes > maxAuthorContextBytes) tooLarge();
        result.push(item);
      }
      if (page.length < 50) return result;
    }
  }
  // The storage filters guarantee these discriminants. Keep the narrower public section schemas.
  context.confirmedDecisions = collect((limit, offset) => listDecisions(db, ref, ref.contextRevision, limit, offset, 'confirmed')) as typeof context.confirmedDecisions;
  context.pendingDecisions = collect((limit, offset) => listDecisions(db, ref, ref.contextRevision, limit, offset, 'proposed')) as typeof context.pendingDecisions;
  context.openQuestions = collect((limit, offset) => listQuestions(db, ref, ref.contextRevision, limit, offset, 'open')) as typeof context.openQuestions;
  context.resolvedQuestions = collect((limit, offset) => listQuestions(db, ref, ref.contextRevision, limit, offset, 'resolved')) as typeof context.resolvedQuestions;
  return context;
}

export function recordAuthorContextOrigins(origins: Map<string, PromptOrigin>, context: GenerationAuthorContext) {
  const root: PromptOrigin = {
    kind: 'author-context', path: '/authorContext', id: context.projectId, contextRevision: context.contextRevision,
  };
  origins.set(root.path, root);
  for (const section of ['confirmedDecisions', 'pendingDecisions', 'openQuestions', 'resolvedQuestions'] as const) {
    context[section].forEach((item, index) => {
      const isDecision = 'decisionId' in item;
      const referenceKind = isDecision ? 'decision' : 'question';
      const id = isDecision ? item.decisionId : item.questionId;
      const path = `/authorContext/${section}/${index}`;
      const target = { kind: referenceKind, id, revision: item.revision };
      const origin: PromptOrigin = { ...root, path, referenceKind, id, revision: item.revision, target };
      origins.set(path, origin);
      if ('confirmation' in item) {
        const proposalPath = `${path}/confirmation/proposalRevision`;
        origins.set(proposalPath, { ...origin, path: proposalPath, target: { ...target, revision: item.confirmation.proposalRevision } });
      }
      if ('resolution' in item) {
        const resolutionPath = `${path}/resolution`;
        origins.set(resolutionPath, { ...origin, path: resolutionPath,
          target: { kind: 'decision', id: item.resolution.decisionId, revision: item.resolution.revision } });
      }
    });
  }
}
