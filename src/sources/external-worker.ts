import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import { writeTransaction } from '../jobs/storage.ts';
import { ExternalProviderError, readResult, searchResult, type ExternalJobError, type ExternalProvider } from './external-contracts.ts';
import { createExternalProviders } from './external-providers.ts';
import type { JobRow } from './external-storage.ts';

function claimNext(db: DatabaseSync, leaseMs: number) {
  return writeTransaction(db, () => {
    const now = Date.now();
    return db.prepare(`UPDATE external_research_jobs SET status = 'running', updated_at = ?,
      lease_token = ?, lease_until = ?, attempts = attempts + 1
      WHERE job_id = (SELECT job_id FROM external_research_jobs
        WHERE status = 'queued' OR (status = 'running' AND lease_until <= ?)
        ORDER BY created_at, job_id LIMIT 1)
      RETURNING job_id, provider, kind, query, doc_id, search_limit, cursor, lease_token`)
      .get(new Date(now).toISOString(), randomUUID(), now + leaseMs, now) as JobRow | undefined;
  });
}

async function requestResult(provider: ExternalProvider | undefined, row: JobRow, signal: AbortSignal) {
  if (!provider) throw new ExternalProviderError('external_provider_unavailable', 'This research provider is no longer configured.', true);
  const cursor = row.cursor ?? undefined;
  const result = row.kind === 'search'
    ? await provider.search({ query: row.query!, limit: row.search_limit!, cursor }, signal)
    : await provider.read({ docId: row.doc_id!, cursor }, signal);
  signal.throwIfAborted();
  const valid = row.kind === 'search' ? Value.Check(searchResult, result) : Value.Check(readResult, result);
  if (!valid) throw new ExternalProviderError('external_invalid_response', 'The provider returned unexpected or oversized research data.', true);
  const records = 'items' in result ? result.items : result.documents;
  if (records.some(record => record.provider !== row.provider) || new Set(records.map(record => record.docId)).size !== records.length) {
    throw new ExternalProviderError('external_invalid_response', 'The provider returned invalid document identities.', true);
  }
  const json = JSON.stringify(result);
  if (records.some(record => Object.values(record).some(value => /[\0\p{Surrogate}]/u.test(value)))) {
    throw new ExternalProviderError('external_invalid_response', 'The provider returned malformed text.', true);
  }
  return json;
}

function withAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let rejectOnAbort: () => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  return Promise.race([deadline, run()]).finally(() => signal.removeEventListener('abort', rejectOnAbort));
}

export interface ExternalWorkerOptions {
  providers?: readonly ExternalProvider[];
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  leaseMs?: number;
  onError?: (error: unknown) => void;
}

/** Start after migrations and await stop() before closing the database. */
export function startExternalWorker(db: DatabaseSync, {
  providers = createExternalProviders(), pollIntervalMs = 500, requestTimeoutMs = 20_000,
  leaseMs = requestTimeoutMs + 5000, onError = error => console.error('External research worker error', error),
}: ExternalWorkerOptions = {}) {
  if (![pollIntervalMs, requestTimeoutMs, leaseMs].every(value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff)
    || leaseMs <= requestTimeoutMs) throw new RangeError('External research leases must outlast a positive request timeout.');
  const byId = new Map(providers.map(provider => [provider.provider, provider]));
  if (byId.size !== providers.length) throw new Error('External research provider IDs must be unique.');
  const shutdown = new AbortController();
  let timer: NodeJS.Timeout;
  let active: Promise<void> | undefined;

  async function tick() {
    let worked = false;
    try {
      const row = claimNext(db, leaseMs);
      if (!row) return;
      worked = true;
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(requestTimeoutMs)]);
      let status: 'queued' | 'succeeded' | 'failed' = 'succeeded';
      let result: string | null = null;
      let error: ExternalJobError | undefined;
      try {
        result = await withAbort(signal, () => requestResult(byId.get(row.provider), row, signal));
      } catch (cause) {
        if (shutdown.signal.aborted) status = 'queued';
        else {
          status = 'failed';
          error = cause instanceof ExternalProviderError ? cause.detail : signal.aborted
            ? { code: 'external_timeout', message: 'The provider request timed out.', retryable: true }
            : { code: 'external_provider_unreachable', message: 'Could not complete the provider request.', retryable: true };
        }
      }
      // A worker that lost its lease cannot publish over a replacement claim.
      db.prepare(`UPDATE external_research_jobs SET status = ?, updated_at = ?, result_json = ?, error_json = ?,
        lease_token = NULL, lease_until = NULL WHERE job_id = ? AND lease_token = ?`)
        .run(status, new Date().toISOString(), result, error ? JSON.stringify(error) : null, row.job_id, row.lease_token);
    } catch (error) {
      worked = false;
      onError(error);
    } finally {
      if (!shutdown.signal.aborted) schedule(worked ? 0 : pollIntervalMs);
    }
  }

  function schedule(delay: number) {
    timer = setTimeout(() => { active = tick(); }, delay);
    timer.unref();
  }

  schedule(0);
  return {
    async stop() {
      shutdown.abort();
      clearTimeout(timer);
      await active;
    },
  };
}
