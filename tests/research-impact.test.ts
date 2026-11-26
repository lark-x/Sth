import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Operations, operationsDDL } from '../src/core/index.ts';
import type { Generation, PromptInspection } from '../src/generation/contracts.ts';
import type { CharacterEntry } from '../src/library/character-contracts.ts';
import type { Judgment, Source, SourceImpact, SourceImpactPage } from '../src/sources/index.ts';
import type { DraftRef, Scene } from '../src/story/contracts.ts';
import type { Event, Narrative } from '../src/story/index.ts';
import { workspaceDDL, workspaceOperations } from '../src/workspace.ts';

type Character = { characterId: string; revision: number; entries: CharacterEntry[] };
const task = { title: 'Harbor', brief: 'Write the selected telling.', templateId: 'short-story' };
const viewpoint = { kind: 'omniscient' };

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(operationsDDL + workspaceDDL);
  const ops = new Operations(db, workspaceOperations);
  let step = 0;
  function run<T>(operationId: string, input: object): T {
    return ops.invoke('impact-test', { operationId, stepId: String(++step), input }).result as T;
  }
  function source(title: string, body: string) {
    return run<Source>('source.create', { kind: 'excerpt', title, body });
  }
  function impact(source: Source, filters: { revision?: number; kind?: SourceImpact['kind']; currentOnly?: boolean; limit?: number; offset?: number } = {}) {
    return run<SourceImpactPage>('source.impact', { sourceId: source.sourceId, ...filters });
  }
  return { db, ops, run, source, impact };
}

function fullPin({ sourceId, revision, body }: Source) {
  return { sourceId, revision, excerpt: body, range: { start: 0, end: body.length } };
}

function eventRef({ eventId, revision }: Event) { return { eventId, revision }; }
function storyRef({ narrativeId, revision, branchId }: Narrative) { return { narrativeId, revision, branchId }; }
function pathRef(kind: SourceImpact['via'][number]['kind'], id: string, revision: number) { return { kind, id, revision }; }

test('follows exact judgment, event, and telling versions to linked resources and preserves prompt snapshots', t => {
  const { db, ops, run, source, impact } = setup(t);
  const operation = ops.catalog().operations.find(({ id }) => id === 'source.impact');
  assert.equal(operation?.effect, 'read');
  const original = source('Logbook', 'The last ferry left at ten.');
  const other = source('Harbormaster', 'The last ferry left at nine.');
  const judgmentInput = { title: 'Last departure', statement: 'The ten o\'clock ferry was the last.' };
  const judgment = run<Judgment>('judgment.create', { ...judgmentInput, evidence: [
    { stance: 'support', pin: fullPin(original) }, { stance: 'counter', pin: fullPin(original) },
  ] });
  const eventInput = { title: 'Departure', summary: 'The ferry left at ten.' };
  const event = run<Event>('event.save', { ...eventInput, evidence: [{ kind: 'judgment', judgmentId: judgment.judgmentId, revision: 1 }] });
  const scene = run<Scene>('scene.create', { title: 'The harbor' });
  const sceneRef = { sceneId: scene.sceneId, sceneRevision: scene.revision };
  const draft = run<DraftRef>('draft.create', { ...sceneRef, title: 'Ferry draft', body: 'She watched the ferry leave.' });
  const tellingInput = { ...sceneRef, title: 'The last ferry', viewpoint, eventOrder: [eventRef(event)], knownEvents: [eventRef(event)],
    draft: { draftId: draft.draftId, revision: draft.revision } };
  const narrative = run<Narrative>('narrative.save', tellingInput);
  const generation = run<Generation>('generations.prepare', { ...task, story: storyRef(narrative) });
  const hiddenTelling = run<Narrative>('narrative.save', { ...tellingInput, title: 'The unseen departure', knownEvents: [] });
  const hiddenGeneration = run<Generation>('generations.prepare', { ...task, story: storyRef(hiddenTelling) });
  const promptInput = { generationId: generation.generationId };
  const prompt = run<PromptInspection>('generations.prompt', promptInput);
  const eventPath = pathRef('event', event.eventId, 1);
  const judgmentPath = pathRef('judgment', judgment.judgmentId, 1);
  const narrativePath = pathRef('narrative', narrative.narrativeId, 1);

  const newer = run<Source>('source.revise', { sourceId: original.sourceId, expectedRevision: 1, body: other.body });
  run('judgment.revise', { judgmentId: judgment.judgmentId, expectedRevision: 1, statement: 'The revised record says nine.',
    evidence: [{ stance: 'support', pin: fullPin(newer) }] });
  const nextEvent = run<Event>('event.save', { ...eventInput, eventId: event.eventId, expectedRevision: 1, summary: 'The ferry left at nine.',
    evidence: [{ kind: 'judgment', judgmentId: judgment.judgmentId, revision: 2 }] });
  run('narrative.save', { ...tellingInput, narrativeId: narrative.narrativeId, expectedRevision: 1, eventOrder: [eventRef(nextEvent)], knownEvents: [eventRef(nextEvent)] });
  run('scene.revise', { sceneId: scene.sceneId, expectedRevision: 1, title: 'The revised harbor' });
  run('draft.revise', { draftId: draft.draftId, expectedRevision: 1, title: 'Ferry draft', body: 'The harbor fell quiet.' });

  const pinRow = (item: SourceImpact) => [item.kind, item.id, item.revision, item.state] as const;
  const before = db.prepare(`SELECT composition_json FROM generation_records WHERE generation_id = ?`).get(generation.generationId);
  const { items } = impact(original, { revision: 1 });
  assert.deepEqual(new Set(items.map(pinRow)), new Set([
    ['judgment', judgment.judgmentId, 1, 'historical'], ['event', event.eventId, 1, 'historical'],
    ['narrative', narrative.narrativeId, 1, 'historical'], ['narrative', hiddenTelling.narrativeId, 1, 'current'],
    ['scene', scene.sceneId, 1, 'historical'], ['draft', draft.draftId, 1, 'historical'],
    ['generation', generation.generationId, undefined, 'snapshot'],
  ]));
  assert.equal(items.length, 7);
  assert.ok(items.every(item => item.sourceRevision === 1));
  assert.equal(items.find(item => item.id === narrative.narrativeId)?.href, narrative.href);
  assert.deepEqual(items.find(item => item.id === event.eventId)?.via, [judgmentPath]);
  assert.deepEqual(items.find(item => item.id === narrative.narrativeId)?.via, [judgmentPath, eventPath]);
  assert.deepEqual(items.find(item => item.id === generation.generationId)?.via, [judgmentPath, eventPath]);
  assert.equal(items.find(item => item.id === generation.generationId)?.href, prompt.href);
  for (const kind of ['draft', 'scene']) {
    const via = items.find(item => item.kind === kind)?.via;
    assert.deepEqual(via?.slice(0, 2), [judgmentPath, eventPath]);
    assert.ok(via && [narrativePath.id, hiddenTelling.narrativeId].includes(via[2]?.id));
  }
  assert.deepEqual(impact(original, { revision: 1, currentOnly: true }).items.map(item => item.id), [hiddenTelling.narrativeId]);
  assert.deepEqual(impact(original, { revision: 2, kind: 'event' }).items.map(pinRow), [['event', event.eventId, 2, 'current']]);
  assert.equal(impact(original, { revision: 2, kind: 'generation' }).items.length, 0);
  assert.equal(items.some(item => item.id === hiddenGeneration.generationId), false);
  assert.deepEqual(run('generations.prompt', promptInput), prompt);
  assert.deepEqual(db.prepare(`SELECT composition_json FROM generation_records WHERE generation_id = ?`).get(generation.generationId), before);

  const all = impact(original).items;
  const paged: SourceImpact[] = [];
  let offset: number | undefined = 0;
  do {
    const page: SourceImpactPage = impact(original, { limit: 3, offset });
    paged.push(...page.items);
    offset = page.nextOffset;
  } while (offset !== undefined);
  assert.deepEqual(paged, all);
  assert.deepEqual(impact(original, { offset: 999 }), { items: [] });
  assert.deepEqual(impact(other), { items: [] });
  assert.throws(() => impact(original, { revision: 999 }), { code: 'source_revision_not_found' });
  assert.throws(() => impact({ ...original, sourceId: 'missing' }), { code: 'source_not_found' });
});

test('finds cards that adopted a judgment and snapshots that selected its citation block', t => {
  const { db, run, source, impact } = setup(t);
  const original = source('Logbook', '🚢 The last ferry left at ten.');
  const judgment = run<Judgment>('judgment.create', { title: 'Last departure', statement: 'The tide delayed the ferry.',
    evidence: [{ stance: 'support', pin: fullPin(original) }] });
  const character = run<Character>('character.create', { name: 'Lin' });
  const adopted = run<Character>('character.adopt-entries', { characterId: character.characterId, expectedRevision: 1, entries: [
    { label: 'Departure', text: 'Editorial note.', references: [{ kind: 'judgment', id: judgment.judgmentId, revision: 1 }] },
    { label: 'Logbook', references: [{ kind: 'source', id: original.sourceId, revision: 1, range: fullPin(original).range }] },
  ] });
  const judgmentEntry = adopted.entries.find(entry => entry.label === 'Departure')!;
  const judgmentIndex = judgmentEntry.blocks.findIndex(block => block.type === 'reference');
  const textIndex = judgmentEntry.blocks.findIndex(block => block.type === 'text');
  const otherCard = run<Character>('character.create', { name: 'Observer', entries: [{ label: 'Departure', blocks: [
    { type: 'reference', kind: 'judgment', id: judgment.judgmentId, revision: 1 },
  ] }] });
  const prepare = (selections: object[]) => run<Generation>('generations.prepare', { ...task, references: [
    { kind: 'character', id: adopted.characterId, revision: adopted.revision, includeDescription: false, selections },
  ] });
  const selected = prepare([{ entryId: judgmentEntry.entryId, blockIndex: judgmentIndex }]);
  const unselected = prepare([{ entryId: judgmentEntry.entryId, blockIndex: textIndex }]);
  const legacy = run<Generation>('generations.prepare', { ...task, references: [{ kind: 'source', id: original.sourceId, revision: 1 }] });
  db.prepare(`UPDATE generation_records SET composition_json = json_remove(composition_json, '$.promptProvenance')
    WHERE generation_id = ?`).run(legacy.generationId);
  assert.equal(run<PromptInspection>('generations.prompt', { generationId: legacy.generationId }).historical, true);
  const cards = impact(original, { kind: 'character' }).items;
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.find(item => item.id === adopted.characterId)?.via, []);
  assert.deepEqual(cards.find(item => item.id === otherCard.characterId)?.via, [pathRef('judgment', judgment.judgmentId, 1)]);
  run('character.revise', { characterId: character.characterId, expectedRevision: adopted.revision, entries: [] });
  assert.equal(impact(original, { kind: 'character' }).items.find(item => item.id === character.characterId)?.state, 'historical');
  assert.deepEqual(impact(original, { kind: 'character', currentOnly: true }).items.map(item => item.id), [otherCard.characterId]);
  const snapshots = impact(original, { kind: 'generation' }).items;
  assert.deepEqual(new Set(snapshots.map(item => item.id)), new Set([selected.generationId, legacy.generationId]));
  assert.equal(snapshots.some(item => item.id === unselected.generationId), false);
  assert.deepEqual(snapshots.find(item => item.id === selected.generationId)?.via, [pathRef('judgment', judgment.judgmentId, 1)]);
  assert.deepEqual(impact(original, { kind: 'generation', currentOnly: true }), { items: [] });
});

test('finds direct pins without treating event order as an evidence dependency', t => {
  const { run, source, impact } = setup(t);
  const original = source('Logbook', 'The bell rang.');
  const other = source('Calendar', 'It was Tuesday.');
  const pin = fullPin(original);
  const diary = run<{ noteId: string }>('diary.create', { title: 'Diary', body: 'I heard it.', diaryDate: '2026-11-24', sourcePins: [pin] });
  const scene = run<Scene>('scene.create', { title: 'Quay', sources: [pin] });
  const draft = run<DraftRef>('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: 'Quay draft', body: 'The quay emptied.' });
  const first = run<Event>('event.save', { title: 'Bell', summary: 'The bell rang.', evidence: [{ kind: 'source', ...pin }] });
  const second = run<Event>('event.save', { title: 'Date', summary: 'It was Tuesday.', evidence: [{ kind: 'source', ...fullPin(other) }] });
  run('event.order', { beforeEventId: first.eventId, afterEventId: second.eventId });
  const generation = run<Generation>('generations.prepare', { ...task, references: [{ kind: 'scene', id: scene.sceneId, revision: 1 }] });

  const { items } = impact(original);
  assert.deepEqual(items.map(item => [item.kind, item.id, item.via]), [
    ['diary', diary.noteId, []], ['draft', draft.draftId, [pathRef('scene', scene.sceneId, 1)]],
    ['event', first.eventId, []], ['generation', generation.generationId, []], ['scene', scene.sceneId, []],
  ]);
});
