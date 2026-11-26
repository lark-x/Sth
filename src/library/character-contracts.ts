import { Type, type Static } from '@sinclair/typebox';
import { id, revision, SourceRangeSchema, strict, title } from '../sources/contracts.ts';

export const characterName = title;
export const characterDescription = Type.String({ maxLength: 100_000 });
export const authorFields = {
  name: Type.Optional(Type.String({ maxLength: 300 })),
  description: Type.Optional(characterDescription),
  persona: Type.Optional(characterDescription),
};

export const resourceKind = Type.Union([
  Type.Literal('source'), Type.Literal('scene'), Type.Literal('draft'), Type.Literal('diary'), Type.Literal('character'), Type.Literal('judgment'),
]);
const excerpt = Type.Optional(Type.String({ maxLength: 4_000, pattern: '\\S' }));
const range = Type.Optional(SourceRangeSchema);
const referenceFields = { id, revision, excerpt, range };
const referenceBlock = Type.Object({ type: Type.Literal('reference'), kind: resourceKind, ...referenceFields }, strict);
const block = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: characterDescription }, strict),
  Type.Object({ type: Type.Union([Type.Literal('image'), Type.Literal('audio')]), assetId: id }, strict),
  referenceBlock,
]);
const label = Type.String({ maxLength: 300 });
const entryId = Type.String({ maxLength: 128, pattern: '\\S' });
const entryFields = { label, blocks: Type.Array(block) };
const entry = Type.Object({ entryId, ...entryFields }, strict);
const authorEntry = Type.Object({ ...entryFields, entryId: Type.Optional(entryId) }, strict);
export const authorEntries = Type.Optional(Type.Array(authorEntry));
export const adoptionEntries = Type.Array(Type.Object({
  label: title,
  text: Type.Optional(Type.String({ maxLength: 100_000, pattern: '\\S' })),
  references: Type.Array(Type.Object({
    ...referenceFields, location: range,
    kind: Type.Union([Type.Literal('source'), Type.Literal('draft'), Type.Literal('judgment')]),
  }, strict), { minItems: 1, maxItems: 20 }),
}, strict), { minItems: 1, maxItems: 50 });

export const characterSummary = { characterId: id, name: characterName, revision };
const characterLink = { ...characterSummary, href: Type.String(), projectId: Type.Optional(id) };
export const character = Type.Object({
  ...characterLink,
  authorName: Type.Optional(characterName),
  description: Type.Optional(characterDescription),
  persona: characterDescription,
  entries: Type.Array(entry),
}, strict);
export const characterBacklink = Type.Object({
  ...characterLink, entryId, label, blockIndex: Type.Integer({ minimum: 0 }), reference: referenceBlock,
}, strict);

export type CharacterBlock = Static<typeof block>;
export type CharacterEntry = Static<typeof entry>;
export type AuthorEntry = Static<typeof authorEntry>;
export type CharacterReference = Static<typeof referenceBlock>;
export type AdoptionEntry = Static<typeof adoptionEntries>[number];
