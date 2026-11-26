import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Type } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { listBranches, readBranch, requireBranchScene, sceneBranchId, writeCheckpoint } from './branches.ts';
import { defaultLimit, id, itemList, pagination, resultLink, revision, strict, title } from './contracts.ts';
import {
  branch, branchScope, branchSummary, characterStates, checkpointFields, event, eventFields, eventOrderAction, eventRelation,
  eventSummary, narrative, narrativeFields, narrativeSummary,
} from './narrative-contracts.ts';
import {
  eventHref, eventRelations, linkEvidence, listEvents, listNarratives, readEvent, readNarrative, requireCharacterRevision,
  validateNarrativeEvents, writeEventOrder,
} from './narrative-storage.ts';
import { assertText, readSceneDraft, readSceneSummary, requireRevision } from './storage.ts';

const exactOrLatest = Type.Optional(revision);
const scope = Type.Optional(branchScope);
const eventId = { eventId: id };
const narrativeId = { narrativeId: id };
const branchId = { branchId: id };

function requireSaveIdentity(resourceId?: string, expectedRevision?: number) {
  if ((resourceId === undefined) !== (expectedRevision === undefined)) {
    throw new OperationError(400, 'story_save_revision_required', 'Supply both the resource ID and expectedRevision when saving a revision.');
  }
}

export const narrativeOperations = [
  defineOperation({
    id: 'event.save', effect: 'write',
    description: 'Save an event with a title and summary. Evidence is optional for original fiction and RP. Pin excerpts or judgments when using sources. On revision, omitted evidence is preserved and an empty array clears it. Supply eventId and expectedRevision to revise. Branch ownership is fixed. Null or omitted branchId creates a mainline event.',
    interaction: { resultLink },
    inputSchema: Type.Object({ eventId: Type.Optional(id), expectedRevision: exactOrLatest, branchId: scope, ...eventFields }, strict),
    outputSchema: event,
    run(input, { db }) {
      const { eventId, expectedRevision, title, summary } = input;
      assertText(title, summary);
      requireSaveIdentity(eventId, expectedRevision);
      const current = eventId === undefined ? undefined : readEvent(db, eventId);
      if (current) {
        requireRevision('event', current.revision, expectedRevision!);
        if (input.branchId !== undefined && input.branchId !== current.branchId) {
          throw new OperationError(409, 'event_branch_mismatch', 'Event branch ownership is fixed.');
        }
      }
      const branchId = current ? current.branchId : input.branchId ?? null;
      if (branchId !== null) readBranch(db, branchId);
      const evidence = input.evidence === undefined ? current?.evidence ?? [] : linkEvidence(db, branchId, input.evidence);
      const fields = { title: title.trim(), summary: summary.trim(), evidence };
      if (current && current.title === fields.title && current.summary === fields.summary
        && isDeepStrictEqual(current.evidence, fields.evidence)) return current;
      const savedId = eventId ?? randomUUID();
      if (!current) db.prepare('INSERT INTO story_events (event_id, branch_id) VALUES (?, ?)').run(savedId, branchId);
      const revision = (current?.revision ?? 0) + 1;
      db.prepare(`INSERT INTO story_event_revisions (event_id, revision, title, summary, evidence_json) VALUES (?, ?, ?, ?, ?)`)
        .run(savedId, revision, fields.title, fields.summary, JSON.stringify(fields.evidence));
      return { eventId: savedId, revision, branchId, href: eventHref(savedId, revision), ...fields };
    },
  }),
  defineOperation({
    id: 'event.read', effect: 'read', description: 'Read an event and pinned evidence at its latest or specified revision. For direct ordering relations, use event.relations.',
    interaction: { resultLink },
    inputSchema: Type.Object({ ...eventId, revision: exactOrLatest }, strict), outputSchema: event,
    run: ({ eventId, revision }, { db }) => readEvent(db, eventId, revision),
  }),
  defineOperation({
    id: 'event.list', effect: 'read', description: 'List latest events owned by the selected IF branch. Omit branchId or pass null for mainline events. Use branch.read for explicitly shared event versions.',
    inputSchema: Type.Object({ branchId: scope, ...pagination }, strict), outputSchema: itemList(eventSummary),
    run({ branchId = null, limit = defaultLimit, offset = 0 }, { db }) {
      if (branchId !== null) readBranch(db, branchId);
      return { items: listEvents(db, branchId, limit, offset) };
    },
  }),
  defineOperation({
    id: 'event.order', effect: 'write', description: 'Add or remove a direct before/after relation using action (default add). By default use the branch of the first event. Specify branchId to correct an IF relation involving events shared at its fork. Adding a cycle is rejected.',
    inputSchema: Type.Object({ ...eventRelation.properties, branchId: scope, action: Type.Optional(eventOrderAction) }, strict), outputSchema: eventRelation,
    run: ({ beforeEventId, afterEventId, branchId, action = 'add' }, { db }) => writeEventOrder(db, beforeEventId, afterEventId, branchId, action),
  }),
  defineOperation({
    id: 'event.relations', effect: 'read', description: 'List explicitly recorded before/after relations for an event. Omit branchId for the owning branch, or specify the IF branch in which the event is shared.',
    inputSchema: Type.Object({ ...eventId, branchId: scope, ...pagination }, strict), outputSchema: itemList(eventRelation),
    run: ({ eventId, branchId, limit = defaultLimit, offset = 0 }, { db }) => ({ items: eventRelations(db, eventId, branchId, limit, offset) }),
  }),
  defineOperation({
    id: 'narrative.save', effect: 'write',
    description: 'Create a telling for an exact scene version, or replace its full snapshot using narrativeId and expectedRevision. eventOrder controls presentation. knownEvents explicitly permits exact event versions for the selected viewpoint, including earlier knowledge outside the telling. Provide draft to link a same-scene version.',
    interaction: { resultLink },
    inputSchema: Type.Object({ ...narrativeFields, narrativeId: Type.Optional(id), expectedRevision: exactOrLatest }, strict), outputSchema: narrative,
    run({ narrativeId, expectedRevision, sceneId, sceneRevision, title, ...payload }, { db }) {
      assertText(title);
      requireSaveIdentity(narrativeId, expectedRevision);
      const current = narrativeId === undefined ? undefined : readNarrative(db, narrativeId);
      if (current) {
        requireRevision('narrative', current.revision, expectedRevision!);
        if (current.sceneId !== sceneId) {
          throw new OperationError(409, 'narrative_scene_mismatch', 'A telling belongs to one scene.');
        }
      }
      const scene = readSceneSummary(db, sceneId, sceneRevision);
      const branchId = sceneBranchId(db, sceneId, scene.branchFrom !== undefined);
      if (payload.draft) readSceneDraft(db, sceneId, payload.draft);
      if (payload.viewpoint.kind === 'character') requireCharacterRevision(db, payload.viewpoint);
      validateNarrativeEvents(db, branchId, payload.eventOrder, payload.knownEvents);
      const cleanedTitle = title.trim();
      if (current && current.sceneRevision === sceneRevision && current.title === cleanedTitle && isDeepStrictEqual(payload, {
        eventOrder: current.eventOrder, knownEvents: current.knownEvents, viewpoint: current.viewpoint,
        ...(current.draft === undefined ? {} : { draft: current.draft }),
      })) return current;
      const savedId = narrativeId ?? randomUUID();
      if (!current) db.prepare('INSERT INTO story_narratives (narrative_id, scene_id) VALUES (?, ?)').run(savedId, sceneId);
      const revision = (current?.revision ?? 0) + 1;
      db.prepare(`INSERT INTO story_narrative_revisions (narrative_id, revision, scene_id, scene_revision, title, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(savedId, revision, sceneId, sceneRevision, cleanedTitle, JSON.stringify(payload));
      return readNarrative(db, savedId, revision);
    },
  }),
  defineOperation({
    id: 'narrative.read', effect: 'read', description: 'Read the author-facing telling at its latest or specified revision, with exact event order, viewpoint, knowledge, and any pinned draft.',
    interaction: { resultLink },
    inputSchema: Type.Object({ ...narrativeId, revision: exactOrLatest }, strict), outputSchema: narrative,
    run: ({ narrativeId, revision }, { db }) => readNarrative(db, narrativeId, revision),
  }),
  defineOperation({
    id: 'narrative.list', effect: 'read', description: 'List the latest version of each telling for a scene. Use narrative.read to retrieve a full version.',
    inputSchema: Type.Object({ sceneId: id, ...pagination }, strict), outputSchema: itemList(narrativeSummary),
    run: ({ sceneId, limit = defaultLimit, offset = 0 }, { db }) => ({ items: listNarratives(db, sceneId, limit, offset) }),
  }),
  defineOperation({
    id: 'branch.list', effect: 'read', description: 'Find IF branches by exact name or originSceneId, newest first. Results link to the latest checkpoint on the branch detail page.',
    inputSchema: Type.Object({ name: Type.Optional(title), originSceneId: Type.Optional(id), ...pagination }, strict),
    outputSchema: itemList(branchSummary),
    run({ name, originSceneId, limit = defaultLimit, offset = 0 }, { db }) {
      assertText(name);
      return { items: listBranches(db, { name, originSceneId, limit, offset }) };
    },
  }),
  defineOperation({
    id: 'branch.read', effect: 'read', description: 'Read an IF branch at its latest or specified checkpoint revision, with exact origin, shared knowledge, resume scene, and branch-local character states.',
    interaction: { resultLink: { hrefField: 'href', labelField: 'name' } },
    inputSchema: Type.Object({ ...branchId, revision: exactOrLatest }, strict), outputSchema: branch,
    run: ({ branchId, revision }, { db }) => readBranch(db, branchId, revision),
  }),
  defineOperation({
    id: 'branch.save', effect: 'write',
    description: 'Save a checkpoint in an IF branch using its current expectedRevision. Pin a scene in that branch, and optionally a telling, draft, and note. Omit characterStates to carry forward local states, or pass an array to replace them. Use scene.create with branchId to add a continuation scene.',
    interaction: { resultLink: { hrefField: 'href', labelField: 'name' } },
    inputSchema: Type.Object({ ...branchId, expectedRevision: revision, ...checkpointFields, characterStates: Type.Optional(characterStates) }, strict),
    outputSchema: branch,
    run({ branchId, expectedRevision, characterStates, ...position }, { db }) {
      const current = readBranch(db, branchId);
      requireRevision('branch', current.revision, expectedRevision);
      assertText(position.note, ...(characterStates ?? []).map(({ state }) => state));
      requireBranchScene(db, branchId, position.sceneId, position.sceneRevision);
      if (position.draft) readSceneDraft(db, position.sceneId, position.draft);
      if (position.narrative) {
        const selected = readNarrative(db, position.narrative.narrativeId, position.narrative.revision);
        if (selected.branchId !== branchId || selected.sceneId !== position.sceneId || selected.sceneRevision !== position.sceneRevision) {
          throw new OperationError(409, 'branch_checkpoint_narrative_mismatch', 'Select a telling for the exact checkpoint scene version.');
        }
      }
      if (characterStates) {
        if (new Set(characterStates.map(({ characterId }) => characterId)).size !== characterStates.length) {
          throw new OperationError(400, 'branch_duplicate_character', 'Include one local state per character.');
        }
        for (const pin of characterStates) requireCharacterRevision(db, pin);
      }
      const next = { ...position, characterStates: characterStates ?? current.checkpoint.characterStates };
      if (isDeepStrictEqual(next, current.checkpoint)) return current;
      writeCheckpoint(db, branchId, current.revision + 1, next);
      return readBranch(db, branchId);
    },
  }),
];
