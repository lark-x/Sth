import { Type, type Static } from '@sinclair/typebox';
import { SourcePinSchema, LinkedSourcePinSchema } from '../sources/contracts.ts';
import { characterPin, draftRef, id, revision, sceneDetail, strict, title } from './contracts.ts';

export const branchScope = Type.Union([id, Type.Null()]);
export const sceneVersion = { sceneId: id, sceneRevision: revision };
export const eventRef = Type.Object({ eventId: id, revision }, strict);
export const eventRefs = Type.Array(eventRef, { maxItems: 100 });

const sourceEvidence = { kind: Type.Literal('source'), ...SourcePinSchema.properties };
const draftEvidence = {
  kind: Type.Literal('draft'), ...draftRef.properties, excerpt: SourcePinSchema.properties.excerpt, range: SourcePinSchema.properties.range,
};
const judgmentEvidence = { kind: Type.Literal('judgment'), judgmentId: id, revision };
const evidencePin = Type.Union([Type.Object(sourceEvidence, strict), Type.Object(draftEvidence, strict), Type.Object(judgmentEvidence, strict)]);
const linkedEvidence = Type.Union([
  Type.Object({ ...sourceEvidence, href: LinkedSourcePinSchema.properties.href }, strict),
  Type.Object({ ...draftEvidence, href: LinkedSourcePinSchema.properties.href }, strict),
  Type.Object({ ...judgmentEvidence, href: LinkedSourcePinSchema.properties.href }, strict),
]);
const evidenceBounds = { maxItems: 20, uniqueItems: true };
const eventSummaryFields = { ...eventRef.properties, branchId: branchScope, title, href: Type.String() };
export const eventSummary = Type.Object(eventSummaryFields, strict);
const eventDescription = Type.String({ maxLength: 4_000, pattern: '\\S' });
export const eventFields = { title, summary: eventDescription, evidence: Type.Optional(Type.Array(evidencePin, evidenceBounds)) };
export const event = Type.Object({ ...eventSummaryFields, summary: eventDescription,
  evidence: Type.Array(linkedEvidence, evidenceBounds) }, strict);
export const eventRelation = Type.Object({ beforeEventId: id, afterEventId: id }, strict);
export const eventOrderAction = Type.Union([Type.Literal('add'), Type.Literal('remove')]);

export const viewpoint = Type.Union([
  Type.Object({ kind: Type.Literal('omniscient') }, strict),
  Type.Object({ kind: Type.Literal('character'), ...characterPin.properties }, strict),
]);
export const narrativeRef = Type.Object({ narrativeId: id, revision }, strict);
export const narrativeFields = {
  ...sceneVersion, title, eventOrder: eventRefs, viewpoint, knownEvents: eventRefs, draft: Type.Optional(draftRef),
};
export const narrativeSummary = Type.Object({
  ...narrativeRef.properties, ...sceneVersion, branchId: branchScope, title, href: Type.String(),
}, strict);
export const narrative = Type.Object({ ...narrativeSummary.properties, ...narrativeFields }, strict);
export const narrativeProjectionRef = Type.Object({ ...narrativeRef.properties, branchId: branchScope,
  checkpointRevision: Type.Optional(revision),
}, strict);

export const characterState = Type.Object({ ...characterPin.properties, state: eventDescription }, strict);
export const characterStates = Type.Array(characterState, { maxItems: 32 });
export const projectedCheckpoint = Type.Object({ branchId: id, revision, characterState: Type.Optional(characterState) }, strict);
export const checkpointFields = {
  ...sceneVersion, narrative: Type.Optional(narrativeRef), draft: Type.Optional(draftRef), note: Type.Optional(sceneDetail),
};
export const checkpoint = Type.Object({ ...checkpointFields, characterStates }, strict);
export const branchSummary = Type.Object({
  branchId: id, revision, name: title, originSceneId: id, originSceneRevision: revision,
  latestSceneId: id, latestSceneRevision: revision, href: Type.String(),
}, strict);
export const branch = Type.Object({
  ...branchSummary.properties, divergence: sceneDetail, originDraft: Type.Optional(draftRef),
  originNarrative: Type.Optional(narrativeRef), sharedEvents: eventRefs, checkpoint,
}, strict);

export type EventRef = Static<typeof eventRef>;
export type Event = Static<typeof event>;
export type EvidencePin = Static<typeof evidencePin>;
export type NarrativeRef = Static<typeof narrativeRef>;
export type Narrative = Static<typeof narrative>;
export type NarrativeProjectionRef = Static<typeof narrativeProjectionRef>;
export type Branch = Static<typeof branch>;
export type Checkpoint = Static<typeof checkpoint>;
export type ProjectedCheckpoint = Static<typeof projectedCheckpoint>;
