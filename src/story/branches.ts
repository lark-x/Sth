import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import { nameKey } from '../library/storage.ts';
import type { Branch, Checkpoint, EventRef, NarrativeRef } from './narrative-contracts.ts';
import { readSceneSummary } from './storage.ts';

export function sceneBranchId(db: DatabaseSync, sceneId: string, isBranchRoot: boolean): string | null {
  if (isBranchRoot) return sceneId;
  const row = db.prepare('SELECT branch_id FROM story_branch_scenes WHERE scene_id = ?').get(sceneId);
  return row ? String(row.branch_id) : null;
}

export function isManagedBranchScene(db: DatabaseSync, sceneId: string) {
  return db.prepare(`SELECT 1 FROM story_branch_scenes WHERE scene_id = ?
    UNION ALL SELECT 1 FROM story_branch_details WHERE branch_id = ? LIMIT 1`).get(sceneId, sceneId) !== undefined;
}

export function attachBranchScene(db: DatabaseSync, branchId: string, sceneId: string) {
  db.prepare('INSERT INTO story_branch_scenes (scene_id, branch_id) VALUES (?, ?)').run(sceneId, branchId);
}

export function registerBranch(db: DatabaseSync, branchId: string, name: string, origin: NarrativeRef | undefined, shared: EventRef[]) {
  db.prepare(`INSERT INTO story_branch_details (branch_id, name, name_key, narrative_id, narrative_revision)
    VALUES (?, ?, ?, ?, ?)`).run(branchId, name, nameKey(name), origin?.narrativeId ?? null, origin?.revision ?? null);
  const insert = db.prepare(`INSERT INTO story_branch_shared_events (branch_id, event_id, event_revision, position)
    VALUES (?, ?, ?, ?)`);
  shared.forEach(({ eventId, revision }, index) => insert.run(branchId, eventId, revision, index + 1));
}

export function isSharedEvent(db: DatabaseSync, branchId: string, event: EventRef) {
  return db.prepare(`SELECT 1 FROM story_branch_shared_events WHERE branch_id = ? AND event_id = ? AND event_revision = ?`)
    .get(branchId, event.eventId, event.revision) !== undefined;
}

export function hasSharedEventId(db: DatabaseSync, branchId: string, eventId: string) {
  return db.prepare('SELECT 1 FROM story_branch_shared_events WHERE branch_id = ? AND event_id = ?')
    .get(branchId, eventId) !== undefined;
}

type BranchRow = {
  branch_id: string;
  name: string;
  origin_scene_id: string;
  origin_scene_revision: number;
  origin_draft_id: string | null;
  origin_draft_revision: number | null;
  divergence: string;
  narrative_id: string | null;
  narrative_revision: number | null;
  revision: number;
  scene_id: string;
  scene_revision: number;
  payload_json: string | null;
};

const branchRows = `SELECT s.scene_id AS branch_id, s.origin_scene_id, s.origin_scene_revision, s.origin_draft_id,
    s.origin_draft_revision, s.divergence, COALESCE(d.name, r.title) AS name, d.narrative_id, d.narrative_revision,
    COALESCE(p.revision, 1) AS revision, COALESCE(p.scene_id, s.scene_id) AS scene_id,
    COALESCE(p.scene_revision, 1) AS scene_revision, p.payload_json
  FROM story_scenes s JOIN story_scene_revisions r ON r.scene_id = s.scene_id AND r.revision = 1
  LEFT JOIN story_branch_details d ON d.branch_id = s.scene_id
  LEFT JOIN story_branch_checkpoints p ON p.branch_id = s.scene_id AND p.revision = COALESCE(?, (
    SELECT MAX(revision) FROM story_branch_checkpoints WHERE branch_id = s.scene_id))
  WHERE s.origin_scene_id IS NOT NULL`;

function toBranchSummary(row: BranchRow) {
  return {
    branchId: row.branch_id, name: row.name, revision: row.revision,
    originSceneId: row.origin_scene_id, originSceneRevision: row.origin_scene_revision,
    latestSceneId: row.scene_id, latestSceneRevision: row.scene_revision, href: branchHref(row.branch_id, row.revision),
  };
}

export function branchHref(branchId: string, revision: number) {
  return `/branches/${branchId}?revision=${revision}`;
}

export function readBranch(db: DatabaseSync, branchId: string, revision?: number): Branch {
  const row = db.prepare(`${branchRows} AND s.scene_id = ?`).get(revision ?? null, branchId) as BranchRow | undefined;
  if (!row) throw new OperationError(404, 'branch_not_found', 'The IF branch was not found.');
  if (revision !== undefined && row.revision !== revision) {
    throw new OperationError(404, 'branch_revision_not_found', 'The IF branch has no checkpoint at that revision.');
  }
  const sharedEvents = row.narrative_id === null ? [] : db.prepare(`SELECT event_id AS eventId, event_revision AS revision
    FROM story_branch_shared_events WHERE branch_id = ? ORDER BY position`).all(branchId).map(row => ({
    eventId: String(row.eventId), revision: Number(row.revision),
  }));
  return {
    ...toBranchSummary(row), divergence: row.divergence, sharedEvents,
    ...(row.origin_draft_id === null ? {} : { originDraft: { draftId: row.origin_draft_id, revision: row.origin_draft_revision! } }),
    ...(row.narrative_id === null ? {} : { originNarrative: { narrativeId: row.narrative_id, revision: row.narrative_revision! } }),
    checkpoint: {
      ...(row.payload_json === null ? { characterStates: [] } : JSON.parse(row.payload_json) as Checkpoint),
      sceneId: row.scene_id, sceneRevision: row.scene_revision,
    },
  };
}

export function listBranches(db: DatabaseSync, filter: { name?: string; originSceneId?: string; limit: number; offset: number }) {
  const name = filter.name === undefined ? null : nameKey(filter.name);
  const origin = filter.originSceneId ?? null;
  const rows = db.prepare(`${branchRows} AND (? IS NULL OR COALESCE(d.name_key, r.title_key) = ?)
    AND (? IS NULL OR s.origin_scene_id = ?) ORDER BY s.rowid DESC LIMIT ? OFFSET ?`)
    .all(null, name, name, origin, origin, filter.limit, filter.offset) as BranchRow[];
  return rows.map(toBranchSummary);
}

export function requireBranchScene(db: DatabaseSync, branchId: string, sceneId: string, revision: number) {
  const scene = readSceneSummary(db, sceneId, revision);
  if ((scene.branchId ?? (scene.branchFrom ? sceneId : null)) !== branchId) {
    throw new OperationError(409, 'branch_scene_mismatch', 'Select a scene that belongs to the specified IF branch.');
  }
}

export function writeCheckpoint(db: DatabaseSync, branchId: string, revision: number, checkpoint: Checkpoint) {
  const { sceneId, sceneRevision, ...payload } = checkpoint;
  db.prepare(`INSERT INTO story_branch_checkpoints (branch_id, revision, scene_id, scene_revision, payload_json) VALUES (?, ?, ?, ?, ?)`)
    .run(branchId, revision, sceneId, sceneRevision, JSON.stringify(payload));
}
