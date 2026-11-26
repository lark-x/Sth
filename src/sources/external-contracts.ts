import { Type, type Static } from '@sinclair/typebox';
import { id, origin, projectIds, revision, href, strict, title } from './contracts.ts';

export const maxSearchResults = 20;
export const maxDocumentChars = 2_000_000;
export const maxSourceChars = 100_000;
export const readPageChars = 24_000;
export const providerId = Type.String({ pattern: '^[a-z][a-z0-9_-]{0,63}$' });
export const docId = Type.String({ maxLength: 512, pattern: '\\S' });
export const cursor = Type.String({ minLength: 1, maxLength: 1024 });
export const textOffset = Type.Integer({ minimum: 0, maximum: maxDocumentChars });
export const jobListLimit = Type.Integer({ minimum: 1, maximum: 50 });

const identity = { provider: providerId, docId, title, origin };
const metadata = {
  ...identity, url: Type.Optional(Type.String({ maxLength: 4000, pattern: '^https?://' })),
  upstreamRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  license: Type.Optional(Type.String({ maxLength: 500, pattern: '\\S' })),
};
export const searchItem = Type.Object({
  ...metadata, snippet: Type.Optional(Type.String({ maxLength: 2000 })),
}, strict);
export const document = Type.Object({
  ...metadata, body: Type.String({ maxLength: maxDocumentChars, pattern: '\\S' }),
}, strict);
export const documentPage = Type.Object({
  ...metadata, body: Type.String({ maxLength: readPageChars }),
  offset: textOffset, nextOffset: Type.Optional(textOffset), totalChars: textOffset,
}, strict);

export const searchResult = Type.Object({ items: Type.Array(searchItem, { maxItems: maxSearchResults }), nextCursor: Type.Optional(cursor) }, strict);
export const readResult = Type.Object({ documents: Type.Array(document, { minItems: 1, maxItems: 10 }), nextCursor: Type.Optional(cursor) }, strict);
export const readPageResult = Type.Object({
  documents: Type.Array(documentPage, { minItems: 1, maxItems: 10 }), nextCursor: Type.Optional(cursor),
}, strict);

export const searchInput = Type.Object({
  provider: Type.Optional(providerId), query: Type.String({ maxLength: 500, pattern: '\\S' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxSearchResults })), cursor: Type.Optional(cursor),
}, strict);
export const readInput = Type.Object({ provider: providerId, docId, cursor: Type.Optional(cursor) }, strict);
export const importInput = Type.Object({ ...document.properties,
  body: Type.String({ maxLength: maxSourceChars, pattern: '\\S' }), projectIds: Type.Optional(projectIds),
}, strict);

export const providerInfo = Type.Object({
  provider: providerId, label: title, kind: providerId,
}, strict);
export const jobError = Type.Object({
  code: Type.String(), message: Type.String(), retryable: Type.Boolean(),
}, strict);
const jobFields = {
  jobId: id, provider: providerId, kind: Type.Union([Type.Literal('search'), Type.Literal('read')]),
  status: Type.Union([Type.Literal('queued'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed')]),
  query: Type.Optional(searchInput.properties.query), docId: Type.Optional(docId), cursor: Type.Optional(cursor),
  attempts: Type.Integer({ minimum: 0 }), createdAt: Type.String(), updatedAt: Type.String(),
  error: Type.Optional(jobError),
};
export const jobSummary = Type.Object(jobFields, strict);
export const jobDetails = Type.Object({ ...jobFields, result: Type.Optional(Type.Union([searchResult, readPageResult])) }, strict);
export const archivedSource = Type.Object({
  provider: providerId, docId, sourceId: id, revision, href, title, projectIds,
  start: Type.Optional(textOffset), end: Type.Optional(textOffset),
}, strict);

export type ExternalDocument = Static<typeof document>;
export type ExternalSearchResult = Static<typeof searchResult>;
export type ExternalReadResult = Static<typeof readResult>;
export type ExternalJobError = Static<typeof jobError>;
export type ExternalJob = Static<typeof jobDetails>;
export type ExternalProviderInfo = Static<typeof providerInfo>;

export interface ExternalProvider extends ExternalProviderInfo {
  search(request: { query: string; limit: number; cursor?: string }, signal: AbortSignal): Promise<ExternalSearchResult>;
  read(request: { docId: string; cursor?: string }, signal: AbortSignal): Promise<ExternalReadResult>;
}

export class ExternalProviderError extends Error {
  readonly detail: ExternalJobError;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.detail = { code, message, retryable };
  }
}
