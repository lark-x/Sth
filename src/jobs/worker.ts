import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LookupResult, MediaProvider, ProviderParameters, SubmitResult } from './provider.ts';
import { maxImageBytes, sha256, writeTransaction } from './storage.ts';

type Claim = {
  itemId: string; attemptNumber: number; token: string; requestId: string; parameters: ProviderParameters;
} & ({ kind: 'submit'; prompt: string } | { kind: 'lookup'; providerJobId?: string });

function claimNext(db: DatabaseSync, provider: MediaProvider, leaseMs: number): Claim | undefined {
  return writeTransaction(db, () => {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    db.prepare(`UPDATE media_job_attempts SET status = 'unknown', message = ?, updated_at = ?
      WHERE (item_id, attempt_number) IN (SELECT item_id, attempt_number FROM media_job_items
        WHERE status = 'submitting' AND lease_until <= ?)`).run(
      'The worker stopped before recording a submission outcome. Check provider history before taking further action.',
      timestamp, now,
    );
    db.prepare(`UPDATE media_job_items SET status = 'unknown', lease_token = NULL, lease_until = NULL
      WHERE status = 'submitting' AND lease_until <= ?`).run(now);

    const action = db.prepare(`SELECT i.item_id, i.attempt_number, a.request_id, a.provider_job_id, a.parameters_json
      FROM media_job_items i JOIN media_job_attempts a ON a.item_id = i.item_id AND a.attempt_number = i.attempt_number
      WHERE i.status IN ('submitted', 'unknown') AND i.next_action_at <= ? AND (i.lease_until IS NULL OR i.lease_until <= ?)
      AND a.provider_key = ? AND a.provider = ? ORDER BY i.next_action_at, i.item_id LIMIT 1`)
      .get(now, now, provider.key, provider.name) as {
        item_id: string; attempt_number: number; request_id: string; provider_job_id: string | null; parameters_json: string;
      } | undefined;
    const token = randomUUID();
    if (action) {
      db.prepare(`UPDATE media_job_items SET lease_token = ?, lease_until = ? WHERE item_id = ?`)
        .run(token, now + leaseMs, action.item_id);
      return { kind: 'lookup', itemId: action.item_id, attemptNumber: action.attempt_number, token,
        requestId: action.request_id, providerJobId: action.provider_job_id ?? undefined, parameters: JSON.parse(action.parameters_json) };
    }

    const queued = db.prepare(`SELECT i.item_id, i.attempt_number, p.prompt FROM media_job_items i
      JOIN media_jobs j ON j.job_id = i.job_id
      JOIN media_composition_candidates p ON p.composition_id = i.composition_id AND p.candidate_id = i.candidate_id
      WHERE i.status = 'queued' AND NOT EXISTS (SELECT 1 FROM media_job_items live
        WHERE live.job_id = i.job_id AND live.status IN ('submitting','submitted'))
      AND (j.max_images IS NULL OR j.max_images > (SELECT sum(used.attempt_number) FROM media_job_items used WHERE used.job_id = i.job_id))
      ORDER BY j.created_at, j.job_id, i.position LIMIT 1`).get() as
      { item_id: string; attempt_number: number; prompt: string } | undefined;
    if (!queued) return;

    const requestId = randomUUID();
    const attemptNumber = queued.attempt_number + 1;
    const parameters = provider.parameters;
    db.prepare(`INSERT INTO media_job_attempts (item_id, attempt_number, request_id, provider, provider_key, parameters_json,
      status, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'submitting', ?, ?)`)
      .run(queued.item_id, attemptNumber, requestId, provider.name, provider.key, JSON.stringify(parameters), timestamp, timestamp);
    // The commit precedes the network request. Losing a worker from this point onward is ambiguous.
    db.prepare(`UPDATE media_job_items SET status = 'submitting', attempt_number = ?, lease_token = ?, lease_until = ?
      WHERE item_id = ?`).run(attemptNumber, token, now + leaseMs, queued.item_id);
    return { kind: 'submit', itemId: queued.item_id, attemptNumber, token, requestId, parameters, prompt: queued.prompt };
  });
}

function pngDimensions(bytes: Uint8Array) {
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (png.length < 45 || png.length > maxImageBytes || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') return;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return;
  let hasData = false;
  for (let offset = 33; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    offset += length + 12;
    if (type === 'IDAT' && length > 0) hasData = true;
    if (type === 'IEND') {
      if (length === 0 && offset === png.length && hasData) return { width, height };
      return;
    }
  }
}

function settle(db: DatabaseSync, claim: Claim, result: SubmitResult | LookupResult, pollIntervalMs: number) {
  const dimensions = result.state === 'succeeded' ? pngDimensions(result.bytes) : undefined;
  if (result.state === 'succeeded' && dimensions === undefined) {
    result = { state: 'unknown', providerJobId: result.providerJobId, message: 'The provider returned an invalid or oversized PNG.' };
  }
  const image = result.state === 'succeeded' && dimensions
    ? { ...dimensions, bytes: result.bytes, hash: sha256(result.bytes) } : undefined;
  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  writeTransaction(db, () => {
    // A late result from an expired lease cannot overwrite a new decision or archive a second image.
    const changed = db.prepare(`UPDATE media_job_items SET status = ?, next_action_at = ?, lease_token = NULL, lease_until = NULL
      WHERE item_id = ? AND attempt_number = ? AND lease_token = ?`).run(
      result.state, result.state === 'submitted' ? now + pollIntervalMs : null, claim.itemId, claim.attemptNumber, claim.token,
    );
    if (!changed.changes) return;
    db.prepare(`UPDATE media_job_attempts SET status = ?, provider_job_id = coalesce(?, provider_job_id), message = ?, updated_at = ?
      WHERE item_id = ? AND attempt_number = ?`).run(
      result.state, 'providerJobId' in result ? result.providerJobId ?? null : null, 'message' in result ? result.message : null,
      updatedAt, claim.itemId, claim.attemptNumber,
    );
    if (image) {
      db.prepare(`INSERT INTO media_images (media_id, item_id, attempt_number, content_type, sha256, width, height, bytes, created_at)
        VALUES (?, ?, ?, 'image/png', ?, ?, ?, ?, ?)`).run(
        randomUUID(), claim.itemId, claim.attemptNumber, image.hash, image.width, image.height, image.bytes, updatedAt,
      );
    }
  });
}

export interface JobsWorkerSettings {
  provider: MediaProvider;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  leaseMs?: number;
  onError?: (error: unknown) => void;
}

/** Start after the schema is ready. Await stop() before closing this SQLite connection. */
export function startJobsWorker(db: DatabaseSync, {
  provider, pollIntervalMs = 1_000, requestTimeoutMs = 15_000, leaseMs = requestTimeoutMs + 5_000,
  onError = error => console.error('Sth media worker error', error),
}: JobsWorkerSettings) {
  if (![pollIntervalMs, requestTimeoutMs, leaseMs].every(value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff)
    || leaseMs <= requestTimeoutMs) throw new Error('Invalid media worker timing. A lease must outlast a provider request.');

  const shutdown = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;

  async function tick() {
    const claim = claimNext(db, provider, leaseMs);
    if (!claim) return false;

    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(requestTimeoutMs)]);
    let result: SubmitResult | LookupResult;
    try {
      result = claim.kind === 'submit'
        ? await provider.submit({ requestId: claim.requestId, prompt: claim.prompt }, signal)
        : await provider.lookup(claim, signal);
    } catch {
      if (shutdown.signal.aborted && claim.kind === 'lookup') {
        db.prepare(`UPDATE media_job_items SET lease_token = NULL, lease_until = NULL WHERE item_id = ? AND lease_token = ?`)
          .run(claim.itemId, claim.token);
        return false;
      }
      const message = claim.kind === 'submit'
        ? 'The provider did not confirm the submission. Check its queue and history before taking further action.'
        : 'The provider lookup did not complete. Request another lookup when the provider is reachable.';
      result = { state: 'unknown', message };
    }
    settle(db, claim, result, pollIntervalMs);
    return true;
  }

  function schedule(delay: number) {
    if (shutdown.signal.aborted) return;
    timer = setTimeout(() => {
      active = tick().then(worked => schedule(worked ? 0 : pollIntervalMs), error => {
        onError(error);
        schedule(pollIntervalMs);
      });
    }, delay);
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
