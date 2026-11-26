import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Type, type Static } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { assertText } from './composition.ts';
import { generationSummary, id, listOf, pagination, plan, resource, resultLink, revision, strict, title, type Plan } from './contracts.ts';
import { enqueueDelegation, readGenerationSummary, readPlan } from './storage.ts';

const position = Type.Integer({ minimum: 1, maximum: 50 });
const count = Type.Integer({ minimum: 0, maximum: 50 });
const countsSchema = Type.Object({ queued: count, running: count, succeeded: count, failed: count, uncertain: count, canceled: count }, strict);
const batchStatus = Type.Union([Type.Literal('queued'), Type.Literal('running'), Type.Literal('succeeded'),
  Type.Literal('failed'), Type.Literal('uncertain'), Type.Literal('canceled'), Type.Literal('partial')]);
const summaryFields = {
  batchId: id, ...resource, createdAt: Type.String(), status: batchStatus, counts: countsSchema,
  plan: Type.Pick(plan, ['planId', 'title', 'revision', 'href']),
};
const batchSummary = Type.Object(summaryFields, strict);
const batchAttempt = Type.Object({ position, attempt: revision, generation: generationSummary }, strict);
const batch = Type.Object({
  ...summaryFields, plan, items: Type.Array(batchAttempt, { maxItems: 50 }),
  attempts: Type.Array(batchAttempt, { maxItems: 100 }), nextAttemptOffset: Type.Optional(Type.Integer({ minimum: 1 })),
}, strict);
const target = { batchId: id };
const interaction = { resultLink };

type BatchRow = { batch_id: string; title: string; plan_json: string; created_at: string };
type AttemptRow = { position: number; attempt: number; generation_id: string; source_generation_id: string;
  status: keyof Static<typeof countsSchema> };

const attemptRows = `SELECT a.position, a.attempt, a.generation_id, g.source_generation_id,
  CASE WHEN a.canceled_at IS NULL THEN g.status ELSE 'canceled' END AS status
  FROM generation_batch_attempts a JOIN generation_records g USING (generation_id) WHERE a.batch_id = ?`;

function readBatchRow(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT * FROM generation_batches WHERE batch_id = ?').get(id) as BatchRow | undefined;
  if (!row) throw new OperationError(404, 'generation_batch_not_found', `Generation batch ${id} was not found.`);
  return row;
}

function currentAttempts(db: DatabaseSync, id: string) {
  return db.prepare(`${attemptRows} AND a.attempt = (SELECT MAX(attempt) FROM generation_batch_attempts
    WHERE batch_id = a.batch_id AND position = a.position) ORDER BY a.position`).all(id) as AttemptRow[];
}

function summarize(row: BatchRow, items: AttemptRow[]): Static<typeof batchSummary> {
  const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, uncertain: 0, canceled: 0 };
  for (const item of items) counts[item.status]++;
  let status: Static<typeof batchStatus> = 'partial';
  if (counts.running > 0 || (counts.queued > 0 && counts.queued < items.length)) status = 'running';
  else if (counts.queued > 0) status = 'queued';
  else if (counts.uncertain > 0) status = 'uncertain';
  else if (counts.succeeded === items.length) status = 'succeeded';
  else if (counts.failed === items.length) status = 'failed';
  else if (counts.canceled === items.length) status = 'canceled';
  const { planId, title, revision, href } = JSON.parse(row.plan_json) as Plan;
  return {
    batchId: row.batch_id, title: row.title, href: `/generation-batches/${row.batch_id}`, createdAt: row.created_at,
    plan: { planId, title, revision, href }, counts, status,
  };
}

export function readBatchSummary(db: DatabaseSync, id: string) {
  return summarize(readBatchRow(db, id), currentAttempts(db, id));
}

function readBatch(db: DatabaseSync, id: string, limit = 50, offset = 0): Static<typeof batch> {
  const row = readBatchRow(db, id);
  const items = currentAttempts(db, id);
  const attempts = db.prepare(`${attemptRows} ORDER BY a.position, a.attempt LIMIT ? OFFSET ?`).all(id, limit + 1, offset) as AttemptRow[];
  const toAttempt = (item: AttemptRow) => ({
    position: item.position, attempt: item.attempt, generation: readGenerationSummary(db, item.generation_id),
  });
  return {
    ...summarize(row, items), plan: JSON.parse(row.plan_json) as Plan, items: items.map(toAttempt),
    attempts: attempts.slice(0, limit).map(toAttempt), ...(attempts.length > limit ? { nextAttemptOffset: offset + limit } : {}),
  };
}

function enqueueAttempt(db: DatabaseSync, batchId: string, position: number, attempt: number, sourceId: string, plan: Plan) {
  const generationId = enqueueDelegation(db, sourceId, plan);
  db.prepare('INSERT INTO generation_batch_attempts (batch_id, position, attempt, generation_id) VALUES (?, ?, ?, ?)')
    .run(batchId, position, attempt, generationId);
}

export const generationBatchOperations = [
  defineOperation({
    id: 'generation.batches.create', effect: 'write', interaction,
    description: 'Queue one delegated generation per prepared generation ID, in the specified order. Only use this operation when the author explicitly specifies a named text plan. All items pin the same plan revision. Use the same step ID to replay the submission.',
    inputSchema: Type.Object({ title, planId: id, planRevision: Type.Optional(revision),
      generationIds: Type.Array(id, { minItems: 1, maxItems: 50, uniqueItems: true }) }, strict),
    outputSchema: batch,
    run({ title, planId, planRevision, generationIds }, { db }) {
      assertText(title);
      const plan = readPlan(db, planId, planRevision);
      const id = randomUUID();
      db.prepare('INSERT INTO generation_batches VALUES (?, ?, ?, ?)').run(id, title.trim(), JSON.stringify(plan), new Date().toISOString());
      generationIds.forEach((sourceId, index) => enqueueAttempt(db, id, index + 1, 1, sourceId, plan));
      return readBatch(db, id);
    },
  }),
  defineOperation({
    id: 'generation.batches.get', effect: 'read', interaction,
    description: 'Read a named text batch with its current item states and paginated history of attempts in position and attempt order. Use a fresh operation step to refresh progress.',
    inputSchema: Type.Object({ ...target, attemptLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), attemptOffset: pagination.offset }, strict),
    outputSchema: batch,
    run: ({ batchId, attemptLimit, attemptOffset }, { db }) => readBatch(db, batchId, attemptLimit, attemptOffset),
  }),
  defineOperation({
    id: 'generation.batches.list', effect: 'read',
    description: 'List named text batches with counts of current item states and links to their details.',
    inputSchema: Type.Object(pagination, strict), outputSchema: listOf(batchSummary),
    run({ limit = 20, offset = 0 }, { db }) {
      const rows = db.prepare('SELECT * FROM generation_batches ORDER BY created_at DESC, batch_id LIMIT ? OFFSET ?').all(limit, offset) as BatchRow[];
      return { items: rows.map(row => summarize(row, currentAttempts(db, row.batch_id))) };
    },
  }),
  defineOperation({
    id: 'generation.batches.cancel', effect: 'write', interaction,
    description: 'Cancel the remaining queued attempts in a batch. In-flight attempts continue and can retain their results. Existing terminal attempts remain readable.',
    inputSchema: Type.Object(target, strict), outputSchema: batch,
    run({ batchId }, { db }) {
      readBatchRow(db, batchId);
      db.prepare(`UPDATE generation_batch_attempts SET canceled_at = ? WHERE batch_id = ? AND canceled_at IS NULL
        AND generation_id IN (SELECT generation_id FROM generation_records WHERE status = 'queued')`)
        .run(new Date().toISOString(), batchId);
      return readBatch(db, batchId);
    },
  }),
  defineOperation({
    id: 'generation.batches.retry-confirmed-failures', effect: 'write', interaction,
    description: 'Explicitly retry confirmed failures using the original pinned plan and inputs. Omit positions to retry all currently failed items. Each retry creates an independent attempt and preserves earlier outcomes. Uncertain or canceled attempts are ineligible.',
    inputSchema: Type.Object({ ...target, positions: Type.Optional(Type.Array(position, { minItems: 1, maxItems: 50, uniqueItems: true })) }, strict),
    outputSchema: batch,
    run({ batchId, positions }, { db }) {
      const row = readBatchRow(db, batchId);
      const items = currentAttempts(db, batchId);
      const failures = items.filter(item => item.status === 'failed');
      for (const position of positions ?? []) {
        const item = items.find(item => item.position === position);
        if (item?.status !== 'failed') {
          throw new OperationError(409, 'generation_batch_retry_ineligible', `Batch position ${position} is ${item?.status ?? 'missing'}. Only a confirmed failure can be retried.`);
        }
      }
      const plan = JSON.parse(row.plan_json) as Plan;
      for (const item of failures) {
        if (positions === undefined || positions.includes(item.position)) {
          enqueueAttempt(db, batchId, item.position, item.attempt + 1, item.source_generation_id, plan);
        }
      }
      return readBatch(db, batchId);
    },
  }),
];
