import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { connectionsDDL } from '../src/connections.ts';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { openDatabase } from '../src/database.ts';
import { libraryDDL, libraryOperations } from '../src/library/index.ts';
import { sourcesDDL, sourceOperations } from '../src/sources/index.ts';
import {
  projectNarrativeForGeneration, readEvent, readNarrative, storyDDL, storyOperations,
  type Branch, type Event, type Narrative,
} from '../src/story/index.ts';
import type { DraftRef, Scene, SceneSummary } from '../src/story/contracts.ts';
import { sceneDDL } from '../src/story/schema.ts';
import { insertScene, writeSceneRevision } from '../src/story/storage.ts';

function client(db: DatabaseSync, namespace: string) {
  const fixtureOperations = new Set(['character.create', 'character.read', 'character.revise', 'project.create']);
  const core = new Operations(db, [...libraryOperations.filter(({ id }) => fixtureOperations.has(id)), ...sourceOperations, ...storyOperations]);
  let next = 0;
  const invoke = (operationId: string, input: object, stepId = `step-${++next}`) => core.invoke(namespace, { operationId, stepId, input });
  return { invoke, run: <T>(operationId: string, input: object, stepId?: string) => invoke(operationId, input, stepId).result as T };
}

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(operationsDDL + libraryDDL + sourcesDDL + storyDDL);
  return { db, ...client(db, 'narrative-test') };
}

const eventRef = ({ eventId, revision }: Event) => ({ eventId, revision });
const narrativeRef = ({ narrativeId, revision }: Narrative) => ({ narrativeId, revision });
const sceneRef = ({ sceneId, revision }: Scene) => ({ sceneId, sceneRevision: revision });
const problem = (statusCode: number, code: string) => ({ name: 'OperationError', statusCode, code });
const omniscient = { kind: 'omniscient' as const };

function makeSource(run: ReturnType<typeof client>['run']) {
  const body = 'The bell rang. The bell rang. The captain hid the manifest.';
  const { sourceId } = run<{ sourceId: string }>('source.create', { kind: 'setting', title: 'Harbor records', body });
  const excerpt = 'The bell rang.';
  const range = { start: body.lastIndexOf(excerpt), end: body.lastIndexOf(excerpt) + excerpt.length };
  return { sourceId, revision: 1, excerpt, range };
}

test('events retain exact source and judgment evidence, separately from a partial order', t => {
  const { db, run, invoke } = setup(t);
  const pin = makeSource(run);
  const { judgmentId } = run<{ judgmentId: string }>('judgment.create', {
    title: 'Second bell', statement: 'The second bell closed boarding.', evidence: [{ stance: 'support', pin }],
  });
  const eventInput = {
    title: 'The second bell', summary: 'Boarding closes.',
    evidence: [{ kind: 'source', ...pin }, { kind: 'judgment', judgmentId, revision: 1 }],
  };
  const bell = run<Event>('event.save', eventInput, 'bell');
  assert.equal(bell.href, `/events/${bell.eventId}?revision=1`);
  assert.deepEqual(bell.evidence, [
    { kind: 'source', ...pin, href: `/sources/${pin.sourceId}?revision=1` },
    { kind: 'judgment', judgmentId, revision: 1, href: `/judgments/${judgmentId}?revision=1` },
  ]);
  run('source.revise', { sourceId: pin.sourceId, expectedRevision: 1, body: 'A later edition.' });
  run('judgment.revise', { judgmentId, expectedRevision: 1, statement: 'A later interpretation.' });
  assert.throws(() => run('event.save', { ...eventInput, evidence: [{ kind: 'source', ...pin, range: { start: 1, end: 15 } }] }),
    problem(400, 'source_excerpt_mismatch'));
  const original = run<Event>('event.save', { title: 'Missed the ferry', summary: 'The traveller stays onshore.' });
  assert.deepEqual(original.evidence, []);
  const withEvidence = run<Event>('event.save', { ...eventInput, eventId: original.eventId, expectedRevision: 1 });
  const edited = run<Event>('event.save', { eventId: original.eventId, expectedRevision: 2, title: 'Later title', summary: original.summary });
  assert.deepEqual(edited.evidence, withEvidence.evidence);
  assert.deepEqual(run<Event>('event.save', { ...eventInput, eventId: original.eventId, expectedRevision: 3, evidence: [] }).evidence, []);
  const revise = { ...eventInput, eventId: bell.eventId, expectedRevision: 1, summary: 'The boat closes boarding.' };
  const revision = run<Event>('event.save', revise);
  assert.equal(revision.revision, 2);
  assert.equal(run<Event>('event.save', { ...revise, expectedRevision: 2 }).revision, 2);
  assert.throws(() => run('event.save', revise), problem(409, 'event_revision_conflict'));
  assert.deepEqual(run('event.read', eventRef(bell)), bell);
  assert.deepEqual(readEvent(db, bell.eventId), revision);
  const replay = invoke('event.save', eventInput, 'bell');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, bell);

  const arrival = run<Event>('event.save', { ...eventInput, title: 'Arrival on the quay' });
  const departure = run<Event>('event.save', { ...eventInput, title: 'The ferry departs' });
  const rain = run<Event>('event.save', { ...eventInput, title: 'Rain over the harbor' });
  const order = (before: Event, after: Event) => run('event.order', { beforeEventId: before.eventId, afterEventId: after.eventId });
  const toBell = order(arrival, bell);
  const fromBell = order(bell, departure);
  assert.deepEqual(order(bell, departure), fromBell);
  for (const [before, after] of [[bell, bell], [bell, arrival], [departure, arrival]]) {
    assert.throws(() => order(before, after), problem(409, 'event_order_cycle'));
  }
  assert.deepEqual(run('event.relations', { eventId: arrival.eventId }), { items: [toBell] });
  assert.deepEqual(run('event.relations', { eventId: departure.eventId }), { items: [fromBell] });
  assert.deepEqual(run('event.relations', { eventId: rain.eventId }), { items: [] });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('two tellings can reorder shared events while generation sees only exact viewpoint knowledge', t => {
  const { db, run } = setup(t);
  const pin = makeSource(run);
  const character = run<{ characterId: string; revision: number }>('character.create', { name: 'Lin', persona: 'SECRET CHARACTER BIO' });
  const { characterId, revision } = character;
  const viewpoint = { kind: 'character', characterId, revision };
  const scene = run<Scene>('scene.create', { title: 'SECRET SCENE TITLE', sources: [pin], characters: [{ characterId, revision }] });
  const draft = run<DraftRef>('draft.create', { ...sceneRef(scene), title: 'SECRET DRAFT TITLE', body: 'SECRET DRAFT BODY' });
  const { draftId } = draft;
  const saveEvent = (title: string, summary: string) => run<Event>('event.save', {
    title, summary, evidence: [{ kind: 'source', ...pin }],
  });
  const familiar = saveEvent('Quay', 'Lin knows the quay.');
  const bell = saveEvent('Bell', 'Lin hears the bell.');
  const secret = saveEvent('SECRET MANIFEST', 'The captain hid the manifest.');
  const order = [bell, secret].map(eventRef);
  run('event.order', { beforeEventId: secret.eventId, afterEventId: bell.eventId });
  const restricted = {
    ...sceneRef(scene), title: 'SECRET TELLING TITLE', eventOrder: order, viewpoint,
    knownEvents: [familiar, bell].map(eventRef), draft: { draftId, revision: draft.revision },
  };
  const first = run<Narrative>('narrative.save', restricted);
  assert.equal(first.href, `/narratives/${first.narrativeId}?revision=1`);
  const second = run<Narrative>('narrative.save', {
    ...restricted, title: 'The captain’s version', viewpoint: omniscient, eventOrder: [...order].reverse(), knownEvents: order,
  });
  assert.deepEqual(first.eventOrder, order);
  assert.deepEqual(second.eventOrder, [...order].reverse());
  assert.equal(run<{ items: unknown[] }>('narrative.list', { sceneId: scene.sceneId }).items.length, 2);
  assert.deepEqual(run('event.relations', { eventId: bell.eventId }), { items: [{ beforeEventId: secret.eventId, afterEventId: bell.eventId }] });
  const relation = { beforeEventId: secret.eventId, afterEventId: bell.eventId };
  assert.deepEqual(run('event.order', { ...relation, action: 'remove' }), relation);
  assert.deepEqual(run('event.relations', { eventId: bell.eventId }), { items: [] });
  assert.deepEqual(run('narrative.read', narrativeRef(first)), first);

  const revision2 = run<Narrative>('narrative.save', {
    ...restricted, narrativeId: first.narrativeId, expectedRevision: 1, title: 'New telling', knownEvents: [],
  });
  assert.equal(revision2.revision, 2);
  assert.deepEqual(run('narrative.read', narrativeRef(first)), first);
  assert.deepEqual(readNarrative(db, first.narrativeId), revision2);
  assert.throws(() => run('narrative.save', { ...restricted, narrativeId: first.narrativeId, expectedRevision: 1 }),
    problem(409, 'narrative_revision_conflict'));
  assert.throws(() => run('narrative.save', { ...restricted, knownEvents: [eventRef(bell), eventRef(bell)] }),
    problem(400, 'narrative_duplicate_event'));
  assert.throws(() => run('narrative.save', { ...restricted, knownEvents: [{ ...eventRef(bell), revision: 2 }] }),
    problem(409, 'narrative_event_version_mismatch'));

  run('event.save', { eventId: bell.eventId, expectedRevision: 1, title: 'SECRET LATER REVISION', summary: 'Later', evidence: [{ kind: 'source', ...pin }] });
  const projected = projectNarrativeForGeneration(db, { ...narrativeRef(first), branchId: null });
  assert.deepEqual(projected, {
    ...narrativeRef(first), ...sceneRef(scene), branchId: null, viewpoint, eventOrder: [eventRef(bell)],
    knownEvents: [familiar, bell].map(({ eventId, revision, title, summary }) => ({ eventId, revision, title, summary })),
  });
  assert.doesNotMatch(JSON.stringify(projected), /SECRET|manifest|evidence|The bell rang/);
  assert.deepEqual(projectNarrativeForGeneration(db, { ...narrativeRef(revision2), branchId: null }).knownEvents, []);
  assert.throws(() => projectNarrativeForGeneration(db, { ...narrativeRef(first), branchId: 'another-branch' }),
    problem(409, 'narrative_branch_mismatch'));
  assert.throws(() => projectNarrativeForGeneration(db, { ...narrativeRef(first), branchId: null, revision: 0 }),
    problem(400, 'narrative_projection_pin_required'));
});

test('named IF checkpoints survive a database reopen and isolate mainline and sibling IF state', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-narrative-'));
  const file = join(directory, 'sth.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let saved!: Branch;
  let previous!: Branch;
  let ready!: Narrative;
  let ship!: Event;
  let forked!: Event;
  let siblingId!: string;
  let mainId!: string;
  const db = new DatabaseSync(file);
  try {
    db.exec(operationsDDL + libraryDDL + sourcesDDL + storyDDL);
    const { run } = client(db, 'first-session');
    const pin = makeSource(run);
    const { characterId } = run<{ characterId: string }>('character.create', { name: 'Lin', persona: 'Riding the ferry.' });
    const { characterId: otherCharacterId } = run<{ characterId: string }>('character.create', { name: 'Captain' });
    assert.equal(run<{ revision: number }>('character.revise', { characterId, expectedRevision: 1, name: 'Lin at the harbor' }).revision, 2);
    const main = run<Scene>('scene.create', { title: 'Harbor', sources: [pin] });
    mainId = main.sceneId;
    const { projectId } = run<{ projectId: string }>('project.create', { title: 'Harbor' });
    const { chapterId } = run<{ chapterId: string }>('chapter.create', { projectId, title: 'Departure' });
    run('chapter.arrange', { chapterId, expectedRevision: 1, sceneIds: [mainId] });
    const draft = run<DraftRef>('draft.create', { ...sceneRef(main), title: 'Original', body: 'Lin boards.' });
    const event = (title: string) => ({ title, summary: title, evidence: [{ kind: 'source', ...pin }] });
    const bell = run<Event>('event.save', event('The bell rings'));
    const dusk = run<Event>('event.save', event('Dusk at the harbor'));
    ship = run<Event>('event.save', event('MAINLINE Lin boards'));
    const origin = run<Narrative>('narrative.save', {
      ...sceneRef(main), title: 'Original', viewpoint: omniscient, eventOrder: [dusk, bell, ship].map(eventRef), knownEvents: [dusk, bell].map(eventRef),
      draft: { draftId: draft.draftId, revision: draft.revision },
    });
    const forkInput = {
      sceneId: mainId, revision: 1, title: 'After the bell', branchName: 'Missed the ferry',
      divergence: 'Lin misses the ferry.', narrative: narrativeRef(origin),
    };
    assert.throws(() => run('scene.branch', { ...forkInput, sharedEvents: [eventRef(ship)] }), problem(409, 'branch_shared_event_mismatch'));
    const shared = [dusk, bell].map(eventRef);
    const fork = run<Scene>('scene.branch', { ...forkInput, sharedEvents: shared });
    const branchId = fork.sceneId;
    const sibling = run<Scene>('scene.branch', { ...forkInput, branchName: 'Alternate crossing', divergence: 'Lin finds another boat.' });
    siblingId = sibling.sceneId;
    previous = run<Branch>('branch.read', { branchId });
    assert.deepEqual(previous.originNarrative, narrativeRef(origin));
    assert.deepEqual(previous.originDraft, origin.draft);
    assert.deepEqual(previous.sharedEvents, shared);
    assert.equal(previous.href, `/branches/${branchId}?revision=1`);
    assert.deepEqual(fork.sources[0].range, pin.range);
    assert.deepEqual(previous.checkpoint, { ...sceneRef(fork), characterStates: [] });

    const continuation = run<Scene>('scene.create', { branchId, title: 'Waiting on the quay' });
    assert.equal(fork.branchId, branchId);
    assert.equal(run<Scene>('scene.read', { sceneId: continuation.sceneId }).branchId, branchId);
    const next = sceneRef(continuation);
    const continuationDraft = run<DraftRef>('draft.create', { ...next, title: 'Waiting', body: 'Lin stayed on the quay.' });
    const draftPin = { draftId: continuationDraft.draftId, revision: continuationDraft.revision };
    forked = run<Event>('event.save', {
      ...event('Lin waits on the quay'), branchId,
      evidence: [{ kind: 'draft', ...draftPin, excerpt: 'Lin stayed', range: { start: 0, end: 10 } }],
    });
    run<Event>('event.save', { ...event('Later bell'), eventId: bell.eventId, expectedRevision: 1 });
    assert.throws(() => run('event.save', {
      ...event('Cross-branch draft'), branchId: siblingId, evidence: [{ kind: 'draft', ...draftPin, excerpt: 'Lin stayed' }],
    }), problem(409, 'event_draft_branch_mismatch'));
    assert.throws(() => run('event.order', { beforeEventId: ship.eventId, afterEventId: forked.eventId }), problem(409, 'event_order_branch_mismatch'));
    const branchOrder = { beforeEventId: bell.eventId, afterEventId: forked.eventId };
    assert.deepEqual(run('event.order', { ...branchOrder, branchId }), branchOrder);
    assert.deepEqual(run('event.relations', { eventId: bell.eventId, branchId }), { items: [branchOrder] });
    assert.deepEqual(run('event.relations', { eventId: bell.eventId }), { items: [] });
    assert.throws(() => run('event.order', { branchId, beforeEventId: forked.eventId, afterEventId: bell.eventId }),
      problem(409, 'event_order_cycle'));
    assert.throws(() => run('event.order', { ...branchOrder, branchId: siblingId }), problem(409, 'event_order_branch_mismatch'));
    const sharedOrder = { beforeEventId: dusk.eventId, afterEventId: bell.eventId };
    run('event.order', sharedOrder);
    run('event.order', { ...sharedOrder, branchId });
    const viewpoint = { kind: 'character', characterId, revision: 2 };
    const telling = { ...next, title: 'Waiting', viewpoint, eventOrder: [forked, bell].map(eventRef), knownEvents: [forked, bell].map(eventRef) };
    for (const ref of [eventRef(ship), { ...eventRef(bell), revision: 2 }]) {
      assert.throws(() => run('narrative.save', { ...telling, eventOrder: [ref], knownEvents: [ref] }),
        problem(409, 'narrative_event_branch_mismatch'));
    }
    for (const scene of [main, sibling]) {
      assert.throws(() => run('narrative.save', { ...telling, ...sceneRef(scene) }), problem(409, 'narrative_event_branch_mismatch'));
    }
    ready = run<Narrative>('narrative.save', { ...telling, draft: draftPin });
    run('event.order', { ...sharedOrder, action: 'remove' });
    assert.deepEqual(run('event.relations', { eventId: dusk.eventId }), { items: [] });
    assert.deepEqual(run('event.relations', { eventId: dusk.eventId, branchId }), { items: [sharedOrder] });
    run('event.order', sharedOrder);
    run('event.order', { ...sharedOrder, branchId, action: 'remove' });
    assert.deepEqual(run('event.relations', { eventId: dusk.eventId }), { items: [sharedOrder] });
    assert.deepEqual(run('event.relations', { eventId: dusk.eventId, branchId }), { items: [] });
    assert.throws(() => run('event.order', { ...sharedOrder, branchId: siblingId, action: 'remove' }),
      problem(409, 'event_order_branch_mismatch'));
    run('event.order', { ...branchOrder, branchId, action: 'remove' });
    run('event.order', { ...branchOrder, branchId, action: 'remove' });
    run('event.order', { beforeEventId: forked.eventId, afterEventId: bell.eventId, branchId });
    assert.deepEqual(run('narrative.read', narrativeRef(origin)), origin);
    assert.deepEqual(run('narrative.read', narrativeRef(ready)), ready);
    assert.throws(() => run('branch.save', { branchId: siblingId, expectedRevision: 1, ...next }), problem(409, 'branch_scene_mismatch'));
    assert.throws(() => run('branch.save', { branchId, expectedRevision: 1, ...next, narrative: narrativeRef(origin) }),
      problem(409, 'branch_checkpoint_narrative_mismatch'));
    assert.throws(() => run('chapter.arrange', { chapterId, expectedRevision: 2, sceneIds: [mainId, continuation.sceneId] }),
      problem(409, 'chapter_branch_scene'));
    saved = run<Branch>('branch.save', {
      branchId, expectedRevision: 1, ...next, draft: draftPin, narrative: narrativeRef(ready), note: 'Continue when dawn breaks.',
      characterStates: [{ characterId: otherCharacterId, revision: 1, state: 'CAPTAIN PRIVATE' },
        { characterId, revision: 1, state: 'Clothes soaked and still on shore.' }],
    });
    assert.equal(saved.revision, 2);
    assert.equal(run<{ persona: string }>('character.read', { characterId }).persona, 'Riding the ferry.');
  } finally {
    db.close();
  }

  const reopened = new DatabaseSync(file);
  try {
    const { run, invoke } = client(reopened, 'next-session');
    const matches = run<{ items: Branch[] }>('branch.list', { name: ' missed THE ferry ', originSceneId: mainId }).items;
    assert.equal(matches.length, 1);
    assert.equal(matches[0].branchId, saved.branchId);
    assert.equal(matches[0].latestSceneId, saved.checkpoint.sceneId);
    assert.equal(matches[0].href, `/branches/${saved.branchId}?revision=2`);
    assert.deepEqual(run('branch.read', { branchId: saved.branchId }), saved);
    assert.deepEqual(run('branch.read', { branchId: saved.branchId, revision: 1 }), previous);
    assert.deepEqual(run<Branch>('branch.read', { branchId: siblingId }).checkpoint.characterStates, []);
    assert.deepEqual(run<{ items: Event[] }>('event.list', { branchId: saved.branchId }).items.map(eventRef), [eventRef(forked)]);
    assert.ok(run<{ items: Event[] }>('event.list', {}).items.some(({ eventId }) => eventId === ship.eventId));
    assert.deepEqual(run<{ items: SceneSummary[] }>('scene.list', { branchId: null }).items.map(({ sceneId }) => sceneId), [mainId]);
    assert.deepEqual(new Set(run<{ items: SceneSummary[] }>('scene.list', { branchId: saved.branchId }).items.map(({ sceneId }) => sceneId)),
      new Set([saved.branchId, saved.checkpoint.sceneId]));

    const resume = { branchId: saved.branchId, expectedRevision: saved.revision, ...saved.checkpoint, note: 'Resume at sunrise.' };
    const third = run<Branch>('branch.save', resume, 'resume');
    assert.equal(third.revision, 3);
    assert.deepEqual(invoke('branch.save', resume, 'resume'), { operationId: 'branch.save', stepId: 'resume', result: third, replayed: true });
    assert.throws(() => run('branch.save', resume), problem(409, 'branch_revision_conflict'));
    const { characterStates, ...position } = third.checkpoint;
    const carried = run<Branch>('branch.save', { ...position, branchId: third.branchId, expectedRevision: 3, note: 'Keep writing.' });
    assert.deepEqual(carried.checkpoint.characterStates, characterStates);
    const projected = projectNarrativeForGeneration(reopened, { ...narrativeRef(ready), branchId: saved.branchId });
    assert.deepEqual(projected.eventOrder, ready.eventOrder);
    assert.doesNotMatch(JSON.stringify(projected), /MAINLINE|manifest|soaked|sunrise/);
    for (const branchId of [null, siblingId]) {
      assert.throws(() => projectNarrativeForGeneration(reopened, { ...narrativeRef(ready), branchId }), problem(409, 'narrative_branch_mismatch'));
    }
    const storyPin = { ...narrativeRef(ready), branchId: saved.branchId };
    const local = projectNarrativeForGeneration(reopened, { ...storyPin, checkpointRevision: saved.revision }).checkpoint;
    assert.deepEqual(local, { branchId: saved.branchId, revision: saved.revision, characterState: saved.checkpoint.characterStates[1] });
    assert.doesNotMatch(JSON.stringify(local), /CAPTAIN PRIVATE|dawn|sunrise/);
    assert.throws(() => projectNarrativeForGeneration(reopened, { ...storyPin, branchId: siblingId, checkpointRevision: 1 }),
      problem(409, 'narrative_branch_mismatch'));
    assert.throws(() => projectNarrativeForGeneration(reopened, { ...storyPin, checkpointRevision: 1 }),
      problem(409, 'generation_checkpoint_telling_mismatch'));
    const unbound = run<Branch>('branch.save', { sceneId: ready.sceneId, sceneRevision: ready.sceneRevision,
      branchId: saved.branchId, expectedRevision: carried.revision, note: 'This checkpoint has no telling.' });
    assert.throws(() => projectNarrativeForGeneration(reopened, { ...storyPin, checkpointRevision: unbound.revision }),
      problem(409, 'generation_checkpoint_telling_mismatch'));
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    reopened.close();
  }
});

test('workspace v3 opens with the additive story schema, legacy IF scenes and receipt replay', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-narrative-v3-'));
  let upgraded: DatabaseSync | undefined;
  t.after(() => {
    upgraded?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const old = new DatabaseSync(join(directory, 'sth.sqlite'));
  const originalInput = { kind: 'setting', title: 'Old source', body: 'An original source.' };
  let original: unknown;
  try {
    old.exec(operationsDDL + libraryDDL + sourcesDDL + sceneDDL + connectionsDDL);
    old.exec('PRAGMA application_id=0x53746831; PRAGMA user_version=3');
    insertScene(old, 'main');
    writeSceneRevision(old, 'main', 1, { title: 'Original scene', characters: [], sources: [] });
    insertScene(old, 'fork', { sceneId: 'main', revision: 1, divergence: 'Older IF' });
    writeSceneRevision(old, 'fork', 1, { title: 'Older branch', characters: [], sources: [] });
    original = client(old, 'legacy').run('source.create', originalInput, 'original');
  } finally {
    old.close();
  }
  const db = upgraded = openDatabase(directory);
  const { run, invoke } = client(db, 'legacy');
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
  const main = run<Scene>('scene.read', { sceneId: 'main' });
  const fork = run<Scene>('scene.read', { sceneId: 'fork' });
  assert.equal(main.title, 'Original scene');
  assert.deepEqual(fork.branchFrom, { sceneId: main.sceneId, revision: 1, divergence: 'Older IF' });
  assert.equal(run<Branch>('branch.read', { branchId: fork.sceneId }).name, fork.title);
  assert.deepEqual(run('narrative.list', { sceneId: main.sceneId }), { items: [] });
  assert.deepEqual(run('event.list', {}), { items: [] });
  const saved = run<Branch>('branch.save', { branchId: fork.sceneId, expectedRevision: 1, ...sceneRef(fork), note: 'Resume here.' });
  assert.equal(saved.revision, 2);
  const replay = invoke('source.create', originalInput, 'original');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, original);
  assert.deepEqual(run('scene.read', { sceneId: main.sceneId }), main);
  assert.deepEqual(run('scene.read', { sceneId: fork.sceneId }), fork);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
