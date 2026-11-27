import { Type, type Static } from '@sinclair/typebox';
import { LinkedSourcePinsSchema } from '../sources/contracts.ts';
import { id, revision, scene, sourcePins, strict, title } from './contracts.ts';
import { branch, branchScope } from './narrative-contracts.ts';

export const contextRevision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const decisionText = Type.String({ maxLength: 4_000, pattern: '\\S' });
export const decisionScope = { projectId: id, branchId: Type.Optional(branchScope) };
export const basisInput = Type.Object({
  sources: Type.Optional(sourcePins),
  scene: Type.Optional(Type.Object({ sceneId: id, revision }, strict)),
  checkpoint: Type.Optional(Type.Object({ branchId: id, revision }, strict)),
}, strict);
export const decisionBasis = Type.Object({
  sources: LinkedSourcePinsSchema,
  scene: Type.Optional(scene),
  checkpoint: Type.Optional(branch),
}, strict);
export const decisionRef = Type.Object({ decisionId: id, revision }, strict);
const confirmation = Type.Object({
  proposalRevision: revision, confirmedBy: title, confirmedAt: Type.String(),
}, strict);
const common = { projectId: id, branchId: branchScope, revision, contextRevision: revision, title, body: decisionText, createdAt: Type.String() };
const proposed = { ...common, decisionId: id, status: Type.Literal('proposed') };
const confirmed = { ...common, decisionId: id, status: Type.Literal('confirmed'), confirmation };
export const decisionSummary = Type.Union([
  Type.Object(proposed, strict), Type.Object(confirmed, strict),
]);
export const decision = Type.Union([
  Type.Object({ ...proposed, basis: decisionBasis }, strict), Type.Object({ ...confirmed, basis: decisionBasis }, strict),
]);
const open = { ...common, questionId: id, status: Type.Literal('open') };
const resolved = { ...common, questionId: id, status: Type.Literal('resolved'), resolution: decisionRef };
export const questionSummary = Type.Union([
  Type.Object(open, strict), Type.Object(resolved, strict),
]);
export const question = Type.Union([
  Type.Object({ ...open, basis: decisionBasis }, strict), Type.Object({ ...resolved, basis: decisionBasis }, strict),
]);
const contextPage = <T extends typeof decisionSummary | typeof questionSummary>(item: T) => Type.Object({
  items: Type.Array(item, { maxItems: 50 }), hasMore: Type.Boolean(),
}, strict);
export const storyContext = Type.Object({
  projectId: id, branchId: branchScope, revision: contextRevision,
  pendingDecisions: contextPage(decisionSummary), confirmedDecisions: contextPage(decisionSummary),
  openQuestions: contextPage(questionSummary), resolvedQuestions: contextPage(questionSummary),
  checkpoint: Type.Optional(branch), text: Type.String(),
}, strict);

export type DecisionScope = { projectId: string; branchId: string | null };
export type BasisInput = Static<typeof basisInput>;
export type DecisionBasis = Static<typeof decisionBasis>;
export type Decision = Static<typeof decision>;
export type DecisionSummary = Static<typeof decisionSummary>;
export type Question = Static<typeof question>;
export type QuestionSummary = Static<typeof questionSummary>;
export type StoryContext = Static<typeof storyContext>;
