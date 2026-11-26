import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { assetsDDL } from '../src/assets/index.ts';
import { Operations, operationsDDL } from '../src/core/index.ts';
import type { Generation, PromptInspection } from '../src/generation/contracts.ts';
import { generationDDL, generationOperations } from '../src/generation/index.ts';
import type { CharacterEntry } from '../src/library/character-contracts.ts';
import { libraryDDL, libraryOperations } from '../src/library/index.ts';
import { sourcesDDL, sourceOperations } from '../src/sources/index.ts';
import type { Judgment } from '../src/sources/judgments.ts';
import type { Scene } from '../src/story/contracts.ts';
import { storyDDL, storyOperations, type Branch, type Event, type Narrative } from '../src/story/index.ts';

type Character = { characterId: string; revision: number; description?: string; entries: CharacterEntry[] };
type Source = { sourceId: string; revision: number; body: string; href: string };
type Draft = { draftId: string; revision: number; body: string; href: string };

const brief = { title: 'Harbor', brief: 'Write the selected telling.', templateId: 'short-story' };

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON; ${operationsDDL}${assetsDDL}${libraryDDL}${sourcesDDL}${storyDDL}${generationDDL}`);
  const ops = new Operations(db, [...libraryOperations, ...sourceOperations, ...storyOperations, ...generationOperations]);
  let step = 0;
  function call<T>(operationId: string, input: unknown, stepId = `step-${++step}`): T {
    return ops.invoke('owner:research', { operationId, stepId, input }).result as T;
  }
  function source(title: string, body: string) {
    return call<Source>('source.create', { title, body, kind: 'excerpt' });
  }
  function draft(scene: Scene, title: string, body: string) {
    return call<Draft>('draft.create', { sceneId: scene.sceneId, sceneRevision: scene.revision, title, body });
  }
  function inspect(generation: Generation) {
    return call<PromptInspection>('generations.prompt', { generationId: generation.generationId });
  }
  return { call, db, source, draft, inspect };
}

function range(body: string, excerpt: string, fromEnd = false) {
  const start = fromEnd ? body.lastIndexOf(excerpt) : body.indexOf(excerpt);
  assert.ok(start >= 0);
  return { start, end: start + excerpt.length };
}

function span(trace: PromptInspection, path: string) {
  const row = trace.provenance.find(item => item.path === path);
  assert.ok(row && row.start !== undefined && row.end !== undefined, path);
  const part = trace.messages[row.messageIndex].parts[row.partIndex];
  assert.equal(part.type, 'text');
  return { row, value: JSON.parse(part.text.slice(row.start, row.end)) };
}

function eventRef(event: Event) { return { eventId: event.eventId, revision: event.revision }; }
function storyRef({ narrativeId, revision, branchId }: Narrative) { return { narrativeId, revision, branchId }; }

test('adoption appends selected passages and judgment, keeps exact repeated UTF-16 positions and is idempotent', t => {
  const { call, source, draft, inspect } = setup(t);
  const excerpt = '"Wait" \u{1f6a2}';
  const original = source('Logbook', `${excerpt}\nUnselected.\n${excerpt}`);
  const originalRange = range(original.body, excerpt, true);
  const pin = { sourceId: original.sourceId, revision: 1, excerpt, range: originalRange };
  const judgment = call<Judgment>('judgment.create', {
    title: 'Possible hesitation', statement: 'She hesitated before leaving.', evidence: [{ stance: 'support', pin }],
  });
  const scene = call<Scene>('scene.create', { title: 'Harbor' });
  const manuscript = draft(scene, 'First', `${excerpt} Then she stepped back.`);
  const character = call<Character>('character.create', { name: 'Lin', description: 'Original', entries: [
    { entryId: 'existing', label: 'Original entry', blocks: [{ type: 'text', text: 'Keep this.' }] },
  ] });
  call('character.revise', { characterId: character.characterId, expectedRevision: 1, description: 'Concurrent edit' });
  const entries = [
    { label: 'Logbook quote', references: [{ kind: 'source', id: original.sourceId, revision: 1, location: originalRange }] },
    { label: 'Manuscript quote', references: [{ kind: 'draft', id: manuscript.draftId, revision: 1, excerpt }] },
    { label: 'Inference', text: 'Use for the harbor scene.', references: [{ kind: 'judgment', id: judgment.judgmentId, revision: 1 }] },
  ];
  assert.throws(() => call('character.adopt-entries', { characterId: character.characterId, entries: [
    { label: 'Ambiguous', references: [{ kind: 'source', id: original.sourceId, revision: 1, excerpt }] },
  ] }), { code: 'reference_range_required' });
  const input = { characterId: character.characterId, entries };
  assert.throws(() => call('character.adopt-entries', { ...input, expectedRevision: 1 }), { code: 'character_revision_conflict' });
  const updated = call<Character>('character.adopt-entries', input, 'adopt');
  assert.equal(updated.revision, 3);
  assert.equal(updated.description, 'Concurrent edit');
  assert.deepEqual(updated.entries[0], character.entries[0]);
  assert.deepEqual(updated.entries.slice(1).map(entry => entry.label), ['Logbook quote', 'Manuscript quote', 'Inference']);
  assert.deepEqual(updated.entries[1].blocks, [{ type: 'reference', kind: 'source', id: original.sourceId, revision: 1,
    excerpt, range: originalRange }]);
  assert.deepEqual(updated.entries[2].blocks[0], { type: 'reference', kind: 'draft', id: manuscript.draftId, revision: 1,
    excerpt, range: range(manuscript.body, excerpt) });
  assert.deepEqual(updated.entries[3].blocks[1], { type: 'reference', kind: 'judgment', id: judgment.judgmentId, revision: 1,
    excerpt: judgment.statement, range: { start: 0, end: judgment.statement.length } });
  assert.deepEqual(call('character.adopt-entries', input, 'adopt'), updated);
  assert.deepEqual(call('character.adopt-entries', { ...input, expectedRevision: 2 }), updated);
  const links = call<{ items: { entryId: string; reference: unknown }[] }>('character.backlinks', {
    kind: 'judgment', id: judgment.judgmentId, revision: 1,
  });
  assert.deepEqual(links.items.map(link => link.reference), [updated.entries[3].blocks[1]]);
  const generation = call<Generation>('generations.prepare', { ...brief, references: [{
    kind: 'character', id: character.characterId, revision: 3, includeDescription: false, entryIds: [updated.entries[1].entryId],
  }] });
  const trace = inspect(generation);
  assert.doesNotMatch(JSON.stringify(trace.messages), /Concurrent edit|Unselected|Manuscript quote|Inference/);
  const quote = span(trace, '/references/0/content/entries/0/blocks/0/excerpt');
  assert.equal(quote.value, excerpt);
  assert.deepEqual(quote.row.target?.range, originalRange);
  assert.equal(quote.row.blockIndex, 0);
});

test('adoption rejects mismatches and surrogate splits, and a failed receipt rolls back the append', t => {
  const { call, db, source } = setup(t);
  const original = source('Signal', 'A\u{1f6a2}B');
  const character = call<Character>('character.create', { name: 'Lin' });
  const input = (start: number, end: number, excerpt?: string) => ({ characterId: character.characterId, entries: [
    { label: 'Signal', references: [{ kind: 'source', id: original.sourceId, revision: 1, range: { start, end },
      ...(excerpt ? { excerpt } : {}) }] },
  ] });
  assert.throws(() => call('character.adopt-entries', input(2, 3)), { code: 'source_range_invalid' });
  assert.throws(() => call('character.adopt-entries', input(1, 3, 'A')), { code: 'source_excerpt_mismatch' });
  db.exec(`CREATE TRIGGER reject_adoption BEFORE INSERT ON operation_receipts WHEN NEW.step_id = 'adopt-retry'
    BEGIN SELECT RAISE(ABORT, 'test failed receipt'); END;`);
  assert.throws(() => call('character.adopt-entries', input(1, 3), 'adopt-retry'), /test failed receipt/);
  assert.deepEqual(call('character.read', { characterId: character.characterId }), character);
  db.exec('DROP TRIGGER reject_adoption');
  assert.equal(call<Character>('character.adopt-entries', input(1, 3), 'adopt-retry').revision, 2);
});

test('generation and delegation pin judgment stances, exact source occurrences and event evidence provenance', t => {
  const { call, source, draft, inspect } = setup(t);
  const excerpt = '"Same" \u{1f6a2}';
  const original = source('Signal', `${excerpt}\n${excerpt}`);
  const first = range(original.body, excerpt);
  const second = range(original.body, excerpt, true);
  const sourcePin = { kind: 'source', sourceId: original.sourceId, revision: 1, excerpt, range: second };
  const judgment = call<Judgment>('judgment.create', {
    title: 'Harbor inference', statement: 'The signal came from shore.', scope: 'Only the first voyage.', evidence: [
      { stance: 'support', pin: { sourceId: original.sourceId, revision: 1, excerpt, range: first } },
      { stance: 'counter', pin: { sourceId: original.sourceId, revision: 1, excerpt, range: second } },
    ],
  });
  const scene = call<Scene>('scene.create', { title: 'A scene' });
  const manuscript = draft(scene, 'Author draft', 'According to the witness. Other material.');
  const event = call<Event>('event.save', { title: 'A signal', summary: 'A signal was repeated.', evidence: [
    sourcePin, { kind: 'judgment', judgmentId: judgment.judgmentId, revision: 1 },
    { kind: 'draft', draftId: manuscript.draftId, revision: 1, excerpt: 'According to the witness.' },
  ] });
  const generation = call<Generation>('generations.prepare', { ...brief, references: [
    { kind: 'judgment', id: judgment.judgmentId, revision: 1 }, { kind: 'event', id: event.eventId, revision: 1 },
    { kind: 'source', id: original.sourceId, revision: 1, range: first },
    { kind: 'source', id: original.sourceId, revision: 1, range: second },
  ] });
  const trace = inspect(generation);
  for (const [index, stance, expected] of [[0, 'support', first], [1, 'counter', second]] as const) {
    const path = `/references/0/content/evidence/${index}`;
    assert.equal(span(trace, `${path}/stance`).value, stance);
    const { row, value } = span(trace, `${path}/pin/excerpt`);
    assert.equal(value, excerpt);
    assert.deepEqual(row.target, { kind: 'source', id: original.sourceId, revision: 1, href: original.href, range: expected });
  }
  assert.equal(span(trace, '/references/0/content/scope').value, 'Only the first voyage.');
  assert.equal(span(trace, '/references/1/content/evidence/1').row.target?.id, judgment.judgmentId);
  assert.deepEqual(span(trace, '/references/1/content/evidence/2/excerpt').row.target?.range, { start: 0, end: 25 });
  assert.deepEqual(span(trace, '/references/2/content/body').row.target?.range, first);
  assert.deepEqual(span(trace, '/references/3/content/body').row.target?.range, second);
  assert.doesNotMatch(JSON.stringify(trace.messages), /Other material/);
  call('source.revise', { sourceId: original.sourceId, expectedRevision: 1, body: 'New source' });
  call('judgment.revise', { judgmentId: judgment.judgmentId, expectedRevision: 1, statement: 'New judgment' });
  const { planId } = call<{ planId: string }>('generation.plans.create', {
    title: 'A plan', executor: 'openai-compatible', provider: 'local', model: 'fixture-model', parameters: {},
  });
  const delegated = inspect(call<Generation>('generations.start', { generationId: generation.generationId, planId }));
  assert.deepEqual(delegated.messages, trace.messages);
  assert.deepEqual(delegated.provenance, trace.provenance);
  assert.deepEqual(inspect(generation), trace);
});

test('restricted tellings use only projected event revisions and keep hidden data out of records and provenance', t => {
  const { call, db, source, draft, inspect } = setup(t);
  const original = source('Hidden source title', 'HIDDEN_SOURCE');
  const scene = call<Scene>('scene.create', { title: 'HIDDEN_SCENE' });
  const manuscript = draft(scene, 'HIDDEN_DRAFT', 'HIDDEN_DRAFT_BODY');
  const character = call<Character>('character.create', { name: 'Lin', description: 'HIDDEN_PERSONA' });
  function event(title: string, summary: string) {
    return call<Event>('event.save', { title, summary, evidence: [
      { kind: 'source', sourceId: original.sourceId, revision: 1, excerpt: original.body },
    ] });
  }
  const visible = event('Lantern', 'Lin saw the lantern.');
  const second = event('Door', 'Lin heard the door.');
  const hidden = event('HIDDEN_EVENT_TITLE', 'HIDDEN_EVENT_SUMMARY');
  const narrative = call<Narrative>('narrative.save', {
    sceneId: scene.sceneId, sceneRevision: 1, title: 'HIDDEN_TELLING_TITLE', draft: { draftId: manuscript.draftId, revision: 1 },
    viewpoint: { kind: 'character', characterId: character.characterId, revision: 1 },
    eventOrder: [second, hidden, visible].map(eventRef), knownEvents: [visible, second].map(eventRef),
  });
  const prepared = call<Generation>('generations.prepare', { ...brief, story: storyRef(narrative), references: [
    { kind: 'event', id: visible.eventId, revision: 1 },
  ] });
  assert.deepEqual(prepared.composition.story?.eventOrder, [second, visible].map(eventRef));
  const trace = inspect(prepared);
  const system = trace.messages[0].parts[0];
  assert.ok(system.type === 'text' && system.text.includes('write only what that character can know'));
  assert.equal(span(trace, '/story/knownEvents/0/summary').value, visible.summary);
  assert.equal(span(trace, '/story/knownEvents/0/summary').row.target?.id, visible.eventId);
  assert.equal(span(trace, '/story/eventOrder/0').row.target?.id, second.eventId);
  assert.equal(span(trace, '/story/viewpoint').row.target?.id, character.characterId);
  assert.equal(span(trace, '/story').row.target?.href, narrative.href);
  for (const result of [prepared, trace]) {
    assert.doesNotMatch(JSON.stringify(result), /HIDDEN|evidence/);
    assert.ok(!JSON.stringify(result).includes(hidden.eventId));
  }
  const reference = (kind: string, id: string, revision = 1) => ({ ...brief, story: storyRef(narrative), references: [{ kind, id, revision }] });
  for (const [kind, id] of [['source', original.sourceId], ['scene', scene.sceneId], ['draft', manuscript.draftId],
    ['character', character.characterId], ['judgment', 'forbidden-judgment']]) {
    assert.throws(() => call('generations.prepare', reference(kind, id)), { code: 'generation_viewpoint_reference_forbidden' });
  }
  assert.throws(() => call('generations.prepare', reference('event', hidden.eventId)), { code: 'generation_event_not_visible' });
  assert.throws(() => call('generations.prepare', reference('event', visible.eventId, 2)), { code: 'generation_event_not_visible' });
  assert.equal(db.prepare('SELECT count(*) AS count FROM generation_records').get()?.count, 1);
});

test('IF generation rejects sibling references, including unselected citations in selected character entries', t => {
  const { call, source, draft, inspect } = setup(t);
  const original = source('Harbor log', 'Shared bell. MAINLINE_ONLY.');
  const main = call<Scene>('scene.create', { title: 'Main scene' });
  const mainDraft = draft(main, 'Canon', 'ORIGIN_DRAFT_SECRET');
  const evidence = { kind: 'source', sourceId: original.sourceId, revision: 1,
    excerpt: 'Shared bell.', range: { start: 0, end: 12 } };
  const shared = call<Event>('event.save', { title: 'The bell', summary: 'The bell rang.', evidence: [
    { kind: 'draft', draftId: mainDraft.draftId, revision: 1, excerpt: mainDraft.body }, evidence,
  ] });
  const telling = (scene: Scene, events: Event[]) => call<Narrative>('narrative.save', { sceneId: scene.sceneId,
    sceneRevision: scene.revision, title: 'Telling', viewpoint: { kind: 'omniscient' },
    eventOrder: events.map(eventRef), knownEvents: events.map(eventRef) });
  const origin = telling(main, [shared]);
  function fork(divergence: string) {
    return call<Scene>('scene.branch', { sceneId: main.sceneId, revision: 1, divergence,
      draft: { draftId: mainDraft.draftId, revision: 1 }, narrative: { narrativeId: origin.narrativeId, revision: 1 },
      sharedEvents: [eventRef(shared)] });
  }
  const left = fork('LEFT_ORIGIN_NOTE');
  const right = fork('RIGHT_ORIGIN_NOTE');
  const siblingDraft = draft(right, 'Sibling', 'SIBLING_DRAFT_SECRET');
  const siblingEvent = call<Event>('event.save', { branchId: right.sceneId, title: 'Sibling', summary: 'SIBLING_EVENT', evidence: [evidence] });
  const narrative = telling(left, [shared]);
  const character = call<Character>('character.create', { name: 'Lin', entries: [{ entryId: 'sibling', label: 'Sibling note', blocks: [
    { type: 'text', text: siblingDraft.body },
    { type: 'reference', kind: 'draft', id: siblingDraft.draftId, revision: 1, excerpt: siblingDraft.body },
  ] }] });
  const context = { ...brief, story: storyRef(narrative) };
  assert.throws(() => call('generations.prepare', { ...context, story: { ...context.story, branchId: right.sceneId } }),
    { code: 'narrative_branch_mismatch' });
  const refuse = (references: unknown[], code = 'generation_reference_branch_mismatch') => {
    assert.throws(() => call('generations.prepare', { ...context, references }), { code });
  };
  refuse([{ kind: 'draft', id: siblingDraft.draftId, revision: 1 }]);
  refuse([{ kind: 'scene', id: main.sceneId, revision: 1 }]);
  refuse([{ kind: 'event', id: siblingEvent.eventId, revision: 1 }], 'generation_event_not_visible');
  refuse([{ kind: 'character', id: character.characterId, revision: 1, includeDescription: false,
    selections: [{ entryId: 'sibling', blockIndex: 0 }] }]);
  refuse([{ kind: 'source', id: original.sourceId, revision: 1 }]);
  const generation = call<Generation>('generations.prepare', { ...context, references: [
    { kind: 'scene', id: left.sceneId, revision: 1 }, { kind: 'event', id: shared.eventId, revision: 1 },
    { kind: 'source', id: original.sourceId, revision: 1, range: evidence.range },
  ] });
  const trace = inspect(generation);
  assert.doesNotMatch(JSON.stringify([generation, trace]), /ORIGIN_DRAFT_SECRET|LEFT_ORIGIN_NOTE|SIBLING|MAINLINE_ONLY/);
  assert.ok(!JSON.stringify(trace).includes(mainDraft.draftId));
  assert.equal(span(trace, '/references/1/content/evidence/0/excerpt').value, evidence.excerpt);
  assert.deepEqual(span(trace, '/references/1/content/evidence/0/excerpt').row.target?.range, evidence.range);
  const leftRef = { kind: 'scene', id: left.sceneId, revision: 1 };
  const legacy = call<Generation>('generations.prepare', { ...brief, references: [leftRef] });
  assert.ok(!JSON.stringify(legacy).includes(mainDraft.draftId));
  assert.throws(() => call('generations.prepare', { ...brief, references: [leftRef,
    { kind: 'draft', id: siblingDraft.draftId, revision: 1 },
  ] }), { code: 'generation_reference_branch_mismatch' });
  const event = { kind: 'event', id: siblingEvent.eventId, revision: 1 };
  const sourceRef = { kind: 'source', id: original.sourceId, revision: 1 };
  assert.throws(() => call('generations.prepare', { ...brief, references: [event, sourceRef] }),
    { code: 'generation_reference_branch_mismatch' });
  const eventOnly = call<Generation>('generations.prepare', { ...brief, references: [event, { ...sourceRef, range: evidence.range }] });
  assert.doesNotMatch(JSON.stringify(eventOnly), /MAINLINE_ONLY/);
});

test('editing diary prose preserves the exact occurrence in its historical source pin', t => {
  const { call, source } = setup(t);
  const original = source('Schedule', '10:00\n10:00');
  const pin = { sourceId: original.sourceId, revision: 1, excerpt: '10:00', range: { start: 6, end: 11 } };
  const diary = call<{ noteId: string; sourcePins: unknown }>('diary.create', {
    title: 'A day', body: 'Earlier version.', diaryDate: '2026-11-24', sourcePins: [pin],
  });
  const revised = call<typeof diary>('diary.revise', {
    noteId: diary.noteId, title: 'A day', body: 'Later version.', diaryDate: '2026-11-24', expectedRevision: 1,
  });
  assert.deepEqual(revised.sourcePins, diary.sourcePins);
});

test('IF continuation pins a historical checkpoint and exposes only the viewpoint character state', t => {
  const { call, inspect } = setup(t);
  const main = call<Scene>('scene.create', { title: 'Main scene' });
  const alternate = call<Scene>('scene.branch', { sceneId: main.sceneId, revision: 1, divergence: 'Forked at the dock' });
  const otherBranch = call<Scene>('scene.branch', { sceneId: main.sceneId, revision: 1, divergence: 'Forked in town' });
  const lin = call<Character>('character.create', { name: 'Lin' });
  const tao = call<Character>('character.create', { name: 'Tao' });
  call('character.revise', { characterId: lin.characterId, expectedRevision: 1, description: 'LIN_CARD_DETAIL' });
  const characterView = { kind: 'character', characterId: lin.characterId, revision: 2 };
  const telling = (scene: Scene, viewpoint: object, title = 'Telling') => call<Narrative>('narrative.save', {
    sceneId: scene.sceneId, sceneRevision: scene.revision, title, viewpoint, eventOrder: [], knownEvents: [],
  });
  const pov = telling(alternate, characterView);
  const continuation = { sceneId: alternate.sceneId, sceneRevision: 1 };
  const pinnedNarrative = { narrativeId: pov.narrativeId, revision: pov.revision };
  const linState = { characterId: lin.characterId, revision: 1, state: 'Lin is carrying the \u{1f6a2} token.' };
  const taoState = { characterId: tao.characterId, revision: 1, state: 'TAO_PRIVATE_STATE' };
  const checkpoint = call<Branch>('branch.save', { ...continuation, branchId: alternate.sceneId, expectedRevision: 1,
    narrative: pinnedNarrative, note: 'AUTHOR_PRIVATE_NOTE', characterStates: [taoState, linState],
  });
  const input = { ...brief, story: { ...storyRef(pov), checkpointRevision: checkpoint.revision } };
  const first = call<Generation>('generations.prepare', input);
  const firstTrace = inspect(first);
  assert.deepEqual(first.composition.story?.checkpoint, { branchId: alternate.sceneId, revision: 2, characterState: linState });
  const location = span(firstTrace, '/story/checkpoint/characterState/state');
  assert.equal(location.value, linState.state);
  assert.deepEqual(location.row.target, { kind: 'branch', id: alternate.sceneId, revision: 2, characterId: lin.characterId,
    href: `/branches/${alternate.sceneId}?revision=2`, range: { start: 0, end: linState.state.length } });
  assert.doesNotMatch(JSON.stringify([first, firstTrace]), /TAO_PRIVATE_STATE|AUTHOR_PRIVATE_NOTE|LIN_CARD_DETAIL/);
  assert.ok(!JSON.stringify([first, firstTrace]).includes(tao.characterId));

  const latest = call<Branch>('branch.save', { ...continuation, branchId: alternate.sceneId, expectedRevision: 2,
    narrative: pinnedNarrative, note: 'LATEST_PRIVATE_NOTE', characterStates: [{ ...linState, state: 'Lin now has a compass.' }, taoState],
  });
  const old = call<Generation>('generations.prepare', input);
  assert.deepEqual(old.composition, first.composition);
  assert.deepEqual(inspect(old).provenance, firstTrace.provenance);
  const newest = call<Generation>('generations.prepare', { ...input, story: { ...input.story, checkpointRevision: latest.revision } });
  assert.equal(newest.composition.story?.checkpoint?.characterState?.state, 'Lin now has a compass.');
  const { planId } = call<{ planId: string }>('generation.plans.create', {
    title: 'Checkpoint plan', executor: 'openai-compatible', provider: 'local', model: 'fixture-model', parameters: {},
  });
  const delegated = inspect(call<Generation>('generations.start', { generationId: first.generationId, planId }));
  assert.deepEqual(delegated.messages, firstTrace.messages);
  assert.deepEqual(delegated.provenance, firstTrace.provenance);

  const narrator = telling(alternate, { kind: 'omniscient' });
  const narratorCheckpoint = call<Branch>('branch.save', { ...continuation, branchId: alternate.sceneId, expectedRevision: latest.revision,
    narrative: { narrativeId: narrator.narrativeId, revision: narrator.revision }, note: 'LATEST_PRIVATE_NOTE',
  });
  const neutral = call<Generation>('generations.prepare', { ...brief, story: { ...storyRef(narrator), checkpointRevision: narratorCheckpoint.revision } });
  assert.deepEqual(neutral.composition.story?.checkpoint, { branchId: alternate.sceneId, revision: narratorCheckpoint.revision });
  assert.doesNotMatch(JSON.stringify(neutral), /has a compass|TAO_PRIVATE_STATE|LATEST_PRIVATE_NOTE/);
  assert.throws(() => call('generations.prepare', { ...brief, story: { ...storyRef(narrator), checkpointRevision: 2 } }),
    { code: 'generation_checkpoint_telling_mismatch' });
  assert.throws(() => call('generations.prepare', { ...brief, story: { ...storyRef(telling(main, characterView)), checkpointRevision: 2 } }),
    { code: 'generation_checkpoint_branch_required' });
  assert.throws(() => call('generations.prepare', { ...brief, story: { ...storyRef(telling(otherBranch, characterView)), checkpointRevision: 2 } }),
    { code: 'branch_revision_not_found' });
  const laterScene = call<Scene>('scene.revise', { sceneId: alternate.sceneId, expectedRevision: 1, title: 'Later scene version' });
  assert.throws(() => call('generations.prepare', { ...brief, story: { ...storyRef(telling(laterScene, characterView)), checkpointRevision: latest.revision } }),
    { code: 'generation_checkpoint_telling_mismatch' });
  const unmatched = call<Branch>('branch.save', { ...continuation, branchId: alternate.sceneId, expectedRevision: narratorCheckpoint.revision,
    narrative: pinnedNarrative, characterStates: [taoState],
  });
  const unmatchedGeneration = call<Generation>('generations.prepare', { ...input, story: { ...input.story, checkpointRevision: unmatched.revision } });
  assert.equal(unmatchedGeneration.composition.story?.checkpoint?.characterState, undefined);
  assert.doesNotMatch(JSON.stringify(unmatchedGeneration), /TAO_PRIVATE_STATE/);
  const unpinned = call<Generation>('generations.prepare', { ...brief, story: storyRef(pov) });
  assert.equal(unpinned.composition.story?.checkpoint, undefined);
});
