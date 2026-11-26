import { Type } from '@sinclair/typebox';
import { defineOperation } from '../core/index.ts';
import { readBatchSummary } from '../generation/batches.ts';
import { readGenerationSummary } from '../generation/storage.ts';
import { readJobSummary } from './index.ts';

const strict = { additionalProperties: false };
const kind = Type.Union([Type.Literal('media'), Type.Literal('batch'), Type.Literal('writing'), Type.Literal('research')]);
const offset = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const item = Type.Object({ kind, id: Type.String(), title: Type.String(), createdAt: Type.String(),
  status: Type.String(), href: Type.String() }, strict);

export const taskActivity = defineOperation({
  id: 'tasks.list', effect: 'read',
  description: 'Browse background writing, batches, media and external research together, newest first. Open the returned link for results and available actions. Batch children appear in their parent.',
  inputSchema: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), offset: Type.Optional(offset) }, strict),
  outputSchema: Type.Object({ items: Type.Array(item, { maxItems: 50 }), nextOffset: Type.Optional(offset) }, strict),
  run({ limit = 20, offset = 0 }, { db }) {
    const rows = db.prepare(`SELECT 'media' AS kind, job_id AS id, title, created_at AS createdAt, NULL AS researchStatus FROM media_jobs
      UNION ALL SELECT 'batch', batch_id, title, created_at, NULL FROM generation_batches
      UNION ALL SELECT 'research', job_id, coalesce(query, doc_id), created_at, status FROM external_research_jobs
      UNION ALL SELECT 'writing', generation_id, title, created_at, NULL FROM generation_records g WHERE mode = 'delegation'
        AND NOT EXISTS (SELECT 1 FROM generation_batch_attempts a WHERE a.generation_id = g.generation_id)
      ORDER BY createdAt DESC, kind, id LIMIT ? OFFSET ?`).all(limit + 1, offset) as {
      kind: 'media' | 'batch' | 'writing' | 'research'; id: string; title: string; createdAt: string; researchStatus: string | null;
    }[];
    const items = rows.slice(0, limit).map(({ researchStatus, ...row }) => {
      if (row.kind === 'research') return { ...row, status: researchStatus!, href: `/research/${row.id}` };
      if (row.kind === 'media') {
        const { progress, href } = readJobSummary(db, row.id);
        const active = Object.entries(progress).filter(([, n]) => n > 0).map(([status]) => status);
        const status = active.length === 1 ? active[0] : progress.unknown ? 'unknown' :
          (progress.queued || progress.submitting || progress.submitted ? 'running' : 'partial');
        return { ...row, href, status };
      }
      const { href, status } = row.kind === 'batch' ? readBatchSummary(db, row.id) : readGenerationSummary(db, row.id);
      return { ...row, href, status };
    });
    return { items, ...(rows.length > limit ? { nextOffset: offset + limit } : {}) };
  },
});
