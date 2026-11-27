import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { id as resourceId, SourceRangeSchema } from '../sources/contracts.ts';
import { branchScope, eventRef, eventRefs, narrativeProjectionRef, projectedCheckpoint, viewpoint } from '../story/narrative-contracts.ts';
import { contextRevision } from '../story/decision-contracts.ts';
import { generationAuthorContext } from './author-context-contracts.ts';

export { generationAuthorContextRef } from './author-context-contracts.ts';
export type { GenerationAuthorContext, GenerationAuthorContextRef } from './author-context-contracts.ts';

export const strict = { additionalProperties: false };
export const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' });
export const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const title = Type.String({ maxLength: 300, pattern: '\\S' });
export const prose = Type.String({ maxLength: 20_000, pattern: '\\S' });
export const pagination = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 })),
};
export const resource = { title, href: Type.String() };
export const resultLink = { hrefField: 'href', labelField: 'title' };

export function listOf<T extends TSchema>(item: T) {
  return Type.Object({ items: Type.Array(item, { maxItems: 50 }) }, strict);
}

const fieldMetadata = {
  key: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' }),
  label: title,
  description: Type.Optional(prose),
  required: Type.Optional(Type.Boolean({ default: true })),
};
const scalarFields = [
  Type.Object({ ...fieldMetadata, type: Type.Literal('text'),
    maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })) }, strict),
  Type.Object({ ...fieldMetadata, type: Type.Literal('integer'),
    minimum: Type.Optional(Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })),
    maximum: Type.Optional(Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })) }, strict),
  Type.Object({ ...fieldMetadata, type: Type.Literal('boolean') }, strict),
] as const;
const field = Type.Union([...scalarFields, Type.Object({
  ...fieldMetadata, type: Type.Literal('sections'),
  fields: Type.Array(Type.Union([...scalarFields]), { minItems: 1, maxItems: 24 }),
  minItems: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, strict)]);
export type Field = Static<typeof field>;

export const templateKind = Type.Union([
  Type.Literal('diary'), Type.Literal('short-story'), Type.Literal('screenplay'),
  Type.Literal('shot-list'), Type.Literal('custom'),
]);
export const templateDefinition = {
  title, kind: templateKind, fields: Type.Array(field, { minItems: 1, maxItems: 32 }),
};
export const requirementsDefinition = {
  title,
  viewpoint: Type.Optional(prose),
  tone: Type.Optional(prose),
  constraints: Type.Optional(Type.Array(prose, { minItems: 1, maxItems: 20 })),
};
export const planDefinition = {
  title,
  executor: Type.Literal('openai-compatible'),
  provider: id,
  model: title,
  parameters: Type.Object({
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    topP: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    responseFormat: Type.Optional(Type.Union([Type.Literal('json-object'), Type.Literal('json-schema')])),
  }, strict),
};

export const template = Type.Object({ templateId: id, revision, href: resource.href, ...templateDefinition }, strict);
export const requirements = Type.Object({ requirementId: id, revision, href: resource.href, ...requirementsDefinition }, strict);
export const plan = Type.Object({ planId: id, revision, href: resource.href, ...planDefinition }, strict);
export type Template = Static<typeof template>;
export type Requirements = Static<typeof requirements>;
export type Plan = Static<typeof plan>;

const referenceKind = Type.Union([
  Type.Literal('character'), Type.Literal('source'), Type.Literal('scene'), Type.Literal('draft'),
  Type.Literal('judgment'), Type.Literal('event'), Type.Literal('narrative'),
]);
const referenceSelector = { kind: referenceKind, id, revision, excerpt: Type.Optional(prose) };
const range = Type.Optional(SourceRangeSchema);
const index = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const entrySelection = Type.Object({ entryId: resourceId, blockIndex: index }, strict);
export const referenceInput = Type.Union([
  Type.Object({
    ...referenceSelector, kind: Type.Literal('character'),
    includeDescription: Type.Optional(Type.Boolean({ default: true })),
    entryIds: Type.Optional(Type.Array(resourceId, { uniqueItems: true, maxItems: 200 })),
    selections: Type.Optional(Type.Array(entrySelection, { uniqueItems: true, maxItems: 400 })),
  }, strict),
  Type.Object({ ...referenceSelector, kind: Type.Literal('source'), range }, strict),
  Type.Object({ ...referenceSelector, kind: Type.Union([
    Type.Literal('scene'), Type.Literal('draft'), Type.Literal('judgment'), Type.Literal('event'),
  ]) }, strict),
]);
// Pinned content contains the selected entries and blocks. The original selector is optional on older records.
const reference = Type.Object({ ...referenceSelector, range,
  includeDescription: Type.Optional(Type.Boolean()),
  entryIds: Type.Optional(Type.Array(resourceId)), selections: Type.Optional(Type.Array(entrySelection)),
  title, href: Type.Optional(Type.String()), content: Type.Unknown(),
}, strict);
export type ReferenceInput = Static<typeof referenceInput>;
export type Reference = Static<typeof reference>;

export const inputFields = {
  title,
  projectId: Type.Optional(id),
  brief: prose,
  inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
};
const assetMetadata = {
  assetId: id, contentType: Type.String(), byteLength: index, sha256: Type.String(), href: Type.String(),
};
const promptPart = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }, strict),
  Type.Object({ type: Type.Literal('image'), asset: Type.Object({ ...assetMetadata, kind: Type.Literal('image') }, strict) }, strict),
  Type.Object({ type: Type.Literal('audio'), asset: Type.Object({ ...assetMetadata, kind: Type.Literal('audio') }, strict) }, strict),
]);
export type PromptPart = Static<typeof promptPart>;
export type MediaPart = Exclude<PromptPart, { type: 'text' }>;
const role = Type.Union([Type.Literal('system'), Type.Literal('user')]);
const message = Type.Object({ role, content: Type.Union([Type.String(), Type.Array(promptPart, { minItems: 1 })]) }, strict);
export type Message = Static<typeof message>;
export const generationStoryRef = narrativeProjectionRef;
export type GenerationStoryRef = Static<typeof generationStoryRef>;
const storyProjection = Type.Object({
  narrativeId: id, revision, branchId: branchScope, sceneId: id, sceneRevision: revision, viewpoint, eventOrder: eventRefs,
  knownEvents: Type.Array(Type.Object({ ...eventRef.properties, title, summary: prose }, strict)),
  checkpoint: Type.Optional(projectedCheckpoint),
}, strict);
export type StoryProjection = Static<typeof storyProjection>;
export const composition = Type.Object({
  ...inputFields,
  template,
  requirements: Type.Optional(requirements),
  story: Type.Optional(storyProjection),
  authorContext: Type.Optional(generationAuthorContext),
  references: Type.Array(reference),
  messages: Type.Array(message),
}, strict);
export type Composition = Static<typeof composition>;

const provenanceFields = {
  kind: Type.Union([
    Type.Literal('fixed'), Type.Literal('request'), Type.Literal('brief'), Type.Literal('template'),
    Type.Literal('requirements'), Type.Literal('input'), Type.Literal('reference'), Type.Literal('author-context'),
  ]),
  path: Type.String(),
  id: Type.Optional(id), revision: Type.Optional(revision),
  contextRevision: Type.Optional(contextRevision),
  referenceKind: Type.Optional(Type.Union([...referenceKind.anyOf, Type.Literal('decision'), Type.Literal('question')])),
  entryId: Type.Optional(resourceId), entryLabel: Type.Optional(Type.String()), blockIndex: Type.Optional(index),
  blockType: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('audio'), Type.Literal('reference')])),
  target: Type.Optional(Type.Object({ kind: Type.String(), id: resourceId, revision,
    href: Type.Optional(Type.String()), range, characterId: Type.Optional(resourceId) }, strict)),
};
const promptProvenance = Type.Object({ ...provenanceFields, disposition: Type.Literal('included'), messageIndex: index, partIndex: index,
  start: Type.Optional(index), end: Type.Optional(index) }, strict);
export type PromptProvenance = Static<typeof promptProvenance>;
const promptOrigin = Type.Object(provenanceFields, strict);
export type PromptOrigin = Static<typeof promptOrigin>;

const requestOptions = Type.Object({
  model: Type.Optional(Type.String()), stream: Type.Optional(Type.Literal(false)), n: Type.Optional(Type.Literal(1)),
  temperature: Type.Optional(Type.Number()), top_p: Type.Optional(Type.Number()), max_tokens: Type.Optional(Type.Integer()),
  response_format: Type.Optional(Type.Union([
    Type.Object({ type: Type.Literal('json_object') }, strict),
    Type.Object({ type: Type.Literal('json_schema'), json_schema: Type.Object({ name: Type.Literal('sth_generation'),
      strict: Type.Literal(true), schema: Type.Record(Type.String(), Type.Unknown()) }, strict) }, strict),
  ])),
}, strict);
export type PromptRequestOptions = Static<typeof requestOptions>;

const mode = Type.Union([Type.Literal('current-chat'), Type.Literal('delegation')]);
export const promptInspection = Type.Object({
  generationId: id, ...resource, mode,
  status: Type.Union([Type.Literal('provided'), Type.Literal('prepared'), Type.Literal('sent'), Type.Literal('unknown')]),
  historical: Type.Boolean(),
  messages: Type.Array(Type.Object({ role, parts: Type.Array(promptPart, { minItems: 1 }) }, strict)),
  provenance: Type.Array(promptProvenance),
  parameters: Type.Object({ plan: Type.Optional(plan), requestOptions: Type.Optional(requestOptions) }, strict),
}, strict);
export type PromptInspection = Static<typeof promptInspection>;
const promptPageSection = Type.Union([Type.Literal('messages'), Type.Literal('provenance')]);
const promptPageOffset = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const promptPageInput = Type.Object({
  generationId: id,
  section: Type.Optional(promptPageSection),
  cursor: Type.Optional(promptPageOffset),
}, strict);
export const promptPage = Type.Object({
  generationId: id, section: promptPageSection,
  start: promptPageOffset, end: promptPageOffset, totalLength: promptPageOffset,
  fragment: Type.String(), nextCursor: Type.Union([promptPageOffset, Type.Null()]),
}, strict);
export type PromptPageInput = Static<typeof promptPageInput>;
export type PromptPage = Static<typeof promptPage>;

const status = Type.Union([
  Type.Literal('prepared'), Type.Literal('queued'), Type.Literal('running'),
  Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('uncertain'), Type.Literal('canceled'),
]);
const resultLinkSchema = Type.Object({ resultId: id, ...resource }, strict);
const nullableText = Type.Union([Type.String(), Type.Null()]);
export const execution = Type.Object({
  requestedModel: nullableText,
  reportedModel: nullableText,
  reportedModelSource: Type.Union([Type.Literal('chat-client'), Type.Literal('provider'), Type.Null()]),
  providerResponseId: nullableText,
  finishReason: nullableText,
  providerEndpoint: nullableText,
  requestOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, strict);
export type Execution = Static<typeof execution>;
const failure = Type.Object({ code: Type.String(), message: Type.String() }, strict);
export type Failure = Static<typeof failure>;

const generationFields = {
  generationId: id,
  ...resource,
  projectId: Type.Optional(id),
  mode,
  status,
  sourceGenerationId: Type.Optional(id),
  createdAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  finishedAt: Type.Optional(Type.String()),
  result: Type.Optional(resultLinkSchema),
  error: Type.Optional(failure),
};
export const generationSummary = Type.Object(generationFields, strict);
export const generation = Type.Object({
  ...generationFields,
  composition,
  plan: Type.Optional(plan),
  execution,
  rawOutput: Type.Optional(Type.String()),
}, strict);
export const generationResult = Type.Object({
  ...resultLinkSchema.properties,
  generationId: id,
  createdAt: Type.String(),
  output: Type.Record(Type.String(), Type.Unknown()),
}, strict);
export type Generation = Static<typeof generation>;
export type GenerationSummary = Static<typeof generationSummary>;
export type GenerationResult = Static<typeof generationResult>;
