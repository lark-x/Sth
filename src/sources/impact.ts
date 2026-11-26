import { Type, type Static } from '@sinclair/typebox';
import { defineOperation } from '../core/index.ts';
import { eventHref, narrativeHref } from '../story/narrative-storage.ts';
import { defaultLimit, href, id, itemList, pagination, revision, strict, title } from './contracts.ts';
import { assertSourceText, readSource, sourcePinRows } from './storage.ts';

const versionedKind = Type.Union([
  Type.Literal('judgment'), Type.Literal('event'), Type.Literal('narrative'), Type.Literal('scene'),
  Type.Literal('draft'), Type.Literal('character'), Type.Literal('diary'),
]);
const impactKind = Type.Union([...versionedKind.anyOf, Type.Literal('generation')]);
const link = Type.Object({ kind: versionedKind, id, revision }, strict);
const item = Type.Object({
  sourceRevision: revision, kind: impactKind, id, revision: Type.Optional(revision), title, href,
  state: Type.Union([Type.Literal('current'), Type.Literal('historical'), Type.Literal('snapshot')]),
  via: Type.Array(link, { maxItems: 3 }),
}, strict);
const page = Type.Object({
  ...itemList(item).properties,
  nextOffset: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}, strict);
export type SourceImpact = Static<typeof item>;
export type SourceImpactPage = Static<typeof page>;

const versionedTargets = [
  ['judgment', 'research_judgment_revisions', 'judgment_id', 'title'],
  ['event', 'story_event_revisions', 'event_id', 'title'],
  ['narrative', 'story_narrative_revisions', 'narrative_id', 'title'],
  ['scene', 'story_scene_revisions', 'scene_id', 'title'],
  ['draft', 'story_draft_revisions', 'draft_id', 'title'],
  ['character', 'library_character_revisions', 'character_id', 'name'],
  ['diary', 'library_diary_revisions', 'note_id', 'title'],
] as const satisfies ReadonlyArray<readonly [Static<typeof versionedKind>, string, string, string]>;

// Each CTE follows a specific persisted relation. Scene and draft links from a telling are endpoints.
const impactQuery = `
WITH
  direct_hits (source_revision, kind, id, revision, via) AS (
    SELECT source_revision, owner_kind, owner_id, owner_revision, json_array()
    FROM (${sourcePinRows}) WHERE source_id = $sourceId AND ($revision IS NULL OR source_revision = $revision)
  ),
  judgment_hits AS (
    SELECT DISTINCT source_revision, 'judgment' AS kind, judgment_id AS id, judgment_revision AS revision, json_array() AS via
    FROM research_judgment_evidence WHERE source_id = $sourceId AND ($revision IS NULL OR source_revision = $revision)
  ),
  event_hits (source_revision, kind, id, revision, via) AS (
    SELECT DISTINCT ref.value ->> '$.revision', 'event', e.event_id, e.revision, json_array()
    FROM story_event_revisions e, json_each(e.evidence_json) ref
    WHERE ref.value ->> '$.kind' = 'source' AND ref.value ->> '$.sourceId' = $sourceId
      AND ($revision IS NULL OR ref.value ->> '$.revision' = $revision)
    UNION
    SELECT j.source_revision, 'event', e.event_id, e.revision,
      json_array(json_object('kind', j.kind, 'id', j.id, 'revision', j.revision))
    FROM story_event_revisions e, json_each(e.evidence_json) ref JOIN judgment_hits j
      ON ref.value ->> '$.kind' = j.kind AND ref.value ->> '$.judgmentId' = j.id AND ref.value ->> '$.revision' = j.revision
  ),
  narrative_hits (source_revision, kind, id, revision, via) AS (
    SELECT DISTINCT e.source_revision, 'narrative', n.narrative_id, n.revision,
      json_insert(e.via, '$[#]', json_object('kind', e.kind, 'id', e.id, 'revision', e.revision))
    FROM story_narrative_revisions n, json_each(json_array('eventOrder', 'knownEvents')) list,
      json_each(n.payload_json, '$.' || list.value) ref JOIN event_hits e
        ON ref.value ->> '$.eventId' = e.id AND ref.value ->> '$.revision' = e.revision
  ),
  telling_resources (source_revision, kind, id, revision, via) AS (
    SELECT h.source_revision, 'scene', n.scene_id, n.scene_revision,
      json_insert(h.via, '$[#]', json_object('kind', h.kind, 'id', h.id, 'revision', h.revision))
    FROM narrative_hits h JOIN story_narrative_revisions n ON n.narrative_id = h.id AND n.revision = h.revision
    UNION ALL
    SELECT h.source_revision, 'draft', n.payload_json ->> '$.draft.draftId', n.payload_json ->> '$.draft.revision',
      json_insert(h.via, '$[#]', json_object('kind', h.kind, 'id', h.id, 'revision', h.revision))
    FROM narrative_hits h JOIN story_narrative_revisions n ON n.narrative_id = h.id AND n.revision = h.revision
    WHERE n.payload_json ->> '$.draft.draftId' IS NOT NULL
  ),
  draft_hits (source_revision, kind, id, revision, via) AS (
    SELECT source_revision, kind, id, revision, via FROM direct_hits WHERE kind = 'draft'
    UNION
    SELECT h.source_revision, 'draft', d.draft_id, d.revision,
      json_array(json_object('kind', h.kind, 'id', h.id, 'revision', h.revision))
    FROM direct_hits h JOIN story_draft_revisions d ON h.kind = 'scene' AND h.id = d.scene_id AND h.revision = d.scene_revision
  ),
  character_hits (source_revision, kind, id, revision, via) AS (
    SELECT DISTINCT resource_revision, 'character', character_id, character_revision, json_array()
    FROM library_character_entry_blocks
    WHERE resource_kind = 'source' AND resource_id = $sourceId AND ($revision IS NULL OR resource_revision = $revision)
    UNION
    SELECT j.source_revision, 'character', b.character_id, b.character_revision,
      json_array(json_object('kind', j.kind, 'id', j.id, 'revision', j.revision))
    FROM judgment_hits j JOIN library_character_entry_blocks b
      ON b.resource_kind = 'judgment' AND b.resource_id = j.id AND b.resource_revision = j.revision
  ),
  prompt_refs AS MATERIALIZED (
    SELECT g.generation_id, ref.value AS ref, ref.value ->> '$.kind' AS kind
    FROM generation_records g, json_each(g.composition_json, '$.references') ref
    WHERE $kind IS NULL OR $kind = 'generation'
  ),
  prompt_pins (generation_id, kind, id, revision) AS (
    SELECT generation_id, kind, ref ->> '$.id', ref ->> '$.revision' FROM prompt_refs
    WHERE kind IN ('source', 'judgment', 'event', 'draft')
    UNION
    SELECT r.generation_id, 'source', pin.value ->> '$.sourceId', pin.value ->> '$.revision'
    FROM prompt_refs r, json_each(r.ref, '$.content.sources') pin WHERE r.kind = 'scene'
    UNION
    SELECT r.generation_id, block.value ->> '$.kind', block.value ->> '$.id', block.value ->> '$.revision'
    FROM prompt_refs r, json_each(r.ref, '$.content.entries') entry, json_each(entry.value, '$.blocks') block
    WHERE r.kind = 'character' AND block.value ->> '$.type' = 'reference'
      AND block.value ->> '$.kind' IN ('source', 'judgment', 'draft')
    UNION
    SELECT g.generation_id, 'event', ref.value ->> '$.eventId', ref.value ->> '$.revision'
    FROM generation_records g, json_each(json_array('knownEvents', 'eventOrder')) list,
      json_each(g.composition_json, '$.story.' || list.value) ref
    WHERE $kind IS NULL OR $kind = 'generation'
  ),
  prompt_dependencies AS (
    SELECT * FROM judgment_hits UNION ALL SELECT * FROM event_hits UNION ALL SELECT * FROM draft_hits
  ),
  generation_hits (source_revision, kind, id, revision, via) AS (
    SELECT p.revision, 'generation', p.generation_id, NULL, json_array()
    FROM prompt_pins p WHERE p.kind = 'source' AND p.id = $sourceId AND ($revision IS NULL OR p.revision = $revision)
    UNION ALL
    SELECT h.source_revision, 'generation', p.generation_id, NULL,
      json_insert(h.via, '$[#]', json_object('kind', h.kind, 'id', h.id, 'revision', h.revision))
    FROM prompt_pins p JOIN prompt_dependencies h ON h.kind = p.kind AND h.id = p.id AND h.revision = p.revision
  ),
  hits AS (
    SELECT * FROM direct_hits UNION ALL SELECT * FROM judgment_hits UNION ALL SELECT * FROM event_hits
    UNION ALL SELECT * FROM narrative_hits UNION ALL SELECT * FROM telling_resources UNION ALL SELECT * FROM draft_hits
    UNION ALL SELECT * FROM character_hits UNION ALL SELECT * FROM generation_hits
  ),
  ranked AS (
    SELECT *, row_number() OVER (PARTITION BY source_revision, kind, id, revision ORDER BY json_array_length(via), via) AS choice
    FROM hits WHERE $kind IS NULL OR kind = $kind
  ),
  targets AS (
    ${versionedTargets.map(([kind, table, key, label]) => `
    SELECT h.source_revision, h.kind, h.id, h.revision, h.via, r.${label} AS title,
      (SELECT MAX(v.revision) FROM ${table} v WHERE v.${key} = h.id) AS latest_revision
    FROM ranked h JOIN ${table} r ON r.${key} = h.id AND r.revision = h.revision
    WHERE h.kind = '${kind}' AND h.choice = 1`).join('\n    UNION ALL')}
    UNION ALL
    SELECT h.source_revision, h.kind, h.id, h.revision, h.via, g.title, NULL
    FROM ranked h JOIN generation_records g ON g.generation_id = h.id WHERE h.kind = 'generation' AND h.choice = 1
  )
SELECT * FROM targets WHERE $currentOnly = 0 OR revision = latest_revision
ORDER BY source_revision DESC, kind, id, revision DESC LIMIT $limit OFFSET $offset`;

type ImpactRow = {
  source_revision: number; kind: SourceImpact['kind']; id: string; revision: number | null; via: string; title: string;
  latest_revision: number | null;
};

function impactHref({ id, kind, revision }: ImpactRow) {
  const encodedId = encodeURIComponent(id);
  if (revision === null) return `/generations/${encodedId}/prompt`;
  if (kind === 'event') return eventHref(encodedId, revision);
  if (kind === 'narrative') return narrativeHref(encodedId, revision);
  const collection = kind === 'diary' ? 'diaries' : `${kind}s`;
  return `/${collection}/${encodedId}?revision=${revision}`;
}

function toImpact(row: ImpactRow): SourceImpact {
  return {
    sourceRevision: row.source_revision, kind: row.kind, id: row.id, title: row.title, href: impactHref(row),
    ...(row.revision === null ? {} : { revision: row.revision }),
    state: row.revision === null ? 'snapshot' : row.revision === row.latest_revision ? 'current' : 'historical',
    via: JSON.parse(row.via) as SourceImpact['via'],
  };
}

export const sourceImpact = defineOperation({
  id: 'source.impact', effect: 'read',
  description: 'List pinned revisions and generation prompt snapshots affected by a source. Omit revision to include all source revisions. Filter by kind or currentOnly (latest resource revisions only). Each result shows one shortest path. Page with limit and nextOffset.',
  inputSchema: Type.Object({
    sourceId: id, revision: Type.Optional(revision), kind: Type.Optional(impactKind), currentOnly: Type.Optional(Type.Boolean()), ...pagination,
  }, strict),
  outputSchema: page,
  run({ sourceId, revision, kind, currentOnly = false, offset = 0, limit = defaultLimit }, { db }) {
    assertSourceText(sourceId);
    readSource(db, sourceId, revision);
    const rows = db.prepare(impactQuery).all({
      $sourceId: sourceId, $revision: revision ?? null, $kind: kind ?? null,
      $currentOnly: Number(currentOnly), $limit: limit + 1, $offset: offset,
    }) as ImpactRow[];
    const items = rows.slice(0, limit).map(toImpact);
    return rows.length > limit ? { items, nextOffset: offset + limit } : { items };
  },
});
