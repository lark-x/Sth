import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import { OperationError } from '../core/index.ts';
import { locateExcerpt } from '../library/reference-range.ts';
import { readJudgment } from '../sources/judgments.ts';
import { validateSourcePin } from '../sources/pins.ts';
import { hasSharedEventId, isSharedEvent, readBranch, sceneBranchId } from './branches.ts';
import type { CharacterPin } from './contracts.ts';
import {
  narrativeProjectionRef, type Event, type EventRef, type EvidencePin, type Narrative, type NarrativeProjectionRef, type ProjectedCheckpoint,
} from './narrative-contracts.ts';
import { assertText, readDraft, readSceneSummary } from './storage.ts';

type EventRow = { event_id: string; branch_id: string | null; revision: number; title: string; summary: string; evidence_json: string };
const eventRows = `SELECT r.*, e.branch_id FROM story_events e JOIN story_event_revisions r USING (event_id)`;

export function eventHref(eventId: string, revision: number) {
  return `/events/${eventId}?revision=${revision}`;
}

export function narrativeHref(narrativeId: string, revision: number) {
  return `/narratives/${narrativeId}?revision=${revision}`;
}

function eventSummary(row: EventRow) {
  return { eventId: row.event_id, revision: row.revision, branchId: row.branch_id, title: row.title,
    href: eventHref(row.event_id, row.revision) };
}

export function readEvent(db: DatabaseSync, eventId: string, revision?: number): Event {
  const row = db.prepare(`${eventRows} WHERE e.event_id = ? AND (? IS NULL OR r.revision = ?)
    ORDER BY r.revision DESC LIMIT 1`).get(eventId, revision ?? null, revision ?? null) as EventRow | undefined;
  if (!row) throw new OperationError(404, revision === undefined ? 'event_not_found' : 'event_revision_not_found',
    'The requested event version was not found.');
  return { ...eventSummary(row), summary: row.summary, evidence: JSON.parse(row.evidence_json) as Event['evidence'] };
}

export function listEvents(db: DatabaseSync, branchId: string | null, limit: number, offset: number) {
  const rows = db.prepare(`${eventRows} WHERE e.branch_id IS ? AND r.revision = (
    SELECT MAX(revision) FROM story_event_revisions WHERE event_id = e.event_id)
    ORDER BY e.rowid DESC LIMIT ? OFFSET ?`).all(branchId, limit, offset) as EventRow[];
  return rows.map(eventSummary);
}

export function linkEvidence(db: DatabaseSync, branchId: string | null, evidence: EvidencePin[]): Event['evidence'] {
  return evidence.map(pin => {
    if (pin.kind === 'source') {
      const { kind, ...ref } = pin;
      return { kind, ...validateSourcePin(db, ref) };
    }
    if (pin.kind === 'judgment') {
      const { href } = readJudgment(db, pin.judgmentId, pin.revision);
      return { ...pin, href };
    }
    assertText(pin.excerpt);
    const draft = readDraft(db, pin.draftId, pin.revision);
    const scene = readSceneSummary(db, draft.sceneId, draft.sceneRevision);
    if (sceneBranchId(db, draft.sceneId, scene.branchFrom !== undefined) !== branchId) {
      throw new OperationError(409, 'event_draft_branch_mismatch', 'Draft evidence must belong to the same branch as the event.');
    }
    locateExcerpt(draft.body, pin.excerpt, pin.range, { mismatch: 'event_draft_excerpt_mismatch' });
    return { ...pin, href: draft.href };
  });
}

function requireOrderScope(db: DatabaseSync, branchId: string | null, event: Event) {
  if (event.branchId !== branchId && (branchId === null || !hasSharedEventId(db, branchId, event.eventId))) {
    throw new OperationError(409, 'event_order_branch_mismatch', 'Use events owned by this branch or shared at its fork.');
  }
}

export function writeEventOrder(db: DatabaseSync, beforeEventId: string, afterEventId: string,
  branchId: string | null | undefined, action: 'add' | 'remove') {
  const before = readEvent(db, beforeEventId);
  const after = readEvent(db, afterEventId);
  const scope = branchId === undefined ? before.branchId : branchId;
  requireOrderScope(db, scope, before);
  requireOrderScope(db, scope, after);
  const relation = { beforeEventId, afterEventId };
  if (action === 'remove') {
    db.prepare('DELETE FROM story_event_order WHERE scope_id = ? AND before_event_id = ? AND after_event_id = ?')
      .run(scope ?? '', beforeEventId, afterEventId);
    return relation;
  }
  const cycle = db.prepare(`WITH RECURSIVE reachable(event_id) AS (
    SELECT ? UNION SELECT e.after_event_id FROM story_event_order e JOIN reachable r ON e.before_event_id = r.event_id
    WHERE e.scope_id = ?
  ) SELECT 1 FROM reachable WHERE event_id = ? LIMIT 1`).get(afterEventId, scope ?? '', beforeEventId);
  if (cycle) throw new OperationError(409, 'event_order_cycle', 'This relation would form a cycle in the event order.');
  db.prepare('INSERT INTO story_event_order VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(scope ?? '', beforeEventId, afterEventId);
  return relation;
}

export function eventRelations(db: DatabaseSync, eventId: string, branchId: string | null | undefined, limit: number, offset: number) {
  const event = readEvent(db, eventId);
  const scope = branchId === undefined ? event.branchId : branchId;
  requireOrderScope(db, scope, event);
  const rows = db.prepare(`SELECT before_event_id, after_event_id FROM story_event_order
    WHERE scope_id = ? AND (before_event_id = ? OR after_event_id = ?)
    ORDER BY before_event_id, after_event_id LIMIT ? OFFSET ?`)
    .all(scope ?? '', eventId, eventId, limit, offset) as { before_event_id: string; after_event_id: string }[];
  return rows.map(row => ({ beforeEventId: row.before_event_id, afterEventId: row.after_event_id }));
}

export function requireEventInBranch(db: DatabaseSync, branchId: string | null, ref: EventRef): Event {
  const event = readEvent(db, ref.eventId, ref.revision);
  if (event.branchId !== branchId && (branchId === null || !isSharedEvent(db, branchId, ref))) {
    throw new OperationError(409, 'narrative_event_branch_mismatch', 'Select events owned by this branch or explicitly inherited at its fork.');
  }
  return event;
}

export function distinctEventIds(events: EventRef[]) {
  if (new Set(events.map(({ eventId }) => eventId)).size !== events.length) {
    throw new OperationError(400, 'narrative_duplicate_event', 'Use each event ID once in an event list.');
  }
}

export function requireCharacterRevision(db: DatabaseSync, { characterId, revision }: CharacterPin) {
  if (!db.prepare('SELECT 1 FROM library_character_revisions WHERE character_id = ? AND revision = ?').get(characterId, revision)) {
    throw new OperationError(404, 'story_character_revision_not_found', 'The specified character version was not found.');
  }
}

type NarrativePayload = Pick<Narrative, 'eventOrder' | 'knownEvents' | 'viewpoint' | 'draft'>;
type NarrativeRow = {
  narrative_id: string; scene_id: string; scene_revision: number; revision: number; title: string; is_branch_root: number;
  member_branch_id: string | null; payload_json: string;
};
const narrativeRows = `SELECT r.*, s.origin_scene_id IS NOT NULL AS is_branch_root, b.branch_id AS member_branch_id
  FROM story_narratives n JOIN story_narrative_revisions r USING (narrative_id)
  JOIN story_scenes s ON s.scene_id = n.scene_id LEFT JOIN story_branch_scenes b ON b.scene_id = n.scene_id`;

function narrativeSummary(row: NarrativeRow) {
  const { narrative_id: narrativeId, revision, scene_id: sceneId, scene_revision: sceneRevision, title } = row;
  return {
    narrativeId, revision, sceneId, sceneRevision, title, branchId: row.is_branch_root ? sceneId : row.member_branch_id,
    href: narrativeHref(narrativeId, revision),
  };
}

export function readNarrative(db: DatabaseSync, narrativeId: string, revision?: number): Narrative {
  const row = db.prepare(`${narrativeRows} WHERE n.narrative_id = ? AND (? IS NULL OR r.revision = ?)
    ORDER BY r.revision DESC LIMIT 1`).get(narrativeId, revision ?? null, revision ?? null) as NarrativeRow | undefined;
  if (!row) throw new OperationError(404, revision === undefined ? 'narrative_not_found' : 'narrative_revision_not_found',
    'The requested telling version was not found.');
  return { ...narrativeSummary(row), ...JSON.parse(row.payload_json) as NarrativePayload };
}

export function listNarratives(db: DatabaseSync, sceneId: string, limit: number, offset: number) {
  readSceneSummary(db, sceneId);
  const rows = db.prepare(`${narrativeRows} WHERE n.scene_id = ? AND r.revision = (
    SELECT MAX(revision) FROM story_narrative_revisions WHERE narrative_id = n.narrative_id)
    ORDER BY n.rowid DESC LIMIT ? OFFSET ?`).all(sceneId, limit, offset) as NarrativeRow[];
  return rows.map(narrativeSummary);
}

function eventKey({ eventId, revision }: EventRef) {
  return `${eventId}:${revision}`;
}

export function validateNarrativeEvents(db: DatabaseSync, branchId: string | null, order: EventRef[], known: EventRef[]) {
  distinctEventIds(order);
  distinctEventIds(known);
  const versions = new Map(order.map(({ eventId, revision }) => [eventId, revision]));
  for (const ref of order) requireEventInBranch(db, branchId, ref);
  for (const ref of known) {
    const orderedRevision = versions.get(ref.eventId);
    if (orderedRevision === undefined) requireEventInBranch(db, branchId, ref);
    else if (orderedRevision !== ref.revision) {
      throw new OperationError(409, 'narrative_event_version_mismatch', 'Use the same event revision in the telling and knowledge lists.');
    }
  }
}

export function sharedEventsAtFork(origin: Narrative, shared: EventRef[]) {
  distinctEventIds(shared);
  const known = new Set(origin.knownEvents.map(eventKey));
  if (shared.some(ref => !known.has(eventKey(ref)))) {
    throw new OperationError(409, 'branch_shared_event_mismatch', 'Share only exact events known in the selected origin telling.');
  }
  return shared;
}

/** Model input. Free-form scene, draft, evidence, and other characters' state stay in author reads. */
export function projectNarrativeForGeneration(db: DatabaseSync, ref: NarrativeProjectionRef) {
  if (!Value.Check(narrativeProjectionRef, ref)) {
    throw new OperationError(400, 'narrative_projection_pin_required', 'Provide an exact narrative revision and branch scope, and an exact checkpoint revision if continuing.');
  }
  const telling = readNarrative(db, ref.narrativeId, ref.revision);
  if (telling.branchId !== ref.branchId) {
    throw new OperationError(409, 'narrative_branch_mismatch', 'The telling belongs to a different branch.');
  }
  const known = new Set(telling.knownEvents.map(eventKey));
  const { narrativeId, revision, branchId, sceneId, sceneRevision, viewpoint } = telling;
  const checkpoint = ref.checkpointRevision === undefined ? undefined : projectCheckpoint(db, telling, ref.checkpointRevision);
  return {
    narrativeId, revision, branchId, sceneId, sceneRevision, viewpoint,
    eventOrder: telling.eventOrder.filter(event => known.has(eventKey(event))),
    knownEvents: telling.knownEvents.map(pin => {
      const { eventId, revision, title, summary } = requireEventInBranch(db, branchId, pin);
      return { eventId, revision, title, summary };
    }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

/** Opt-in continuation context at a saved IF checkpoint. Local state follows character identity across card revisions. */
function projectCheckpoint(db: DatabaseSync, telling: Narrative, checkpointRevision: number): ProjectedCheckpoint {
  if (telling.branchId === null) {
    throw new OperationError(409, 'generation_checkpoint_branch_required', 'Select an IF telling to pin a branch checkpoint.');
  }
  const { branchId, revision, checkpoint } = readBranch(db, telling.branchId, checkpointRevision);
  const selected = checkpoint.narrative;
  if (telling.sceneId !== checkpoint.sceneId || telling.sceneRevision !== checkpoint.sceneRevision
    || selected?.narrativeId !== telling.narrativeId || selected.revision !== telling.revision) {
    throw new OperationError(409, 'generation_checkpoint_telling_mismatch', 'Choose the telling and scene revision saved at this checkpoint.');
  }
  const { viewpoint } = telling;
  const character = viewpoint.kind === 'character'
    ? checkpoint.characterStates.find(pin => pin.characterId === viewpoint.characterId) : undefined;
  if (character === undefined) return { branchId, revision };
  const { characterId, revision: characterRevision, state } = character;
  return { branchId, revision, characterState: { characterId, revision: characterRevision, state } };
}
