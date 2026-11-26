import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Type, type Static } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { requireProject } from '../library/storage.ts';
import {
  body, defaultLimit, evidenceStance, href, id, itemList, kind, LinkedSourcePinSchema, origin, ownerKind, pagination,
  projectIds, resultLink, revision, SourceBacklinkOwnerSchema, sourceOffset, SourceRangeSchema, strict, title, type SourceRange,
} from './contracts.ts';
import { sourceImpact } from './impact.ts';
import { judgmentHref, judgmentOperations, judgmentsDDL } from './judgments.ts';
import { toSourcePin } from './pins.ts';
import { assertSourceRange, sourceContextRange, sourceMatches } from './ranges.ts';
import {
  assertSourceText, currentSources, rangedSourcePinsDDL, readSource, sourcesDDL as baseSourcesDDL,
  sourcePinRows, sourceRevisions, toSourceSummary, writeSourceRevision, type SourcePinRow, type SourceRow,
} from './storage.ts';

export { readSource } from './storage.ts';
export type { SourceImpact, SourceImpactPage } from './impact.ts';
export { readJudgment, type Judgment, type JudgmentSummary } from './judgments.ts';
export {
  ExactSourcePinSchema, LinkedSourcePinSchema, LinkedSourcePinsSchema, SourcePinSchema, SourcePinsSchema, sourceHref, SourceRangeSchema,
  type LinkedSourcePin, type SourcePin, type SourcePinOwner, type SourcePinOwnerKey, type SourceRange,
} from './contracts.ts';
export { readSourcePins, validateSourcePins, writeSourcePins } from './pins.ts';

export const researchDDL = rangedSourcePinsDDL + judgmentsDDL;
export const sourcesDDL = baseSourcesDDL + researchDDL;

const filters = { kind: Type.Optional(kind), projectId: Type.Optional(id) };
const sourceSummaryFields = { sourceId: id, revision, kind, title, href, projectIds, origin: Type.Optional(origin) };
const sourceSummary = Type.Object(sourceSummaryFields, strict);
const source = Type.Object({ ...sourceSummaryFields, body }, strict);
const sourceReadResult = Type.Object({
  ...source.properties,
  body: Type.String({ minLength: 1, maxLength: body.maxLength }),
  context: Type.Optional(Type.Object({ range: SourceRangeSchema, bodyRange: SourceRangeSchema }, strict)),
}, strict);
const maxMatchLimit = 50;
const searchResult = Type.Object({
  ...sourceSummaryFields, matches: Type.Optional(Type.Array(SourceRangeSchema, { maxItems: maxMatchLimit })),
}, strict);
const backlink = Type.Object({
  owner: SourceBacklinkOwnerSchema, pin: LinkedSourcePinSchema, stance: Type.Optional(evidenceStance),
}, strict);

export type Source = Static<typeof source>;
export type SourceReadResult = Static<typeof sourceReadResult>;
export type SourceSummary = Static<typeof sourceSummary>;
export type SourceSearchResult = Static<typeof searchResult>;
export type SourceBacklink = Static<typeof backlink>;
type SourceBacklinkRow = SourcePinRow & {
  owner_kind: SourceBacklink['owner']['kind']; owner_id: string; owner_revision: number;
  title: string; href: string | null; project_id: string | null; stance: SourceBacklink['stance'] | null;
};

function listSources(db: DatabaseSync, input: {
  kind?: Static<typeof kind>; projectId?: string; sourceId?: string; revision?: number;
  query?: string; limit?: number; offset?: number; matchLimit?: number; matchOffset?: number;
}) {
  const { kind, projectId, sourceId, revision, query, limit = defaultLimit, offset = 0, matchLimit, matchOffset } = input;
  assertSourceText(projectId ?? '', sourceId ?? '', query ?? '');
  const conditions: string[] = [];
  const parameters: (string | number)[] = [];
  let from = currentSources;
  if (revision !== undefined) {
    if (sourceId === undefined) throw new OperationError(400, 'source_revision_requires_id', 'Supply sourceId to search a specific revision.');
    readSource(db, sourceId, revision);
    from = `${sourceRevisions} WHERE r.revision = ?`;
    parameters.push(revision);
  }
  if (sourceId !== undefined) {
    conditions.push('r.source_id = ?');
    parameters.push(sourceId);
  }
  if (kind !== undefined) {
    conditions.push('r.kind = ?');
    parameters.push(kind);
  }
  if (projectId !== undefined) {
    conditions.push(`EXISTS (SELECT 1 FROM source_revision_projects p
      WHERE p.source_id = r.source_id AND p.revision = r.revision AND p.project_id = ?)`);
    parameters.push(projectId);
  }
  if (query !== undefined) {
    conditions.push('(instr(r.title, ?) > 0 OR instr(r.body, ?) > 0 OR instr(r.origin, ?) > 0)');
    parameters.push(query, query, query);
  }
  const where = conditions.length === 0 ? '' : `AND ${conditions.join(' AND ')}`;
  const rows = db.prepare(`${from} ${where} ORDER BY r.title, r.source_id LIMIT ? OFFSET ?`)
    .all(...parameters, limit, offset) as SourceRow[];
  if (query === undefined || (matchLimit === undefined && matchOffset === undefined)) return { items: rows.map(toSourceSummary) };
  return { items: rows.map(row => ({
    ...toSourceSummary(row), matches: sourceMatches(row.body, query, matchLimit ?? defaultLimit, matchOffset ?? 0),
  })) };
}

export const sourceOperations = [
  defineOperation({
    id: 'source.create', effect: 'write',
    description: 'Save a setting, inspiration, or excerpt with its original text and optional origin. Omit projectIds for a personal source or attach the same source to multiple projects.',
    interaction: { resultLink },
    inputSchema: Type.Object({ kind, title, body, origin: Type.Optional(origin), projectIds: Type.Optional(projectIds) }, strict),
    outputSchema: source,
    run(input, { db }) {
      const { kind, title, body, origin, projectIds = [] } = input;
      assertSourceText(title, body, origin ?? '', ...projectIds);
      for (const projectId of projectIds) requireProject(db, projectId);
      const sourceId = randomUUID();
      db.prepare('INSERT INTO sources (source_id) VALUES (?)').run(sourceId);
      writeSourceRevision(db, sourceId, 1, { kind, title: title.trim(), body, origin, projectIds });
      return readSource(db, sourceId, 1);
    },
  }),
  defineOperation({
    id: 'source.read', effect: 'read',
    description: 'Read an exact source revision by ID, or omit revision for the latest. Supply a UTF-16 range to return a body window identified by context.bodyRange. contextChars sets the surrounding size on each side (default 200, use 0 for the selection alone).',
    interaction: { resultLink },
    inputSchema: Type.Object({
      sourceId: id, revision: Type.Optional(revision), range: Type.Optional(SourceRangeSchema),
      contextChars: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_000 })),
    }, strict),
    outputSchema: sourceReadResult,
    run({ sourceId, revision, range, contextChars }, { db }) {
      assertSourceText(sourceId);
      const source = readSource(db, sourceId, revision);
      if (range === undefined) {
        if (contextChars !== undefined) throw new OperationError(400, 'source_context_requires_range', 'Supply a range to read surrounding text.');
        return source;
      }
      const bodyRange = sourceContextRange(source.body, range, contextChars ?? 200);
      return { ...source, body: source.body.slice(bodyRange.start, bodyRange.end), context: { range, bodyRange } };
    },
  }),
  defineOperation({
    id: 'source.list', effect: 'read', description: 'List latest source summaries ordered by title then ID. Filter by kind or attached projectId. Omit projectId to include personal and project sources. Use limit and offset to page.',
    inputSchema: Type.Object({ ...filters, ...pagination }, strict), outputSchema: itemList(sourceSummary),
    run: (input, { db }) => listSources(db, input),
  }),
  defineOperation({
    id: 'source.search', effect: 'read',
    description: 'Find local sources by a literal, case-sensitive substring of title, body, or origin. Search a specific revision with sourceId and revision. Supply matchLimit or matchOffset to include paged UTF-16 body matches in occurrence order, including overlapping matches. Use source.read with a match range for context.',
    inputSchema: Type.Object({
      query: Type.String({ maxLength: 500, pattern: '\\S' }), ...filters, ...pagination,
      sourceId: Type.Optional(id), revision: Type.Optional(revision),
      matchLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxMatchLimit })), matchOffset: Type.Optional(sourceOffset),
    }, strict),
    outputSchema: itemList(searchResult),
    run: (input, { db }) => listSources(db, input),
  }),
  defineOperation({
    id: 'source.revise', effect: 'write',
    description: 'Revise source fields using the latest revision as expectedRevision. Omitted fields retain their values. Pass null to clear origin, or supply projectIds to replace project attachments, including [] to make the source personal. Existing pins keep their original revisions.',
    interaction: { resultLink },
    inputSchema: Type.Object({
      sourceId: id, expectedRevision: revision, kind: Type.Optional(kind), title: Type.Optional(title),
      body: Type.Optional(body), origin: Type.Optional(Type.Union([origin, Type.Null()])), projectIds: Type.Optional(projectIds),
    }, strict),
    outputSchema: source,
    run(input, { db }) {
      assertSourceText(input.sourceId, input.title ?? '', input.body ?? '', input.origin ?? '', ...(input.projectIds ?? []));
      const current = readSource(db, input.sourceId);
      if (input.expectedRevision !== current.revision) {
        throw new OperationError(409, 'source_revision_conflict', `Source is at revision ${current.revision}. Read it before revising.`);
      }
      const kind = input.kind ?? current.kind;
      const title = input.title?.trim() ?? current.title;
      const body = input.body ?? current.body;
      const origin = input.origin === undefined ? current.origin : input.origin ?? undefined;
      const projectIds = input.projectIds?.toSorted() ?? current.projectIds;
      if (kind === current.kind && title === current.title && body === current.body && origin === current.origin
        && projectIds.length === current.projectIds.length && projectIds.every((id, index) => id === current.projectIds[index])) {
        return current;
      }
      for (const projectId of projectIds) requireProject(db, projectId);
      const revision = current.revision + 1;
      writeSourceRevision(db, input.sourceId, revision, { kind, title, body, origin, projectIds });
      return readSource(db, input.sourceId, revision);
    },
  }),
  defineOperation({
    id: 'source.history', effect: 'read', description: 'List immutable source revisions from newest to oldest. Read a listed revision for its original text. Use limit and offset to page.',
    inputSchema: Type.Object({ sourceId: id, ...pagination }, strict), outputSchema: itemList(sourceSummary),
    run({ sourceId, limit = defaultLimit, offset = 0 }, { db }) {
      assertSourceText(sourceId);
      if (!db.prepare('SELECT 1 FROM sources WHERE source_id = ?').get(sourceId)) {
        throw new OperationError(404, 'source_not_found', `Source ${sourceId} was not found.`);
      }
      const rows = db.prepare(`${sourceRevisions} WHERE r.source_id = ? ORDER BY r.revision DESC LIMIT ? OFFSET ?`)
        .all(sourceId, limit, offset) as SourceRow[];
      return { items: rows.map(toSourceSummary) };
    },
  }),
  defineOperation({
    id: 'source.backlinks', effect: 'read',
    description: 'List diary, scene, draft, and judgment revisions that cite a source, including historical versions and judgment evidence stance. Filter by source revision, ownerKind, or owner projectId. Provide revision and range to find overlapping citations. An excerpt without stored coordinates is included only if it occurs exactly once in that revision. Use limit and offset to page.',
    inputSchema: Type.Object({
      sourceId: id, revision: Type.Optional(revision), range: Type.Optional(SourceRangeSchema),
      ownerKind: Type.Optional(ownerKind), projectId: Type.Optional(id), ...pagination,
    }, strict),
    outputSchema: itemList(backlink),
    run({ sourceId, revision, range, ownerKind, projectId, limit = defaultLimit, offset = 0 }, { db }) {
      assertSourceText(sourceId, projectId ?? '');
      const source = readSource(db, sourceId, revision);
      const conditions = ['source_id = ?'];
      const parameters: (string | number)[] = [sourceId];
      const inferredRanges = new Map<string, SourceRange>();
      if (revision !== undefined) {
        conditions.push('source_revision = ?');
        parameters.push(revision);
      }
      if (range !== undefined) {
        if (revision === undefined) throw new OperationError(400, 'source_range_requires_revision', 'Supply revision when filtering backlinks by range.');
        assertSourceRange(source.body, range);
        const excerpts = db.prepare('SELECT DISTINCT excerpt FROM source_pins WHERE source_id = ? AND source_revision = ?');
        for (const row of excerpts.iterate(sourceId, revision)) {
          const excerpt = row.excerpt as string;
          const matches = sourceMatches(source.body, excerpt, 2, 0);
          if (matches.length === 1 && matches[0].start < range.end && matches[0].end > range.start) {
            inferredRanges.set(excerpt, matches[0]);
          }
        }
        conditions.push('((range_start < ? AND range_end > ?) OR (range_start IS NULL AND excerpt IN (SELECT value FROM json_each(?))))');
        parameters.push(range.end, range.start, JSON.stringify([...inferredRanges.keys()]));
      }
      if (ownerKind !== undefined) {
        conditions.push('owner_kind = ?');
        parameters.push(ownerKind);
      }
      if (projectId !== undefined) {
        conditions.push('project_id = ?');
        parameters.push(projectId);
      }
      const rows = db.prepare(`WITH backlinks AS (
          SELECT p.*, o.title, o.href, o.project_id, NULL AS stance FROM (${sourcePinRows}) p
            JOIN source_pin_owners o USING (owner_kind, owner_id, owner_revision)
          UNION ALL
          SELECT 'judgment', e.judgment_id, e.judgment_revision, e.position, e.source_id, e.source_revision, e.excerpt,
            e.range_start, e.range_end, r.title, NULL, r.project_id, e.stance
            FROM research_judgment_evidence e JOIN research_judgment_revisions r
              ON r.judgment_id = e.judgment_id AND r.revision = e.judgment_revision
        ) SELECT * FROM backlinks
        WHERE ${conditions.join(' AND ')}
        ORDER BY owner_kind, owner_id, owner_revision DESC, position LIMIT ? OFFSET ?`)
        .all(...parameters, limit, offset) as SourceBacklinkRow[];
      return { items: rows.map(row => ({
        owner: {
          kind: row.owner_kind, id: row.owner_id, revision: row.owner_revision, title: row.title,
          href: row.href ?? judgmentHref(row.owner_id, row.owner_revision),
          ...(row.project_id === null ? {} : { projectId: row.project_id }),
        },
        pin: row.range_start === null && inferredRanges.has(row.excerpt)
          ? { ...toSourcePin(row), range: inferredRanges.get(row.excerpt) } : toSourcePin(row),
        ...(row.stance == null ? {} : { stance: row.stance }),
      })) };
    },
  }),
  sourceImpact,
  ...judgmentOperations,
];
