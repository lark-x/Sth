import type { DatabaseSync } from 'node:sqlite';
import { Type } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { sceneBranchId } from '../story/branches.ts';
import { readDraft, readScene } from '../story/storage.ts';
import { generationSummary, id, revision, strict, type Generation } from './contracts.ts';
import { manuscriptEvidenceInput, manuscriptEvidencePage, manuscriptPassage, type ManuscriptTarget } from './evidence-contracts.ts';
import { readGeneration, readGenerationSummary } from './storage.ts';

export function validateManuscriptTarget(db: DatabaseSync, target: ManuscriptTarget, context: {
  projectId?: string; story?: { branchId: string | null; sceneId: string; sceneRevision: number };
  authorContext?: { projectId: string; branchId: string | null };
}) {
  const scene = readScene(db, target.sceneId, target.sceneRevision);
  const projectId = context.projectId ?? context.authorContext?.projectId;
  const scope = context.story ?? context.authorContext;
  if ((projectId && scene.placement && projectId !== scene.placement.projectId)
    || (scope && scope.branchId !== sceneBranchId(db, scene.sceneId, !!scene.branchFrom))
    || (context.story && (context.story.sceneId !== scene.sceneId || context.story.sceneRevision !== scene.revision))) {
    throw new OperationError(409, 'generation_manuscript_scope_mismatch', 'The manuscript target must match the pinned project, branch and telling scene revision.');
  }
}

export function saveManuscriptTarget(db: DatabaseSync, generationId: string, target: ManuscriptTarget) {
  db.prepare('INSERT INTO generation_manuscript_targets VALUES (?, ?, ?)')
    .run(generationId, target.sceneId, target.sceneRevision);
}

export const manuscriptEvidenceOperations = [
  defineOperation({
    id: 'generations.evidence.list', effect: 'read',
    description: 'Read explicit generation associations for an exact manuscript scene or draft revision. Scene preparation targets are not proof of a draft origin. Draft associations require an explicit author confirmation. Never infer an output relationship from matching text or input references.',
    inputSchema: manuscriptEvidenceInput, outputSchema: manuscriptEvidencePage,
    run({ sceneId, sceneRevision, draftId, draftRevision, limit = 20, offset = 0 }, { db }) {
      readScene(db, sceneId, sceneRevision);
      if ((draftId === undefined) !== (draftRevision === undefined)) {
        throw new OperationError(400, 'generation_manuscript_revision_required', 'Supply both draftId and draftRevision.');
      }
      if (draftId !== undefined) {
        const draft = readDraft(db, draftId, draftRevision);
        if (draft.sceneId !== sceneId || draft.sceneRevision !== sceneRevision) {
          throw new OperationError(409, 'generation_manuscript_scope_mismatch', 'Use the exact scene revision pinned by this draft.');
        }
        const row = db.prepare('SELECT generation_id, passages_json FROM generation_manuscript_drafts WHERE draft_id = ? AND draft_revision = ?')
          .get(draftId, draftRevision!) as { generation_id: string; passages_json: string } | undefined;
        return { items: row && offset === 0 ? [{ generation: readGenerationSummary(db, row.generation_id),
          relation: 'author-confirmed' as const, passages: JSON.parse(row.passages_json) }] : [], hasMore: false };
      }
      const rows = db.prepare(`SELECT t.generation_id FROM generation_manuscript_targets t
        JOIN generation_records g USING (generation_id) WHERE t.scene_id = ? AND t.scene_revision = ?
        ORDER BY g.created_at DESC, g.generation_id LIMIT ? OFFSET ?`).all(sceneId, sceneRevision, limit + 1, offset);
      return { items: rows.slice(0, limit).map(row => ({ generation: readGenerationSummary(db, String(row.generation_id)),
        relation: 'prepared-for-scene' as const, passages: [] })), hasMore: rows.length > limit };
    },
  }),
  defineOperation({
    id: 'generations.evidence.attach', effect: 'write',
    description: 'After the author has inspected and explicitly confirmed which completed generation was used for a draft, associate that exact draft revision. This records the author assertion, not proof of external model use. Optional passages are explicit UTF-16 output ranges tied to reference indices. Immutable associations never carry forward to revised drafts.',
    inputSchema: Type.Object({ generationId: id, draftId: id, draftRevision: revision, authorConfirmed: Type.Literal(true),
      passages: Type.Optional(Type.Array(manuscriptPassage, { maxItems: 200, uniqueItems: true })) }, strict),
    outputSchema: generationSummary,
    run({ generationId, draftId, draftRevision, passages = [] }, { db }) {
      const record: Generation = readGeneration(db, generationId);
      if (record.status !== 'succeeded' || !record.result) {
        throw new OperationError(409, 'generation_manuscript_result_required', 'Inspect a completed generation with a saved result before confirming its draft association.');
      }
      const draft = readDraft(db, draftId, draftRevision);
      const target = { sceneId: draft.sceneId, sceneRevision: draft.sceneRevision };
      validateManuscriptTarget(db, target, record.composition);
      const savedTarget = db.prepare('SELECT scene_id, scene_revision FROM generation_manuscript_targets WHERE generation_id = ?')
        .get(generationId);
      if (savedTarget && (savedTarget.scene_id !== target.sceneId || savedTarget.scene_revision !== target.sceneRevision)) {
        throw new OperationError(409, 'generation_manuscript_scope_mismatch', 'The generation was prepared for another scene revision.');
      }
      for (const { start, end, referenceIndex } of passages) {
        const splitsPair = (offset: number) => /[\uD800-\uDBFF]/.test(draft.body[offset - 1] ?? '') && /[\uDC00-\uDFFF]/.test(draft.body[offset] ?? '');
        if (end <= start || end > draft.body.length || !draft.body.slice(start, end).trim()
          || splitsPair(start) || splitsPair(end) || !record.composition.references[referenceIndex]) {
          throw new OperationError(400, 'generation_manuscript_passage_invalid', 'Use an exact nonblank draft range and an existing pinned reference index.');
        }
      }
      const previous = db.prepare('SELECT generation_id, passages_json FROM generation_manuscript_drafts WHERE draft_id = ? AND draft_revision = ?')
        .get(draftId, draftRevision);
      if (previous) {
        if (previous.generation_id !== generationId || previous.passages_json !== JSON.stringify(passages)) {
          throw new OperationError(409, 'generation_manuscript_already_attached', 'This exact draft revision already has a different confirmed association.');
        }
        return readGenerationSummary(db, generationId);
      }
      if (!savedTarget) saveManuscriptTarget(db, generationId, target);
      db.prepare('INSERT INTO generation_manuscript_drafts VALUES (?, ?, ?, ?)')
        .run(draftId, draftRevision, generationId, JSON.stringify(passages));
      return readGenerationSummary(db, generationId);
    },
  }),
];
