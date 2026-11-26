import { Type } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { id, projectIds, strict } from './contracts.ts';
import { archivedSource, docId, importInput, jobDetails, jobListLimit, jobSummary, maxSourceChars, providerInfo,
  readInput, searchInput, textOffset, type ExternalProviderInfo } from './external-contracts.ts';
import { createExternalProviders } from './external-providers.ts';
import { archiveDocument, archiveRead, enqueueJob, getJob, listJobs, retryJob } from './external-storage.ts';
import { assertSourceText } from './storage.ts';

export { externalDDL } from './external-storage.ts';
export { startExternalWorker, type ExternalWorkerOptions } from './external-worker.ts';
export { createAkashaProvider, createExternalProviders, createMediaWikiProvider } from './external-providers.ts';
export type { ExternalJob, ExternalProvider } from './external-contracts.ts';

const jobKey = Type.Object({ jobId: id }, strict);
const resultLink = { hrefField: 'href', labelField: 'title' };

export function createExternalOperations(configured?: readonly ExternalProviderInfo[]) {
  const getProviders = () => configured ?? createExternalProviders();
  function selectProvider(provider?: string) {
    const providers = getProviders();
    const chosen = provider === undefined ? providers[0] : providers.find(item => item.provider === provider);
    if (!chosen) throw new OperationError(400, 'external_provider_unavailable', 'Select a configured external research provider.');
    return chosen.provider;
  }

  return [
    defineOperation({
      id: 'external.providers', effect: 'read', description: 'List configured external research providers in default preference order.',
      inputSchema: Type.Object({}, strict),
      outputSchema: Type.Object({ items: Type.Array(providerInfo), defaultProvider: Type.Optional(providerInfo.properties.provider) }, strict),
      run() {
        const items = getProviders().map(({ provider, label, kind }) => ({ provider, label, kind }));
        return { items, ...(items[0] ? { defaultProvider: items[0].provider } : {}) };
      },
    }),
    defineOperation({
      id: 'external.search', effect: 'write', description: 'Queue a search with a configured research provider. Poll external.get by jobId. Use the returned nextCursor to queue the next search page with the same query.',
      inputSchema: searchInput, outputSchema: jobSummary,
      run({ provider, query, limit = 10, cursor }, { db }) {
        assertSourceText(query, cursor ?? '');
        return enqueueJob(db, { provider: selectProvider(provider), kind: 'search', query, limit, cursor });
      },
    }),
    defineOperation({
      id: 'external.read', effect: 'write', description: 'Queue retrieval of original document text and context. Pass a provider and docId from search. Use nextCursor to continue provider context.',
      inputSchema: readInput, outputSchema: jobSummary,
      run({ provider, docId, cursor }, { db }) {
        assertSourceText(docId, cursor ?? '');
        return enqueueJob(db, { provider: selectProvider(provider), kind: 'read', docId, cursor });
      },
    }),
    defineOperation({
      id: 'external.get', effect: 'read', description: 'Read the current state or persisted result of a research job. Use a fresh step ID when polling. Page locally stored original text with docId and nextOffset.',
      inputSchema: Type.Object({ jobId: id, docId: Type.Optional(docId), offset: Type.Optional(textOffset) }, strict),
      outputSchema: jobDetails,
      run({ jobId, docId, offset }, { db }) {
        if (offset !== undefined && docId === undefined) throw new OperationError(400, 'external_document_required', 'Provide docId when paging original text.');
        if (docId !== undefined) assertSourceText(docId);
        return getJob(db, jobId, docId, offset);
      },
    }),
    defineOperation({
      id: 'external.list', effect: 'read', description: 'List persisted research jobs in newest-first order. Open a result with external.get.',
      inputSchema: Type.Object({ limit: Type.Optional(jobListLimit), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) }, strict),
      outputSchema: Type.Object({ items: Type.Array(jobSummary, { maxItems: 50 }) }, strict),
      run: ({ limit = 20, offset = 0 }, { db }) => ({ items: listJobs(db, limit, offset) }),
    }),
    defineOperation({
      id: 'external.retry', effect: 'write', description: 'Queue another attempt of a retryable failed research job with its original input and jobId.',
      inputSchema: jobKey, outputSchema: jobSummary,
      run: ({ jobId }, { db }) => retryJob(db, jobId),
    }),
    defineOperation({
      id: 'external.archive', effect: 'write', interaction: { resultLink },
      description: 'Archive a stored original document or exact excerpt in the source library. Use start and end UTF-16 offsets to identify a specific occurrence.',
      inputSchema: Type.Object({ jobId: id, docId, projectIds: Type.Optional(projectIds), start: Type.Optional(textOffset),
        end: Type.Optional(textOffset), excerpt: Type.Optional(Type.String({ maxLength: maxSourceChars, pattern: '\\S' })) }, strict),
      outputSchema: archivedSource,
      run({ jobId, docId, projectIds = [], ...selection }, { db }) {
        assertSourceText(docId, selection.excerpt ?? '', ...projectIds);
        return archiveRead(db, jobId, docId, projectIds, selection);
      },
    }),
    defineOperation({
      id: 'external.import', effect: 'write', interaction: { resultLink },
      description: 'Archive original provider text already read by an assistant. Use the exact provider document ID (Akasha readSource chunkId), title, body and citation. This records caller-supplied text and makes no provider request.',
      inputSchema: importInput, outputSchema: archivedSource,
      run({ projectIds = [], ...document }, { db }) {
        assertSourceText(...Object.values(document), ...projectIds);
        return archiveDocument(db, document, projectIds);
      },
    }),
  ];
}

export const externalOperations = createExternalOperations();
