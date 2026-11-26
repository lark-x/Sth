import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { Static } from '@sinclair/typebox';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { libraryDDL, libraryOperations } from '../src/library/index.ts';
import { sourcesDDL, sourceOperations, type Source, type SourceBacklink } from '../src/sources/index.ts';
import { storyDDL, storyOperations } from '../src/story/index.ts';
import type { chapter, chapterWithScenes, draft, draftSummary, DraftRef, Scene, SceneSummary } from '../src/story/contracts.ts';

type Project = { projectId: string };
type Chapter = Static<typeof chapter>;
type ChapterWithScenes = Static<typeof chapterWithScenes>;
type Draft = Static<typeof draft>;
type DraftSummary = Static<typeof draftSummary>;
type List<T> = { items: T[] };

const allOperations = [...libraryOperations, ...sourceOperations, ...storyOperations];

function client(db: DatabaseSync, namespace: string) {
  const core = new Operations(db, allOperations);
  let nextStep = 0;
  function invoke(operationId: string, input: object, stepId = `step-${++nextStep}`) {
    return core.invoke(namespace, { operationId, stepId, input });
  }
  function run<T>(operationId: string, input: object, stepId?: string): T {
    return invoke(operationId, input, stepId).result as T;
  }
  return { core, invoke, run };
}

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(operationsDDL + libraryDDL + sourcesDDL + storyDDL);
  return { db, ...client(db, 'story-test') };
}

function problem(statusCode: number, code: string) {
  return { name: 'OperationError', statusCode, code };
}

const ref = ({ draftId, revision }: Draft): DraftRef => ({ draftId, revision });
const pinned = ({ href, revision, ...record }: Draft): Draft => ({ ...record, revision, href: `${href}?revision=${revision}` });

test('compare, explicitly adopt and revise candidates, then continue an IF independently', t => {
  const { core, run, invoke } = setup(t);
  assert.deepEqual(core.catalog().operations.filter(operation => /^(chapter|draft|scene)\./.test(operation.id))
    .map(({ id }) => id), [
    'chapter.create', 'chapter.list', 'chapter.read', 'chapter.revise', 'chapter.arrange',
    'scene.create', 'scene.list', 'scene.read', 'scene.revise', 'scene.revisions', 'scene.adopt', 'scene.branch',
    'draft.create', 'draft.list', 'draft.read', 'draft.revise', 'draft.revisions', 'draft.compare',
  ]);
  assert.deepEqual(core.catalog().operations.find(({ id }) => id === 'scene.read')?.interaction, {
    resultLink: { hrefField: 'href', labelField: 'title' },
  });

  const { projectId } = run<Project>('project.create', { title: '北港' });
  const { chapterId } = run<Chapter>('chapter.create', { projectId, title: '第一章' });
  const { sceneId } = run<Scene>('scene.create', { title: '北港那一晚', time: '末班船前', place: '北港渡口' });
  const first = run<Draft>('draft.create', { sceneId, sceneRevision: 1, title: '林岚视角', body: '我跑过码头。\n\n我上了船。' });
  const second = run<Draft>('draft.create', { sceneId, sceneRevision: 1, title: '船夫视角', body: '船夫看见林岚登船。' });
  assert.equal(first.href, `/drafts/${first.draftId}`);
  assert.equal(first.sceneHref, `/scenes/${sceneId}?revision=1`);
  assert.deepEqual(run('draft.compare', { sceneId, left: ref(first), right: ref(second) }), { left: pinned(first), right: pinned(second) });
  assert.deepEqual(run<List<DraftSummary>>('draft.list', { sceneId }).items.map(({ draftId }) => draftId), [first.draftId, second.draftId]);

  const chosen = { sceneId, expectedRevision: 1, draftId: second.draftId, draftRevision: 1 };
  const adopted = run<Scene>('scene.adopt', chosen, 'author-picked-second');
  assert.equal(adopted.revision, 2);
  assert.deepEqual(adopted.adopted, pinned(second));
  assert.equal(adopted.href, `/scenes/${sceneId}`);
  assert.equal(run<Scene>('scene.read', { sceneId, revision: 1 }).adopted, undefined);
  const placed = run<Chapter>('chapter.arrange', { chapterId, expectedRevision: 1, sceneIds: [sceneId] });
  assert.equal(placed.revision, 2);
  const canonical = run<ChapterWithScenes>('chapter.read', { chapterId });
  assert.equal(canonical.href, `/chapters/${chapterId}`);
  assert.deepEqual(canonical.scenes[0].adopted, ref(second));

  const revised = run<Draft>('draft.revise', { draftId: second.draftId, expectedRevision: 1, body: '船夫看见林岚坐在船尾。' });
  assert.equal(revised.revision, 2);
  assert.equal(revised.sceneRevision, 1);
  assert.deepEqual(run('draft.compare', { sceneId, left: ref(second), right: ref(revised) }), { left: pinned(second), right: pinned(revised) });
  assert.deepEqual(run<Scene>('scene.read', { sceneId }).adopted, pinned(second));
  assert.deepEqual(run<Draft>('draft.read', { draftId: second.draftId }), revised);
  assert.deepEqual(run<Draft>('draft.read', ref(second)), pinned(second));
  assert.throws(() => run('draft.revise', { draftId: second.draftId, expectedRevision: 1, body: '过期修改' }),
    { ...problem(409, 'draft_revision_conflict'), message: /revision 2/ });
  assert.throws(() => run('scene.adopt', { ...chosen, draftRevision: 2 }),
    { ...problem(409, 'scene_revision_conflict'), message: /revision 2/ });

  const branch = run<Scene>('scene.branch', { sceneId, revision: 2, divergence: '她没有上船。', title: '北港 IF' });
  assert.deepEqual(branch.branchFrom, { sceneId, revision: 2, draft: ref(second), divergence: '她没有上船。' });
  assert.equal(branch.placement, undefined);
  assert.equal(branch.adopted, undefined);
  assert.equal(branch.place, '北港渡口');
  const alternate = run<Scene>('scene.branch', { sceneId, revision: 1, draft: ref(first), divergence: '她赶上了另一艘船。' });
  assert.deepEqual(alternate.branchFrom?.draft, ref(first));
  assert.deepEqual(run('draft.list', { sceneId: branch.sceneId }), { items: [] });
  const ifDraft = run<Draft>('draft.create', {
    sceneId: branch.sceneId, sceneRevision: 1, title: '留在码头', body: '林岚在码头等到了天亮。',
  });
  assert.throws(() => run('scene.adopt', { ...chosen, expectedRevision: 2, draftId: ifDraft.draftId }), problem(409, 'draft_scene_mismatch'));
  assert.throws(() => run('draft.compare', { sceneId, left: ref(first), right: ref(ifDraft) }), problem(409, 'draft_scene_mismatch'));
  const ifSelected = run<Scene>('scene.adopt', {
    sceneId: branch.sceneId, expectedRevision: 1, draftId: ifDraft.draftId, draftRevision: ifDraft.revision,
  });
  assert.deepEqual(ifSelected.adopted, pinned(ifDraft));
  assert.deepEqual(run('chapter.read', { chapterId }), canonical);
  assert.deepEqual(run<Scene>('scene.read', { sceneId }).adopted, pinned(second));

  const useNewEnding = run<Scene>('scene.adopt', { ...chosen, expectedRevision: 2, draftRevision: 2 });
  assert.deepEqual(useNewEnding.adopted, pinned(revised));
  const historical = run<Scene>('scene.read', { sceneId, revision: 2 });
  assert.equal(historical.href, `/scenes/${sceneId}?revision=2`);
  assert.deepEqual(historical.adopted, pinned(second));
  assert.deepEqual(run('draft.read', ref(first)), pinned(first));
  assert.deepEqual(run<List<DraftSummary>>('draft.revisions', { draftId: second.draftId }).items.map(({ revision }) => revision), [2, 1]);
  assert.deepEqual(run<List<SceneSummary>>('scene.revisions', { sceneId, limit: 2 }).items.map(({ adopted }) => adopted), [ref(revised), ref(second)]);
  assert.deepEqual(new Set(run<List<SceneSummary>>('scene.list', { branchOf: sceneId }).items.map(({ sceneId }) => sceneId)),
    new Set([branch.sceneId, alternate.sceneId]));
  const receipt = invoke('scene.adopt', chosen, 'author-picked-second');
  assert.equal(receipt.replayed, true);
  assert.deepEqual(receipt.result, adopted);
});

test('scene revisions retain exact historical personas and source excerpts with Stage 1 backlinks', t => {
  const { db, run } = setup(t);
  const { characterId } = run<{ characterId: string }>('character.create', { name: '林岚', persona: '第一次乘船。' });
  const oldText = '北港末班渡船是晚上十点。';
  const newText = '北港末班渡船是晚上九点。';
  const { sourceId } = run<Source>('source.create', { kind: 'setting', title: '末班船', body: oldText });
  const oldSources = [{ sourceId, revision: 1, excerpt: '晚上十点' }];
  const oldCast = [{ characterId, revision: 1 }];
  const original = run<Scene>('scene.create', { title: '北港', time: '夜晚', characters: oldCast, sources: oldSources });
  const { sceneId } = original;
  run('character.revise', { characterId, expectedRevision: 1, name: '林船长', persona: '熟悉水路。' });
  run('source.revise', { sourceId, expectedRevision: 1, body: newText });
  assert.deepEqual(run('scene.read', { sceneId }), original);
  assert.deepEqual(original.characters, [{ characterId, revision: 1, name: '林岚', persona: '第一次乘船。' }]);
  assert.deepEqual(original.sources, [{ ...oldSources[0], href: `/sources/${sourceId}?revision=1` }]);
  assert.deepEqual(run('scene.revise', { sceneId, expectedRevision: 1, sources: oldSources, characters: oldCast }), original);

  assert.throws(() => run('scene.revise', {
    sceneId, expectedRevision: 1, sources: [{ sourceId, revision: 2, excerpt: oldSources[0].excerpt }],
  }), problem(400, 'source_excerpt_mismatch'));
  assert.throws(() => run('scene.create', { title: '缺人设版本', characters: [{ characterId, revision: 3 }] }),
    problem(404, 'scene_character_revision_not_found'));
  assert.throws(() => run('scene.create', { title: '重复角色', characters: [...oldCast, { characterId, revision: 2 }] }),
    problem(400, 'scene_duplicate_character'));
  assert.deepEqual(run<List<SceneSummary>>('scene.list', {}).items.map(({ sceneId }) => sceneId), [sceneId]);
  assert.deepEqual(run<List<SceneSummary>>('scene.revisions', { sceneId }).items.map(({ revision }) => revision), [1]);

  const updated = run<Scene>('scene.revise', {
    sceneId, expectedRevision: 1, time: null, characters: [{ characterId, revision: 2 }],
    sources: [{ sourceId, revision: 2, excerpt: '晚上九点' }],
  });
  assert.equal(updated.time, undefined);
  assert.deepEqual(updated.characters, [{ characterId, revision: 2, name: '林船长', persona: '熟悉水路。' }]);
  assert.equal(updated.sources[0].revision, 2);
  assert.deepEqual(run('scene.read', { sceneId, revision: 1 }), { ...original, href: `/scenes/${sceneId}?revision=1` });
  assert.throws(() => run('scene.read', { sceneId, revision: 3 }), problem(404, 'scene_revision_not_found'));

  const branch = run<Scene>('scene.branch', { sceneId, revision: 1, divergence: '她留在北港。' });
  assert.deepEqual(branch.characters, original.characters);
  assert.deepEqual(branch.sources, original.sources);
  const links = run<List<SourceBacklink>>('source.backlinks', { sourceId, revision: 1, ownerKind: 'scene' }).items;
  assert.deepEqual(new Set(links.map(({ owner }) => owner.href)), new Set([
    `/scenes/${sceneId}?revision=1`, `/scenes/${branch.sceneId}?revision=1`,
  ]));
  assert.equal(run<List<SourceBacklink>>('source.backlinks', { sourceId, revision: 2 }).items[0].owner.revision, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('chapter arrangement is ordered, paginated and atomic on placement or revision conflict', t => {
  const { run } = setup(t);
  const { projectId } = run<Project>('project.create', { title: '北港' });
  const otherProject = run<Project>('project.create', { title: '南港' });
  const first = run<Chapter>('chapter.create', { projectId, title: '开场' });
  const next = run<Chapter>('chapter.create', { projectId, title: '渡口' });
  const other = run<Chapter>('chapter.create', { projectId: otherProject.projectId, title: '开场' });
  assert.deepEqual(run<List<Chapter>>('chapter.list', { projectId }).items, [first, next]);
  assert.deepEqual(new Set(run<List<Chapter>>('chapter.list', { title: '开场' }).items), new Set([first, other]));
  const { sceneId: one } = run<Scene>('scene.create', { title: '到港' });
  const { sceneId: two } = run<Scene>('scene.create', { title: '上船' });
  const arrange = (chapterId: string, expectedRevision: number, sceneIds: string[]) =>
    run<Chapter>('chapter.arrange', { chapterId, expectedRevision, sceneIds });
  const order = (chapterId: string, offset = 0) =>
    run<ChapterWithScenes>('chapter.read', { chapterId, offset }).scenes.map(({ sceneId }) => sceneId);

  assert.throws(() => arrange(first.chapterId, 1, [one, one]), problem(400, 'chapter_duplicate_scene'));
  assert.throws(() => arrange(first.chapterId, 1, [one, 'missing']), problem(404, 'scene_not_found'));
  assert.deepEqual(order(first.chapterId), []);
  arrange(first.chapterId, 1, [two, one]);
  assert.deepEqual(order(first.chapterId), [two, one]);
  assert.deepEqual(order(first.chapterId, 1), [one]);
  assert.deepEqual(run<Scene>('scene.read', { sceneId: one, revision: 1 }).placement,
    { chapterId: first.chapterId, projectId, position: 2 });
  assert.deepEqual(run<List<SceneSummary>>('scene.list', { projectId, limit: 1, offset: 1 }).items.map(({ sceneId }) => sceneId), [one]);
  assert.throws(() => arrange(next.chapterId, 1, [one]), problem(409, 'chapter_scene_already_placed'));
  assert.throws(() => arrange(first.chapterId, 1, [one]), { ...problem(409, 'chapter_revision_conflict'), message: /revision 2/ });
  assert.deepEqual(order(first.chapterId), [two, one]);
  assert.deepEqual(order(next.chapterId), []);

  arrange(first.chapterId, 2, [one, two]);
  assert.deepEqual(order(first.chapterId), [one, two]);
  arrange(first.chapterId, 3, [one]);
  assert.deepEqual(run<List<SceneSummary>>('scene.list', { chapterId: null }).items.map(({ sceneId }) => sceneId), [two]);
  arrange(next.chapterId, 1, [two]);
  assert.deepEqual(order(next.chapterId), [two]);
  const renamed = run<Chapter>('chapter.revise', { chapterId: next.chapterId, expectedRevision: 2, title: '夜渡' });
  assert.equal(renamed.revision, 3);
  assert.equal(renamed.title, '夜渡');
  assert.equal(arrange(next.chapterId, 3, [two]).revision, 3);
});

test('story writes and receipts survive reopen and reject a stale write from another connection', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-story-'));
  const file = join(directory, 'story.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writer = new DatabaseSync(file);
  const creation = { title: '原来的场景' };
  let initial: Scene;
  try {
    writer.exec(operationsDDL + libraryDDL + sourcesDDL + storyDDL);
    const a = client(writer, 'first-connection');
    initial = a.run<Scene>('scene.create', creation, 'create-once');
    const concurrent = new DatabaseSync(file);
    try {
      const b = client(concurrent, 'second-connection');
      const stale = b.run<Scene>('scene.read', { sceneId: initial.sceneId });
      a.run('scene.revise', { sceneId: initial.sceneId, expectedRevision: 1, title: '新的场景' });
      assert.throws(() => b.run('scene.revise', {
        sceneId: initial.sceneId, expectedRevision: stale.revision, title: '过期修改',
      }, 'stale-write'), problem(409, 'scene_revision_conflict'));
      assert.throws(() => b.core.receipt('second-connection', { operationId: 'scene.revise', stepId: 'stale-write' }),
        problem(404, 'operation_receipt_not_found'));
    } finally {
      concurrent.close();
    }
  } finally {
    writer.close();
  }

  const reopened = new DatabaseSync(file);
  try {
    reopened.exec(storyDDL);
    const { run, invoke } = client(reopened, 'first-connection');
    const replay = invoke('scene.create', creation, 'create-once');
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, initial);
    assert.throws(() => invoke('scene.create', { title: '同一步，不同内容' }, 'create-once'), problem(409, 'operation_step_conflict'));
    assert.equal(run<Scene>('scene.read', { sceneId: initial.sceneId }, 'read-after-reopen').title, '新的场景');
    assert.deepEqual(run('scene.read', { sceneId: initial.sceneId, revision: 1 }, 'read-original-after-reopen'), {
      ...initial, href: `/scenes/${initial.sceneId}?revision=1`,
    });
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    reopened.close();
  }
});
