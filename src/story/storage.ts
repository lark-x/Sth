import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import { displayCharacterName, nameKey } from '../library/storage.ts';
import type { SourcePin } from '../sources/contracts.ts';
import { readSourcePins, writeSourcePins } from '../sources/pins.ts';
import type { BranchOrigin, CharacterPin, DraftRef, Scene, SceneSummary } from './contracts.ts';

export function assertText(...values: (string | null | undefined)[]) {
  if (values.some(value => value != null && /[\0\p{Surrogate}]/u.test(value))) {
    throw new OperationError(400, 'story_invalid_text', 'Provide well-formed text without NUL characters.');
  }
}

export function requireRevision(kind: 'chapter' | 'scene' | 'draft' | 'event' | 'narrative' | 'branch', actual: number, expected: number) {
  if (actual !== expected) {
    throw new OperationError(409, `${kind}_revision_conflict`, `The ${kind} is at revision ${actual}. Read it before retrying.`);
  }
}

export const chapterRows = `
  SELECT c.*, (SELECT COUNT(*) FROM story_chapter_scenes m WHERE m.chapter_id = c.chapter_id) AS scene_count
  FROM story_chapters c`;

export type ChapterRow = {
  chapter_id: string;
  project_id: string;
  title: string;
  position: number;
  revision: number;
  scene_count: number;
};

export function toChapter(row: ChapterRow) {
  return {
    chapterId: row.chapter_id, projectId: row.project_id, title: row.title,
    position: row.position, revision: row.revision, sceneCount: row.scene_count, href: `/chapters/${row.chapter_id}`,
  };
}

export function readChapter(db: DatabaseSync, chapterId: string) {
  const row = db.prepare(`${chapterRows} WHERE c.chapter_id = ?`).get(chapterId) as ChapterRow | undefined;
  if (!row) throw new OperationError(404, 'chapter_not_found', `Chapter ${chapterId} was not found.`);
  return toChapter(row);
}

export const sceneRows = `SELECT r.*, s.origin_scene_id, s.origin_scene_revision, s.origin_draft_id, s.origin_draft_revision, s.divergence,
    m.chapter_id, m.position, c.project_id, COALESCE(b.branch_id, d.branch_id) AS branch_id
  FROM story_scenes s
  JOIN story_scene_revisions r ON r.scene_id = s.scene_id
  LEFT JOIN story_chapter_scenes m ON m.scene_id = s.scene_id
  LEFT JOIN story_chapters c ON c.chapter_id = m.chapter_id
  LEFT JOIN story_branch_scenes b ON b.scene_id = s.scene_id
  LEFT JOIN story_branch_details d ON d.branch_id = s.scene_id`;

export const currentScene = `r.revision = (SELECT MAX(revision) FROM story_scene_revisions WHERE scene_id = s.scene_id)`;

export type SceneRow = {
  scene_id: string;
  revision: number;
  title: string;
  time: string | null;
  place: string | null;
  branch_id: string | null;
} & (
  | { adopted_draft_id: null; adopted_draft_revision: null }
  | { adopted_draft_id: string; adopted_draft_revision: number }
) & (
  | { chapter_id: null; position: null; project_id: null }
  | { chapter_id: string; position: number; project_id: string }
) & (
  | { origin_scene_id: null; origin_scene_revision: null; divergence: null; origin_draft_id: null; origin_draft_revision: null }
  | ({ origin_scene_id: string; origin_scene_revision: number; divergence: string } & (
    | { origin_draft_id: null; origin_draft_revision: null }
    | { origin_draft_id: string; origin_draft_revision: number }
  ))
);

export function sceneHref(sceneId: string, revision?: number) {
  const path = `/scenes/${sceneId}`;
  return revision === undefined ? path : `${path}?revision=${revision}`;
}

function draftHref(draftId: string, revision?: number) {
  const path = `/drafts/${draftId}`;
  return revision === undefined ? path : `${path}?revision=${revision}`;
}

export function toSceneSummary(row: SceneRow): SceneSummary {
  return {
    sceneId: row.scene_id, revision: row.revision, title: row.title, href: sceneHref(row.scene_id),
    ...(row.time === null ? {} : { time: row.time }),
    ...(row.place === null ? {} : { place: row.place }),
    ...(row.branch_id === null ? {} : { branchId: row.branch_id }),
    ...(row.chapter_id === null ? {} : {
      placement: { chapterId: row.chapter_id, projectId: row.project_id, position: row.position },
    }),
    ...(row.origin_scene_id === null ? {} : {
      branchFrom: {
        sceneId: row.origin_scene_id, revision: row.origin_scene_revision, divergence: row.divergence,
        ...(row.origin_draft_id === null ? {} : {
          draft: { draftId: row.origin_draft_id, revision: row.origin_draft_revision },
        }),
      },
    }),
    ...(row.adopted_draft_id === null ? {} : {
      adopted: { draftId: row.adopted_draft_id, revision: row.adopted_draft_revision },
    }),
  };
}

export function readSceneSummary(db: DatabaseSync, sceneId: string, revision?: number) {
  const row = (revision === undefined
    ? db.prepare(`${sceneRows} WHERE s.scene_id = ? AND ${currentScene}`).get(sceneId)
    : db.prepare(`${sceneRows} WHERE s.scene_id = ? AND r.revision = ?`).get(sceneId, revision)) as SceneRow | undefined;
  if (row) return toSceneSummary(row);
  if (revision !== undefined && db.prepare('SELECT 1 FROM story_scenes WHERE scene_id = ?').get(sceneId)) {
    throw new OperationError(404, 'scene_revision_not_found', `Scene ${sceneId} has no revision ${revision}.`);
  }
  throw new OperationError(404, 'scene_not_found', `Scene ${sceneId} was not found.`);
}

export function readScene(db: DatabaseSync, sceneId: string, revision?: number): Scene {
  const { adopted, ...summary } = readSceneSummary(db, sceneId, revision);
  const rows = db.prepare(`SELECT r.character_id, r.revision, r.name, r.persona
    FROM story_scene_characters p JOIN library_character_revisions r
      ON r.character_id = p.character_id AND r.revision = p.character_revision
    WHERE p.scene_id = ? AND p.scene_revision = ? ORDER BY p.position`)
    .all(sceneId, summary.revision) as { character_id: string; revision: number; name: string; persona: string }[];
  return {
    ...summary,
    characters: rows.map(({ character_id, revision, name, persona }) => ({
      characterId: character_id, revision, name: displayCharacterName(name), persona,
    })),
    sources: readSourcePins(db, { kind: 'scene', id: sceneId, revision: summary.revision }),
    ...(adopted === undefined ? {} : { adopted: readDraft(db, adopted.draftId, adopted.revision) }),
  };
}

export type SceneContext = {
  title: string;
  time?: string;
  place?: string;
  characters: CharacterPin[];
  sources: SourcePin[];
};

export function sceneContext(scene: Scene): SceneContext {
  return {
    title: scene.title, time: scene.time, place: scene.place,
    characters: scene.characters.map(({ characterId, revision }) => ({ characterId, revision })),
    sources: scene.sources.map(({ href, ...pin }) => pin),
  };
}

export function insertScene(db: DatabaseSync, sceneId: string, branch?: BranchOrigin) {
  db.prepare(`INSERT INTO story_scenes
    (scene_id, origin_scene_id, origin_scene_revision, origin_draft_id, origin_draft_revision, divergence)
    VALUES (?, ?, ?, ?, ?, ?)`).run(sceneId, branch?.sceneId ?? null, branch?.revision ?? null,
    branch?.draft?.draftId ?? null, branch?.draft?.revision ?? null, branch?.divergence ?? null);
}

export function writeSceneRevision(
  db: DatabaseSync, sceneId: string, revision: number, context: SceneContext, adopted?: DraftRef, projectId?: string,
) {
  const { title, time, place, sources, characters } = context;
  db.prepare(`INSERT INTO story_scene_revisions (scene_id, revision, title, title_key, time, place,
    adopted_draft_id, adopted_draft_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sceneId, revision, title, nameKey(title), time ?? null, place ?? null,
      adopted?.draftId ?? null, adopted?.revision ?? null);

  const seen = new Set<string>();
  const characterVersion = db.prepare('SELECT 1 FROM library_character_revisions WHERE character_id = ? AND revision = ?');
  const insertCharacter = db.prepare(`INSERT INTO story_scene_characters
    (scene_id, scene_revision, position, character_id, character_revision) VALUES (?, ?, ?, ?, ?)`);
  characters.forEach(({ characterId, revision: characterRevision }, index) => {
    if (seen.has(characterId)) {
      throw new OperationError(400, 'scene_duplicate_character', `Character ${characterId} is already in the cast.`);
    }
    if (!characterVersion.get(characterId, characterRevision)) {
      throw new OperationError(404, 'scene_character_revision_not_found',
        `Character ${characterId} revision ${characterRevision} was not found.`);
    }
    seen.add(characterId);
    insertCharacter.run(sceneId, revision, index + 1, characterId, characterRevision);
  });

  if (sources.length) {
    writeSourcePins(db, {
      kind: 'scene', id: sceneId, revision, title, href: sceneHref(sceneId, revision),
      ...(projectId === undefined ? {} : { projectId }),
    }, sources);
  }
}

export const currentDraft = `r.revision = (SELECT MAX(revision) FROM story_draft_revisions WHERE draft_id = r.draft_id)`;

export type DraftSummaryRow = {
  scene_id: string;
  scene_revision: number;
  draft_id: string;
  revision: number;
  title: string;
};

export function toDraftSummary(row: DraftSummaryRow) {
  return {
    draftId: row.draft_id, revision: row.revision, sceneId: row.scene_id, sceneRevision: row.scene_revision,
    title: row.title, href: draftHref(row.draft_id), sceneHref: sceneHref(row.scene_id, row.scene_revision),
  };
}

export function readDraft(db: DatabaseSync, draftId: string, revision?: number) {
  const row = (revision === undefined
    ? db.prepare(`SELECT r.* FROM story_draft_revisions r WHERE r.draft_id = ? AND ${currentDraft}`).get(draftId)
    : db.prepare('SELECT * FROM story_draft_revisions WHERE draft_id = ? AND revision = ?').get(draftId, revision)) as
    (DraftSummaryRow & { body: string }) | undefined;
  if (row) return { ...toDraftSummary(row), href: draftHref(draftId, revision), body: row.body };
  if (revision !== undefined && db.prepare('SELECT 1 FROM story_drafts WHERE draft_id = ?').get(draftId)) {
    throw new OperationError(404, 'draft_revision_not_found', `Draft ${draftId} has no revision ${revision}.`);
  }
  throw new OperationError(404, 'draft_not_found', `Draft ${draftId} was not found.`);
}

export function readSceneDraft(db: DatabaseSync, sceneId: string, ref: DraftRef) {
  const draft = readDraft(db, ref.draftId, ref.revision);
  if (draft.sceneId !== sceneId) {
    throw new OperationError(409, 'draft_scene_mismatch', `Draft ${ref.draftId} belongs to scene ${draft.sceneId}.`);
  }
  return draft;
}

export function writeDraftRevision(
  db: DatabaseSync, draftId: string, revision: number,
  fields: { sceneId: string; sceneRevision: number; title: string; body: string },
) {
  db.prepare(`INSERT INTO story_draft_revisions (draft_id, revision, scene_id, scene_revision, title, body)
    VALUES (?, ?, ?, ?, ?, ?)`).run(draftId, revision, fields.sceneId, fields.sceneRevision, fields.title, fields.body);
}
