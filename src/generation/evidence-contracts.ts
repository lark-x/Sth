import { Type, type Static } from '@sinclair/typebox';
import { SourceRangeSchema } from '../sources/contracts.ts';
import { generationSummary, id, pagination, revision, strict } from './contracts.ts';

export const manuscriptTarget = Type.Object({ sceneId: id, sceneRevision: revision }, strict);
export type ManuscriptTarget = Static<typeof manuscriptTarget>;
export const manuscriptPassage = Type.Object({
  ...SourceRangeSchema.properties,
  referenceIndex: Type.Integer({ minimum: 0, maximum: 31 }),
}, strict);
export const manuscriptEvidenceInput = Type.Object({
  ...manuscriptTarget.properties, draftId: Type.Optional(id), draftRevision: Type.Optional(revision), ...pagination,
}, strict);
export const manuscriptEvidenceItem = Type.Object({
  generation: generationSummary,
  relation: Type.Union([Type.Literal('prepared-for-scene'), Type.Literal('author-confirmed')]),
  passages: Type.Array(manuscriptPassage, { maxItems: 200 }),
}, strict);
export const manuscriptEvidencePage = Type.Object({
  items: Type.Array(manuscriptEvidenceItem, { maxItems: 50 }), hasMore: Type.Boolean(),
}, strict);
export type ManuscriptEvidenceItem = Static<typeof manuscriptEvidenceItem>;
export type ManuscriptEvidencePage = Static<typeof manuscriptEvidencePage>;

export const manuscriptEvidenceDDL = `
CREATE TABLE IF NOT EXISTS generation_manuscript_targets (
  generation_id TEXT PRIMARY KEY REFERENCES generation_records(generation_id),
  scene_id TEXT NOT NULL,
  scene_revision INTEGER NOT NULL,
  FOREIGN KEY (scene_id, scene_revision) REFERENCES story_scene_revisions(scene_id, revision)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS generation_manuscript_scene ON generation_manuscript_targets(scene_id, scene_revision);
CREATE TABLE IF NOT EXISTS generation_manuscript_drafts (
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  generation_id TEXT NOT NULL REFERENCES generation_records(generation_id),
  passages_json TEXT NOT NULL,
  PRIMARY KEY (draft_id, draft_revision),
  FOREIGN KEY (draft_id, draft_revision) REFERENCES story_draft_revisions(draft_id, revision)
) STRICT, WITHOUT ROWID;
`;
