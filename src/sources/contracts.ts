import { Type, type Static, type TSchema } from '@sinclair/typebox';

export const strict = { additionalProperties: false };
export const id = Type.String({ minLength: 1, maxLength: 128 });
export const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const title = Type.String({ maxLength: 300, pattern: '\\S' });
export const body = Type.String({ maxLength: 100_000, pattern: '\\S' });
export const origin = Type.String({ maxLength: 4_000, pattern: '\\S' });
export const kind = Type.Union([Type.Literal('setting'), Type.Literal('inspiration'), Type.Literal('excerpt')]);
export const projectIds = Type.Array(id, { maxItems: 50, uniqueItems: true });
export const href = Type.String({ maxLength: 2048, pattern: '^/[A-Za-z0-9][A-Za-z0-9_./%?=&#~+@:-]*$' });
export const defaultLimit = 20;
const maxLimit = 50;
export const pagination = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxLimit, default: defaultLimit })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 })),
};
export const resultLink = { hrefField: 'href', labelField: 'title' };

export function itemList<T extends TSchema>(item: T) {
  return Type.Object({ items: Type.Array(item, { maxItems: maxLimit }) }, strict);
}

export const sourceOffset = Type.Integer({ minimum: 0, maximum: 100_000 });
export const SourceRangeSchema = Type.Object({ start: sourceOffset, end: sourceOffset }, {
  ...strict, description: 'Zero-based, half-open UTF-16 code unit range in the exact source revision body.',
});
const pinFields = {
  sourceId: id, revision, excerpt: Type.String({ maxLength: 4_000, pattern: '\\S' }),
};
export const SourcePinSchema = Type.Object({ ...pinFields, range: Type.Optional(SourceRangeSchema) }, strict);
export const ExactSourcePinSchema = Type.Object({ ...pinFields, range: SourceRangeSchema }, strict);
export const SourcePinsSchema = Type.Array(SourcePinSchema, { maxItems: 20, uniqueItems: true });
export const LinkedSourcePinSchema = Type.Object({ ...SourcePinSchema.properties, href }, strict);
export const LinkedExactSourcePinSchema = Type.Object({ ...ExactSourcePinSchema.properties, href }, strict);
export const LinkedSourcePinsSchema = Type.Array(LinkedSourcePinSchema, { maxItems: 20 });

const pinOwnerKind = Type.Union([Type.Literal('diary'), Type.Literal('scene'), Type.Literal('draft')]);
export const ownerKind = Type.Union([...pinOwnerKind.anyOf, Type.Literal('judgment')]);
export const SourcePinOwnerSchema = Type.Object({
  kind: pinOwnerKind, id, revision, title, href, projectId: Type.Optional(id),
}, strict);
export const SourceBacklinkOwnerSchema = Type.Object({ ...SourcePinOwnerSchema.properties, kind: ownerKind }, strict);
export const evidenceStance = Type.Union([Type.Literal('support'), Type.Literal('counter')]);

export type SourceRange = Static<typeof SourceRangeSchema>;
export type SourcePin = Static<typeof SourcePinSchema>;
export type LinkedSourcePin = Static<typeof LinkedSourcePinSchema>;
export type SourcePinOwner = Static<typeof SourcePinOwnerSchema>;
export type SourcePinOwnerKey = Pick<SourcePinOwner, 'kind' | 'id' | 'revision'>;

export function sourceHref(sourceId: string, revision: number) {
  return `/sources/${encodeURIComponent(sourceId)}?revision=${revision}`;
}
