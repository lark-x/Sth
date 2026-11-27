import { Type, type Static } from '@sinclair/typebox';
import { contextRevision, decisionSummary, questionSummary } from '../story/decision-contracts.ts';
import { branchScope } from '../story/narrative-contracts.ts';
import { id, strict } from '../story/contracts.ts';

export const maxAuthorContextItems = 200;
export const maxAuthorContextBytes = 200_000;
export const generationAuthorContextRef = Type.Object({ projectId: id, branchId: branchScope, contextRevision }, strict);

function sections(maxItems: number) {
  return {
    confirmedDecisions: Type.Array(decisionSummary.anyOf[1], { maxItems }),
    pendingDecisions: Type.Array(decisionSummary.anyOf[0], { maxItems }),
    openQuestions: Type.Array(questionSummary.anyOf[0], { maxItems }),
    resolvedQuestions: Type.Array(questionSummary.anyOf[1], { maxItems }),
  };
}

export const generationAuthorContext = Type.Union([
  Type.Object({ ...generationAuthorContextRef.properties, policy: Type.Literal('full'), ...sections(maxAuthorContextItems) }, strict),
  Type.Object({ ...generationAuthorContextRef.properties, policy: Type.Literal('withheld-for-character-viewpoint'), ...sections(0) }, strict),
]);
export type GenerationAuthorContextRef = Static<typeof generationAuthorContextRef>;
export type GenerationAuthorContext = Static<typeof generationAuthorContext>;
