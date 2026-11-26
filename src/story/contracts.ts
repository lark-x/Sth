import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { characterDescription } from '../library/character-contracts.ts';
import { LinkedSourcePinsSchema, SourcePinsSchema } from '../sources/contracts.ts';

export const strict = { additionalProperties: false };
export const id = Type.String({ maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' });
export const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const title = Type.String({ maxLength: 300, pattern: '\\S' });
export const body = Type.String({ maxLength: 100_000, pattern: '\\S' });
export const sceneDetail = Type.String({ maxLength: 1_000, pattern: '\\S' });

export const defaultLimit = 20;
const maxLimit = 50;
export const pagination = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxLimit, default: defaultLimit })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 })),
};

export function itemList<T extends TSchema>(item: T) {
  return Type.Object({ items: Type.Array(item, { maxItems: maxLimit }) }, strict);
}

const characterIdentity = { characterId: id, revision };
export const characterPin = Type.Object(characterIdentity, strict);
const pinnedCharacter = Type.Object({ ...characterIdentity, name: title, persona: characterDescription }, strict);
export const characterPins = Type.Array(characterPin, { maxItems: 32 });
export const sourcePins = SourcePinsSchema;
export const draftRef = Type.Object({ draftId: id, revision }, strict);

const draftFields = {
  ...draftRef.properties,
  sceneId: id,
  sceneRevision: revision,
  title,
  href: Type.String(),
  sceneHref: Type.String(),
};
export const draftSummary = Type.Object(draftFields, strict);
export const draft = Type.Object({ ...draftFields, body }, strict);

export const branchOrigin = Type.Object({
  sceneId: id, revision, draft: Type.Optional(draftRef), divergence: sceneDetail,
}, strict);

const sceneFields = {
  sceneId: id,
  revision,
  title,
  href: Type.String(),
  time: Type.Optional(sceneDetail),
  place: Type.Optional(sceneDetail),
  placement: Type.Optional(Type.Object({ chapterId: id, projectId: id, position: revision }, strict)),
  branchId: Type.Optional(id),
  branchFrom: Type.Optional(branchOrigin),
};
export const sceneSummary = Type.Object({ ...sceneFields, adopted: Type.Optional(draftRef) }, strict);
export const scene = Type.Object({
  ...sceneFields,
  characters: Type.Array(pinnedCharacter, { maxItems: 32 }),
  sources: LinkedSourcePinsSchema,
  adopted: Type.Optional(draft),
}, strict);

const chapterFields = {
  chapterId: id, projectId: id, title, revision, position: revision, href: Type.String(),
  sceneCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
};
export const chapter = Type.Object(chapterFields, strict);
export const chapterWithScenes = Type.Object({ ...chapterFields, scenes: Type.Array(sceneSummary, { maxItems: maxLimit }) }, strict);

export type CharacterPin = Static<typeof characterPin>;
export type Draft = Static<typeof draft>;
export type DraftRef = Static<typeof draftRef>;
export type BranchOrigin = Static<typeof branchOrigin>;
export type SceneSummary = Static<typeof sceneSummary>;
export type Scene = Static<typeof scene>;

export const resultLink = { hrefField: 'href', labelField: 'title' };
