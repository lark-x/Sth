import type { DatabaseSync } from 'node:sqlite';
import { readAssetBinary } from '../assets/index.ts';
import { OperationError } from '../core/index.ts';
import { parseProviderOutput } from './composition.ts';
import type { Generation } from './contracts.ts';
import { createOpenAICompatibleProvider, GenerationProviderError, type GenerationProvider } from './provider.ts';
import { discloseRequestOptions, type DelegationPromptStatus } from './prompt.ts';
import { completeGeneration, readGeneration, recordDelegationDispatch } from './storage.ts';

const defaultTimeout = 120_000;

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function claimNext(db: DatabaseSync, timeoutMs: number) {
  return transaction(db, () => {
    const now = Date.now();
    const startedAt = new Date(now).toISOString();
    db.prepare(`UPDATE generation_records SET status = 'uncertain', lease_until = NULL, finished_at = ?, error_json = ?
      WHERE status = 'running' AND lease_until <= ?`).run(startedAt, JSON.stringify({
      code: 'generation_interrupted', message: 'The worker stopped recording progress after claiming the request. The provider may have accepted it.',
    }), now);
    const claimed = db.prepare(`UPDATE generation_records SET status = 'running', started_at = ?, lease_until = ?
      WHERE generation_id = (SELECT g.generation_id FROM generation_records g WHERE g.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM generation_batch_attempts a WHERE a.generation_id = g.generation_id AND a.canceled_at IS NOT NULL)
        ORDER BY g.created_at, g.rowid LIMIT 1) RETURNING generation_id`).get(startedAt, now + timeoutMs + 5_000);
    return claimed ? readGeneration(db, String(claimed.generation_id)) : undefined;
  });
}

function requireInterval(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_000_000) throw new RangeError(`${label} must be a positive timer interval.`);
}

async function executeClaim(db: DatabaseSync, record: Generation, provider: GenerationProvider, timeoutMs: number) {
  const plan = record.plan;
  if (!plan) throw new Error('A queued delegation must have a plan.');

  const execution = { ...record.execution };
  let rawOutput: string | undefined;
  let submitted = false;
  let promptStatus: DelegationPromptStatus = 'prepared';
  const signal = AbortSignal.timeout(timeoutMs);
  let outcome: Parameters<typeof completeGeneration>[2];

  try {
    const fields = record.composition.template.fields;
    const prepared = provider.prepare({ requestId: record.generationId, plan, messages: record.composition.messages, templateFields: fields,
      readMedia: ({ asset }) => readAssetBinary(db, asset.assetId).bytes,
    });
    execution.providerEndpoint = prepared.endpoint ?? null;
    const options = discloseRequestOptions(plan, fields, prepared.requestOptions);
    if (options !== undefined) execution.requestOptions = options;
    signal.throwIfAborted();
    if (!recordDelegationDispatch(db, record.generationId, execution, 'unknown')) return;
    promptStatus = 'unknown';
    submitted = true;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const result = await Promise.race([prepared.execute(signal, () => {
        promptStatus = 'sent';
        recordDelegationDispatch(db, record.generationId, execution, promptStatus);
      }), deadline]);
      promptStatus = 'sent';
      execution.reportedModel = result.reportedModel;
      execution.reportedModelSource = result.reportedModel === null ? null : 'provider';
      execution.providerResponseId = result.responseId;
      execution.finishReason = result.finishReason;
      rawOutput = result.content ?? undefined;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    if (rawOutput === undefined) {
      throw new GenerationProviderError({ state: 'failed', code: 'generation_provider_no_text', message: 'Provider reported no text in its first response choice.' });
    }
    if (execution.finishReason !== null && execution.finishReason !== 'stop') {
      throw new GenerationProviderError({ state: 'failed', code: 'generation_provider_incomplete',
        message: 'Provider reported that the text did not finish normally. See finishReason.' });
    }
    const output = parseProviderOutput(rawOutput, fields, plan.parameters.responseFormat === 'json-schema');
    outcome = { status: 'succeeded', execution, rawOutput, output };
  } catch (error) {
    if (error instanceof GenerationProviderError) {
      outcome = { status: error.state, execution, rawOutput, error: { code: error.code, message: error.message } };
    } else if (error instanceof OperationError) {
      outcome = { status: 'failed', execution, rawOutput, error: { code: error.code, message: error.message } };
    } else {
      outcome = { status: submitted ? 'uncertain' : 'failed', execution, error: submitted
        ? { code: 'generation_provider_unconfirmed', message: signal.aborted
          ? 'Text provider timed out. It may have accepted the request.'
          : 'Could not confirm the text provider response. It may have accepted the request.' }
        : { code: 'generation_provider_setup_failed', message: 'Could not prepare the text provider request.' } };
    }
  }
  outcome.execution = { ...execution, promptStatus };
  transaction(db, () => completeGeneration(db, record, outcome));
}

/** Process at most one committed delegation. Expired in-flight requests are recorded as uncertain. */
export async function processNextGeneration(db: DatabaseSync, provider: GenerationProvider, timeoutMs = defaultTimeout): Promise<boolean> {
  requireInterval(timeoutMs, 'timeoutMs');
  const claimed = claimNext(db, timeoutMs);
  if (!claimed) return false;
  await executeClaim(db, claimed, provider, timeoutMs);
  return true;
}

export interface GenerationWorkerOptions {
  provider?: GenerationProvider;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}

/** Start after migrations. Await stop before closing the database connection. */
export function startGenerationWorker(db: DatabaseSync, options: GenerationWorkerOptions = {}) {
  const { provider = createOpenAICompatibleProvider(), pollIntervalMs = 500, timeoutMs = defaultTimeout,
    onError = error => console.error('Generation worker error', error) } = options;
  requireInterval(pollIntervalMs, 'pollIntervalMs');
  requireInterval(timeoutMs, 'timeoutMs');
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let current: Promise<void> | undefined;

  function schedule(delay: number) {
    timer = setTimeout(() => {
      current = tick();
    }, delay);
    timer.unref();
  }

  async function tick() {
    let processed = false;
    try {
      processed = await processNextGeneration(db, provider, timeoutMs);
    } catch (error) {
      onError(error);
    } finally {
      if (!stopped) schedule(processed ? 0 : pollIntervalMs);
    }
  }

  schedule(0);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
