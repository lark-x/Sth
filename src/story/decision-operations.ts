import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { readBranch } from './branches.ts';
import { defaultLimit, id, itemList, pagination, revision, strict, title } from './contracts.ts';
import {
  basisInput, contextRevision, decision, decisionRef, decisionScope, decisionSummary, decisionText,
  question, questionSummary, storyContext, type DecisionScope,
} from './decision-contracts.ts';
import {
  contextText, decisionRevisions, listDecisions, listQuestions, pinDecisionBasis, questionRevisions,
  readContextRevision, readDecision, readQuestion, requireDecisionRevision, requireDecisionScope,
  sameDecisionScope, writeDecision, writeQuestion,
} from './decision-storage.ts';
import { assertText } from './storage.ts';

const content = { title, body: decisionText, basis: Type.Optional(basisInput) };
const expected = { expectedRevision: revision };
const atRevision = { contextRevision: Type.Optional(contextRevision) };
function requireVersionPair(resourceId?: string, expectedRevision?: number) {
  if ((resourceId === undefined) !== (expectedRevision === undefined)) {
    throw new OperationError(400, 'story_save_revision_required', 'Supply both the stable resource ID and expectedRevision to revise.');
  }
}
function scopeOf(input: { projectId: string; branchId?: string | null }): DecisionScope {
  return { projectId: input.projectId, branchId: input.branchId ?? null };
}

export const decisionOperations = [
  defineOperation({
    id: 'decision.propose', effect: 'write',
    description: 'Propose an author decision in a project and optional IF branch. To replace the pending proposal, keep decisionId and supply expectedRevision. This always appends an unconfirmed version. A previous author confirmation stays effective until decision.confirm explicitly confirms a proposal. Omitted basis preserves the last pinned basis, and an empty basis clears it.',
    inputSchema: Type.Object({ ...decisionScope, ...content, decisionId: Type.Optional(id), expectedRevision: Type.Optional(revision) }, strict),
    outputSchema: decision,
    run(input, { db }) {
      assertText(input.title, input.body);
      requireVersionPair(input.decisionId, input.expectedRevision);
      const scope = scopeOf(input);
      requireDecisionScope(db, scope);
      const current = input.decisionId === undefined ? undefined : readDecision(db, input.decisionId);
      if (current) {
        sameDecisionScope(current, scope);
        requireDecisionRevision('decision', current.revision, input.expectedRevision!);
      }
      const basis = input.basis === undefined ? current?.basis ?? { sources: [] } : pinDecisionBasis(db, scope, input.basis);
      return writeDecision(db, {
        ...scope, decisionId: current?.decisionId ?? randomUUID(), revision: (current?.revision ?? 0) + 1,
        title: input.title.trim(), body: input.body.trim(), basis, status: 'proposed',
      });
    },
  }),
  defineOperation({
    id: 'decision.confirm', effect: 'write',
    description: 'Only after an explicit author instruction, confirm one exact proposed revision using the current decision expectedRevision. authorConfirmed must be true and confirmedBy must identify the author. The server records confirmation time and copies the exact proposal and pinned basis to a new confirmed version. Author identity is the caller assertion, under the existing personal-workspace trust model.',
    inputSchema: Type.Object({ decisionId: id, ...expected, proposalRevision: revision, authorConfirmed: Type.Literal(true), confirmedBy: title }, strict),
    outputSchema: decision,
    run({ decisionId, expectedRevision, proposalRevision, confirmedBy }, { db }) {
      assertText(confirmedBy);
      const current = readDecision(db, decisionId);
      requireDecisionRevision('decision', current.revision, expectedRevision);
      const proposal = readDecision(db, decisionId, proposalRevision);
      if (proposal.status !== 'proposed') {
        throw new OperationError(409, 'decision_proposal_required', 'Confirm an exact proposed version.');
      }
      return writeDecision(db, {
        projectId: current.projectId, branchId: current.branchId, decisionId, revision: current.revision + 1,
        title: proposal.title, body: proposal.body, basis: proposal.basis, status: 'confirmed',
        confirmation: { proposalRevision, confirmedBy: confirmedBy.trim(), confirmedAt: new Date().toISOString() },
      });
    },
  }),
  defineOperation({
    id: 'decision.read', effect: 'read', description: 'Read the latest or an exact decision version, including immutable author confirmation and materialized source, scene adoption and checkpoint basis.',
    inputSchema: Type.Object({ decisionId: id, revision: Type.Optional(revision) }, strict), outputSchema: decision,
    run: ({ decisionId, revision }, { db }) => readDecision(db, decisionId, revision),
  }),
  defineOperation({
    id: 'decision.list', effect: 'read',
    description: 'List decisions in exactly one project and branch at an optional contextRevision. Omitted branchId means mainline. status proposed lists pending heads, and status confirmed lists effective confirmed versions even while a newer proposal is pending. Use decision.read for the full pinned basis.',
    inputSchema: Type.Object({ ...decisionScope, ...atRevision, ...pagination, status: Type.Optional(Type.Union([Type.Literal('proposed'), Type.Literal('confirmed')])) }, strict),
    outputSchema: itemList(decisionSummary),
    run({ contextRevision, limit = defaultLimit, offset = 0, status, ...input }, { db }) {
      const scope = scopeOf(input);
      requireDecisionScope(db, scope);
      return { items: listDecisions(db, scope, readContextRevision(db, scope, contextRevision), limit, offset, status) };
    },
  }),
  defineOperation({
    id: 'decision.revisions', effect: 'read', description: 'Page through all proposal and confirmation versions of a stable decision ID, newest first.',
    inputSchema: Type.Object({ decisionId: id, ...pagination }, strict), outputSchema: itemList(decisionSummary),
    run: ({ decisionId, limit = defaultLimit, offset = 0 }, { db }) => ({ items: decisionRevisions(db, decisionId, limit, offset) }),
  }),
  defineOperation({
    id: 'question.save', effect: 'write',
    description: 'Create or revise an open question in a fixed project and branch. Supply questionId and expectedRevision to revise. Omitted basis preserves pinned context. A resolved question must first be explicitly reopened with question.reopen.',
    inputSchema: Type.Object({ ...decisionScope, ...content, questionId: Type.Optional(id), expectedRevision: Type.Optional(revision) }, strict),
    outputSchema: question,
    run(input, { db }) {
      assertText(input.title, input.body);
      requireVersionPair(input.questionId, input.expectedRevision);
      const scope = scopeOf(input);
      requireDecisionScope(db, scope);
      const current = input.questionId === undefined ? undefined : readQuestion(db, input.questionId);
      if (current) {
        sameDecisionScope(current, scope);
        requireDecisionRevision('question', current.revision, input.expectedRevision!);
        if (current.status === 'resolved') throw new OperationError(409, 'question_resolved', 'Explicitly reopen the question before editing it.');
      }
      const basis = input.basis === undefined ? current?.basis ?? { sources: [] } : pinDecisionBasis(db, scope, input.basis);
      return writeQuestion(db, {
        ...scope, questionId: current?.questionId ?? randomUUID(), revision: (current?.revision ?? 0) + 1,
        title: input.title.trim(), body: input.body.trim(), basis, status: 'open',
      });
    },
  }),
  defineOperation({
    id: 'question.resolve', effect: 'write',
    description: 'Resolve or change the resolution of a question using an exact confirmed decision version in the same project and branch. expectedRevision protects concurrent edits. Later decision proposals or confirmations do not change this pinned answer.',
    inputSchema: Type.Object({ questionId: id, ...expected, decision: decisionRef }, strict), outputSchema: question,
    run({ questionId, expectedRevision, decision }, { db }) {
      const current = readQuestion(db, questionId);
      requireDecisionRevision('question', current.revision, expectedRevision);
      const confirmed = readDecision(db, decision.decisionId, decision.revision);
      sameDecisionScope(confirmed, current);
      if (confirmed.status !== 'confirmed') {
        throw new OperationError(409, 'question_confirmed_decision_required', 'Resolve against a confirmed decision version.');
      }
      return writeQuestion(db, { ...current, revision: current.revision + 1, status: 'resolved', resolution: decision });
    },
  }),
  defineOperation({
    id: 'question.reopen', effect: 'write', description: 'Explicitly reopen a resolved question, appending an open version and retaining the historical pinned answer.',
    inputSchema: Type.Object({ questionId: id, ...expected }, strict), outputSchema: question,
    run({ questionId, expectedRevision }, { db }) {
      const current = readQuestion(db, questionId);
      requireDecisionRevision('question', current.revision, expectedRevision);
      if (current.status !== 'resolved') throw new OperationError(409, 'question_already_open', 'The question is already open.');
      const { resolution, ...fields } = current;
      return writeQuestion(db, { ...fields, revision: current.revision + 1, status: 'open' });
    },
  }),
  defineOperation({
    id: 'question.read', effect: 'read', description: 'Read the latest or an exact historical question version and its pinned confirmed answer, if resolved.',
    inputSchema: Type.Object({ questionId: id, revision: Type.Optional(revision) }, strict), outputSchema: question,
    run: ({ questionId, revision }, { db }) => readQuestion(db, questionId, revision),
  }),
  defineOperation({
    id: 'question.list', effect: 'read', description: 'List the latest question versions in exactly one project and branch, optionally at a contextRevision and filtered by open or resolved status.',
    inputSchema: Type.Object({ ...decisionScope, ...atRevision, ...pagination, status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('resolved')])) }, strict),
    outputSchema: itemList(questionSummary),
    run({ contextRevision, limit = defaultLimit, offset = 0, status, ...input }, { db }) {
      const scope = scopeOf(input);
      requireDecisionScope(db, scope);
      return { items: listQuestions(db, scope, readContextRevision(db, scope, contextRevision), limit, offset, status) };
    },
  }),
  defineOperation({
    id: 'question.revisions', effect: 'read', description: 'Page through all versions, resolutions, and reopenings of a stable question ID, newest first.',
    inputSchema: Type.Object({ questionId: id, ...pagination }, strict), outputSchema: itemList(questionSummary),
    run: ({ questionId, limit = defaultLimit, offset = 0 }, { db }) => ({ items: questionRevisions(db, questionId, limit, offset) }),
  }),
  defineOperation({
    id: 'story.context', effect: 'read',
    description: 'Read a shareable author context in one project and branch, with pending proposals, effective confirmed decisions, open questions and pinned resolutions. Reuse the returned revision as contextRevision to reconstruct older context or page consistently. limit and offset apply independently to each section, with hasMore per section. Optionally pin an exact IF checkpointRevision using existing branch checkpoints. This operation also returns readable text.',
    inputSchema: Type.Object({ ...decisionScope, ...atRevision, ...pagination, checkpointRevision: Type.Optional(revision) }, strict),
    outputSchema: storyContext,
    run({ contextRevision, checkpointRevision, limit = defaultLimit, offset = 0, ...input }, { db }) {
      const scope = scopeOf(input);
      requireDecisionScope(db, scope);
      const at = readContextRevision(db, scope, contextRevision);
      if (checkpointRevision !== undefined && scope.branchId === null) {
        throw new OperationError(400, 'story_checkpoint_branch_required', 'Select an IF branch for checkpoint context.');
      }
      const page = <T>(items: T[]) => ({ items: items.slice(0, limit), hasMore: items.length > limit });
      const context = {
        ...scope, revision: at,
        pendingDecisions: page(listDecisions(db, scope, at, limit + 1, offset, 'proposed')),
        confirmedDecisions: page(listDecisions(db, scope, at, limit + 1, offset, 'confirmed')),
        openQuestions: page(listQuestions(db, scope, at, limit + 1, offset, 'open')),
        resolvedQuestions: page(listQuestions(db, scope, at, limit + 1, offset, 'resolved')),
        ...(checkpointRevision === undefined ? {} : { checkpoint: readBranch(db, scope.branchId!, checkpointRevision) }),
      };
      return { ...context, text: contextText(context) };
    },
  }),
];
