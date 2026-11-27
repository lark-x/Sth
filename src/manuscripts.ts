import { Type } from '@sinclair/typebox';
import { defineOperation } from './core/index.ts';
import { id, pagination, revision, strict, title } from './story/contracts.ts';

const resources = [
  { kind: 'diary', table: 'library_diary_revisions', identity: 'note_id', base: 'library_diaries' },
  { kind: 'scene', table: 'story_scene_revisions', identity: 'scene_id', base: 'story_scenes' },
  { kind: 'draft', table: 'story_draft_revisions', identity: 'draft_id', base: 'story_drafts' },
] as const;

// Revision inserts cover web, assistants and background generation in their own transaction.
export const manuscriptDDL = `
CREATE TABLE IF NOT EXISTS manuscript_activity (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('diary', 'scene', 'draft')),
  resource_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (kind, resource_id)
) STRICT;
CREATE INDEX IF NOT EXISTS manuscript_activity_by_updated ON manuscript_activity(updated_at DESC, sequence DESC);
${resources.map(resource => `
CREATE TRIGGER IF NOT EXISTS manuscript_${resource.kind}_revised AFTER INSERT ON ${resource.table}
BEGIN
  INSERT OR REPLACE INTO manuscript_activity (kind, resource_id, updated_at)
  VALUES ('${resource.kind}', NEW.${resource.identity}, CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
-- Older revisions have no timestamps. Keep them discoverable without inventing edit times.
INSERT INTO manuscript_activity (kind, resource_id, updated_at)
SELECT '${resource.kind}', r.${resource.identity}, 0 FROM ${resource.base} r
WHERE NOT EXISTS (SELECT 1 FROM manuscript_activity a WHERE a.kind = '${resource.kind}' AND a.resource_id = r.${resource.identity})
ORDER BY r.rowid;
`).join('\n')}`;

const kind = Type.Union([Type.Literal('diary'), Type.Literal('draft'), Type.Literal('scene')]);
const item = Type.Object({ kind, id, title, revision, href: Type.String(), sceneId: Type.Optional(id),
  updatedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, strict);

export const recentManuscripts = defineOperation({
  id: 'manuscript.recent', effect: 'read',
  description: 'List diaries, drafts and scenes by their latest persisted edit across web, assistants and generation. Read-only browsing does not change this order. Older records without edit timestamps use updatedAt 0. Page with limit and offset.',
  inputSchema: Type.Object(pagination, strict),
  outputSchema: Type.Object({ items: Type.Array(item, { maxItems: 50 }), nextOffset: Type.Optional(pagination.offset) }, strict),
  run({ limit = 20, offset = 0 }, { db }) {
    const rows = db.prepare(`SELECT a.kind, a.resource_id AS id, r.title, r.revision, NULL AS sceneId, a.updated_at AS updatedAt, a.sequence
      FROM manuscript_activity a JOIN library_diary_revisions r ON a.kind = 'diary' AND r.note_id = a.resource_id
      WHERE r.revision = (SELECT MAX(v.revision) FROM library_diary_revisions v WHERE v.note_id = r.note_id)
      UNION ALL SELECT a.kind, a.resource_id, r.title, r.revision, r.scene_id, a.updated_at, a.sequence
      FROM manuscript_activity a JOIN story_draft_revisions r ON a.kind = 'draft' AND r.draft_id = a.resource_id
      WHERE r.revision = (SELECT MAX(v.revision) FROM story_draft_revisions v WHERE v.draft_id = r.draft_id)
      UNION ALL SELECT a.kind, a.resource_id, r.title, r.revision, r.scene_id, a.updated_at, a.sequence
      FROM manuscript_activity a JOIN story_scene_revisions r ON a.kind = 'scene' AND r.scene_id = a.resource_id
      WHERE r.revision = (SELECT MAX(v.revision) FROM story_scene_revisions v WHERE v.scene_id = r.scene_id)
      ORDER BY updatedAt DESC, sequence DESC LIMIT ? OFFSET ?`).all(limit + 1, offset) as {
        kind: 'diary' | 'draft' | 'scene'; id: string; title: string; revision: number;
        sceneId: string | null; updatedAt: number; sequence: number;
      }[];
    const paths = { diary: 'diaries', draft: 'drafts', scene: 'scenes' };
    return {
      items: rows.slice(0, limit).map(({ sequence, sceneId, ...row }) => ({ ...row,
        href: `/${paths[row.kind]}/${encodeURIComponent(row.id)}`, ...(sceneId ? { sceneId } : {}),
      })),
      ...(rows.length > limit ? { nextOffset: offset + limit } : {}),
    };
  },
});
