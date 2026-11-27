import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { connectionsDDL } from '../src/connections.ts';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { openDatabase } from '../src/database.ts';
import { createApp } from '../src/server.ts';
import { decisionSchemaVersion, decisionsDDL, migrateDecisions } from '../src/story/decision-schema.ts';
import { storyDDL, type Branch, type Decision, type Question, type StoryContext } from '../src/story/index.ts';
import type { Draft, Scene } from '../src/story/contracts.ts';
import { sceneDDL } from '../src/story/schema.ts';
import { workspaceDDL, workspaceOperations, workspaceSchemaVersion } from '../src/workspace.ts';

type Project = { projectId: string };
type List<T> = { items: T[] };
const problem = (statusCode: number, code: string) => ({ name: 'OperationError', statusCode, code });
const content = { title: '渡船的去向', body: '林岚留在北港。' };
const reference = ({ decisionId, revision }: Decision) => ({ decisionId, revision });

function client(db: DatabaseSync, namespace = 'author') {
  const core = new Operations(db, workspaceOperations);
  let step = 0;
  const invoke = (operationId: string, input: object, stepId = `step-${++step}`) => core.invoke(namespace, { operationId, stepId, input });
  return { core, invoke, run: <T>(operationId: string, input: object, stepId?: string) => invoke(operationId, input, stepId).result as T };
}

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(operationsDDL + workspaceDDL + connectionsDDL);
  t.after(() => db.close());
  const caller = client(db);
  const { projectId } = caller.run<Project>('project.create', { title: '北港' });
  return { db, ...caller, projectId };
}

function temporaryDirectory(t: TestContext, close: () => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sth-decisions-'));
  t.after(() => {
    close();
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function confirm(run: ReturnType<typeof client>['run'], proposed: Decision) {
  return run<Decision>('decision.confirm', {
    decisionId: proposed.decisionId, expectedRevision: proposed.revision, proposalRevision: proposed.revision,
    authorConfirmed: true, confirmedBy: '作者甲',
  });
}

test('proposals cannot promote themselves and author confirmations pin exact proposal versions', t => {
  const { db, core, run, projectId } = setup(t);
  assert.deepEqual(core.catalog().operations.filter(({ id }) => /^(decision|question|story)\./.test(id)).map(({ id }) => id), [
    'decision.propose', 'decision.confirm', 'decision.read', 'decision.list', 'decision.revisions',
    'question.save', 'question.resolve', 'question.reopen', 'question.read', 'question.list', 'question.revisions', 'story.context',
  ]);
  for (const field of [{ status: 'confirmed' }, { confirmedBy: 'AI' }, { authorConfirmed: true }, { revision: 2 }]) {
    assert.throws(() => run('decision.propose', { projectId, ...content, ...field }), problem(400, 'operation_invalid_input'));
  }
  const proposed = run<Decision>('decision.propose', { projectId, ...content });
  assert.equal(proposed.status, 'proposed');
  assert.equal('confirmation' in proposed, false);
  const input = { decisionId: proposed.decisionId, expectedRevision: 1, proposalRevision: 1, confirmedBy: '作者甲' };
  assert.throws(() => run('decision.confirm', input), problem(400, 'operation_invalid_input'));
  assert.throws(() => run('decision.confirm', { ...input, authorConfirmed: false }), problem(400, 'operation_invalid_input'));
  assert.throws(() => run('decision.confirm', { ...input, authorConfirmed: true, confirmedAt: 'yesterday' }), problem(400, 'operation_invalid_input'));
  const confirmed = confirm(run, proposed);
  assert.equal(confirmed.revision, 2);
  assert.equal(confirmed.status, 'confirmed');
  if (confirmed.status !== 'confirmed') throw new Error('Expected a confirmation');
  assert.deepEqual(confirmed.confirmation, {
    proposalRevision: 1, confirmedBy: '作者甲', confirmedAt: confirmed.confirmation.confirmedAt,
  });
  assert.ok(Number.isFinite(Date.parse(confirmed.confirmation.confirmedAt)));
  assert.deepEqual(confirmed.basis, proposed.basis);
  assert.deepEqual(run('decision.read', { decisionId: proposed.decisionId, revision: 1 }), proposed);
  const next = run<Decision>('decision.propose', {
    projectId, decisionId: proposed.decisionId, expectedRevision: 2, ...content, body: '新的 AI 建议，尚待确认。',
  });
  assert.equal(next.status, 'proposed');
  assert.equal(next.revision, 3);
  const context = run<StoryContext>('story.context', { projectId });
  assert.equal(context.pendingDecisions.items[0].revision, 3);
  assert.equal(context.confirmedDecisions.items[0].revision, 2);
  assert.equal(context.confirmedDecisions.items[0].body, proposed.body);
  assert.match(context.text, /待作者确认的提案/);
  assert.match(context.text, /作者已确认的决定/);
  assert.match(context.text, /作者甲/);
  assert.equal(run<List<Decision>>('decision.list', { projectId, status: 'confirmed' }).items[0].revision, 2);
  assert.deepEqual(run<List<Decision>>('decision.revisions', { decisionId: proposed.decisionId, limit: 2, offset: 1 })
    .items.map(({ revision }) => revision), [2, 1]);
  assert.throws(() => run('decision.confirm', { ...input, expectedRevision: 3, proposalRevision: 2, authorConfirmed: true }),
    problem(409, 'decision_proposal_required'));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('questions pin confirmed answers through rejudgment, resolution edits and reopening', t => {
  const { db, run, projectId } = setup(t);
  const proposed = run<Decision>('decision.propose', { projectId, ...content });
  const opened = run<Question>('question.save', { projectId, title: '她是否上船', body: '需要作者决定下一场的去向。' });
  assert.throws(() => run('question.resolve', { questionId: opened.questionId, expectedRevision: 1, decision: reference(proposed) }),
    problem(409, 'question_confirmed_decision_required'));
  const confirmed = confirm(run, proposed);
  const resolved = run<Question>('question.resolve', { questionId: opened.questionId, expectedRevision: 1, decision: reference(confirmed) });
  assert.equal(resolved.status, 'resolved');
  assert.throws(() => run('question.save', { projectId, questionId: opened.questionId, expectedRevision: 2, ...content }),
    problem(409, 'question_resolved'));
  const replacement = run<Decision>('decision.propose', {
    projectId, decisionId: proposed.decisionId, expectedRevision: 2, ...content, body: '作者改判，她登上了船。',
  });
  const rejudged = confirm(run, replacement);
  assert.deepEqual(run('question.read', { questionId: opened.questionId }), resolved);
  const updated = run<Question>('question.resolve', { questionId: opened.questionId, expectedRevision: 2, decision: reference(rejudged) });
  assert.equal(updated.revision, 3);
  assert.deepEqual(run('question.read', { questionId: opened.questionId, revision: 2 }), resolved);
  assert.deepEqual(run('decision.read', reference(confirmed)), confirmed);
  const reopened = run<Question>('question.reopen', { questionId: opened.questionId, expectedRevision: 3 });
  assert.equal(reopened.status, 'open');
  assert.equal('resolution' in reopened, false);
  const edited = run<Question>('question.save', {
    projectId, questionId: opened.questionId, expectedRevision: 4, title: opened.title, body: '重新考虑下一场。',
  });
  assert.equal(edited.revision, 5);
  assert.deepEqual(run<List<Question>>('question.revisions', { questionId: opened.questionId }).items.map(({ status }) => status),
    ['open', 'open', 'resolved', 'resolved', 'open']);
  assert.equal(run<List<Question>>('question.list', { projectId, status: 'resolved' }).items.length, 0);
  assert.equal(run<List<Question>>('question.list', { projectId, status: 'open' }).items[0].revision, 5);
  assert.equal(db.prepare('SELECT revision FROM story_context_scopes').get()?.revision, 9);
});

test('context revisions reconstruct pending and confirmed state across new sessions and stable pagination', t => {
  const { db, run, projectId } = setup(t);
  const empty = run<StoryContext>('story.context', { projectId });
  assert.equal(empty.revision, 0);
  assert.deepEqual(db.prepare('SELECT * FROM story_context_scopes').all(), []);
  const first = run<Decision>('decision.propose', { projectId, ...content });
  const approved = confirm(run, first);
  run('question.save', { projectId, title: '谁在码头', body: '角色待定。' });
  const original = run<StoryContext>('story.context', { projectId, limit: 1 });
  for (let i = 0; i < 3; i++) run('decision.propose', { projectId, title: `提案 ${i}`, body: `方案 ${i}` });
  run('decision.propose', { projectId, decisionId: first.decisionId, expectedRevision: 2, ...content, body: '稍后提出的改动。' });
  const later = client(db, 'another-session');
  assert.deepEqual(later.run('story.context', { projectId, contextRevision: original.revision, limit: 1 }), original);
  assert.deepEqual(later.run('story.context', { projectId, contextRevision: 0 }), empty);
  const current = later.run<StoryContext>('story.context', { projectId, limit: 2 });
  assert.equal(current.pendingDecisions.hasMore, true);
  assert.equal(current.confirmedDecisions.items[0].revision, approved.revision);
  const page = later.run<StoryContext>('story.context', { projectId, contextRevision: current.revision, limit: 2, offset: 2 });
  assert.equal(page.pendingDecisions.hasMore, false);
  assert.equal(new Set([...current.pendingDecisions.items, ...page.pendingDecisions.items].map(({ decisionId }) => decisionId)).size, 4);
  assert.throws(() => run('story.context', { projectId, contextRevision: current.revision + 1 }), problem(404, 'story_context_revision_not_found'));
});

test('project, mainline, sibling IF and nested IF decisions and answers stay isolated', t => {
  const { db, run, projectId } = setup(t);
  const other = run<Project>('project.create', { title: '南港' });
  const chapter = run<{ chapterId: string }>('chapter.create', { projectId, title: '夜渡' });
  const main = run<Scene>('scene.create', { title: '港口' });
  run('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [main.sceneId] });
  const fork = () => run<Scene>('scene.branch', { sceneId: main.sceneId, revision: 1, divergence: '她留下来。', branchName: 'IF' });
  const a = fork();
  const b = fork();
  const nested = run<Scene>('scene.branch', { sceneId: a.sceneId, revision: 1, divergence: '第三种去向。', branchName: '嵌套 IF' });
  const scopes = [{ projectId }, { projectId, branchId: a.sceneId }, { projectId, branchId: b.sceneId },
    { projectId, branchId: nested.sceneId }, { projectId: other.projectId }];
  const decisions = scopes.map(scope => confirm(run, run<Decision>('decision.propose', { ...scope, ...content })));
  scopes.forEach((scope, index) => {
    const context = run<StoryContext>('story.context', scope);
    assert.equal(context.revision, 2);
    assert.deepEqual(context.confirmedDecisions.items.map(({ decisionId }) => decisionId), [decisions[index].decisionId]);
    const question = run<Question>('question.save', { ...scope, ...content });
    assert.throws(() => run('question.resolve', {
      questionId: question.questionId, expectedRevision: 1, decision: reference(decisions[(index + 1) % decisions.length]),
    }), problem(409, 'story_scope_mismatch'));
  });
  assert.throws(() => run('decision.propose', {
    projectId, branchId: b.sceneId, decisionId: decisions[1].decisionId, expectedRevision: 2, ...content,
  }), problem(409, 'story_scope_mismatch'));
  assert.throws(() => run('decision.propose', { projectId: other.projectId, branchId: nested.sceneId, ...content }),
    problem(409, 'story_project_mismatch'));
  assert.throws(() => run('story.context', { projectId, branchId: 'missing' }), problem(404, 'branch_not_found'));
  assert.throws(() => run('decision.propose', { projectId, basis: { scene: { sceneId: a.sceneId, revision: 1 } }, ...content }),
    problem(409, 'story_basis_branch_mismatch'));
  assert.throws(() => run('decision.propose', { projectId: other.projectId, basis: { scene: { sceneId: main.sceneId, revision: 1 } }, ...content }),
    problem(409, 'story_project_mismatch'));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('pinned source ranges, scene adoption and checkpoints survive later source and story edits', t => {
  const { db, run, projectId } = setup(t);
  const text = '停船。🛶 停船。';
  const source = run<{ sourceId: string }>('source.create', { title: '码头记录', kind: 'setting', body: text });
  const start = text.lastIndexOf('停船。');
  const pin = { sourceId: source.sourceId, revision: 1, excerpt: '停船。', range: { start, end: text.length } };
  const main = run<Scene>('scene.create', { title: '渡口' });
  const draft = run<Draft>('draft.create', { sceneId: main.sceneId, sceneRevision: 1, title: '初稿', body: '她留在码头。' });
  const adopted = run<Scene>('scene.adopt', { sceneId: main.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
  const original = run<Decision>('decision.propose', { projectId, ...content, basis: { sources: [pin], scene: { sceneId: main.sceneId, revision: adopted.revision } } });
  const fork = run<Scene>('scene.branch', { sceneId: main.sceneId, revision: adopted.revision, divergence: '她上了船。', branchName: '离港' });
  const checkpoint = run<Branch>('branch.save', { branchId: fork.sceneId, expectedRevision: 1, sceneId: fork.sceneId, sceneRevision: 1, note: '从这里继续。' });
  const onBranch = run<Decision>('decision.propose', { projectId, branchId: fork.sceneId, ...content,
    basis: { sources: [pin], checkpoint: { branchId: fork.sceneId, revision: checkpoint.revision } } });
  const oldContext = run<StoryContext>('story.context', { projectId, branchId: fork.sceneId, checkpointRevision: checkpoint.revision });
  run('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '船已离开。' });
  run('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: '修改后的不同结局。' });
  run('scene.adopt', { sceneId: main.sceneId, expectedRevision: adopted.revision, draftId: draft.draftId, draftRevision: 2 });
  run('branch.save', { branchId: fork.sceneId, expectedRevision: checkpoint.revision, sceneId: fork.sceneId, sceneRevision: 1, note: '后来的断点。' });
  const confirmed = confirm(run, original);
  assert.deepEqual(confirmed.basis, original.basis);
  assert.deepEqual(confirmed.basis.sources[0].range, pin.range);
  assert.equal(confirmed.basis.scene?.adopted?.body, draft.body);
  assert.equal(confirmed.basis.scene?.adopted?.revision, 1);
  assert.deepEqual(run('decision.read', reference(onBranch)), onBranch);
  assert.deepEqual(run('story.context', { projectId, branchId: fork.sceneId, contextRevision: oldContext.revision, checkpointRevision: checkpoint.revision }), oldContext);
  assert.throws(() => run('decision.propose', { projectId, ...content, basis: { sources: [{ sourceId: pin.sourceId, revision: 2, excerpt: pin.excerpt }] } }), problem(400, 'source_excerpt_mismatch'));
  assert.throws(() => run('decision.propose', { projectId, ...content, basis: { sources: [{ ...pin, range: { start: 0, end: 2 } }] } }), problem(400, 'source_excerpt_mismatch'));
  assert.throws(() => run('decision.propose', { projectId, ...content, basis: { checkpoint: { branchId: fork.sceneId, revision: 2 } } }), problem(409, 'story_basis_branch_mismatch'));
  assert.throws(() => run('story.context', { projectId, checkpointRevision: 2 }), problem(400, 'story_checkpoint_branch_required'));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('failed writes leave versions, context sequence and receipts unchanged and historical rows reject rewrites', t => {
  const { db, core, run, projectId } = setup(t);
  const proposal = run<Decision>('decision.propose', { projectId, ...content });
  const confirmed = confirm(run, proposal);
  const question = run<Question>('question.save', { projectId, ...content });
  const before = run<StoryContext>('story.context', { projectId });
  assert.throws(() => run('decision.propose', { projectId, decisionId: proposal.decisionId, expectedRevision: 1, ...content }, 'stale'), problem(409, 'decision_revision_conflict'));
  assert.throws(() => core.receipt('author', { operationId: 'decision.propose', stepId: 'stale' }), problem(404, 'operation_receipt_not_found'));
  db.exec(`CREATE TRIGGER fail_story_receipt BEFORE INSERT ON operation_receipts
    WHEN NEW.step_id = 'fail-after-write' BEGIN SELECT RAISE(ABORT, 'Simulated receipt failure'); END`);
  assert.throws(() => run('question.resolve', { questionId: question.questionId, expectedRevision: 1, decision: reference(confirmed) }, 'fail-after-write'), /Simulated receipt failure/);
  assert.deepEqual(run('question.read', { questionId: question.questionId }), question);
  assert.deepEqual(run('story.context', { projectId }), before);
  for (const table of ['story_decisions', 'story_decision_revisions', 'story_questions', 'story_question_revisions']) {
    const key = table.includes('question') ? 'question_id' : 'decision_id';
    assert.throws(() => db.exec(`UPDATE ${table} SET ${key} = ${key}`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/);
  }
  assert.throws(() => db.prepare(`INSERT INTO story_question_revisions
    (question_id, revision, context_revision, status, title, body, basis_json, created_at, decision_id, decision_revision)
    VALUES (?, 2, 4, 'resolved', 'Question', 'Body', '{"sources":[]}', 'now', ?, 1)`).run(question.questionId, proposal.decisionId),
    /Resolution must pin a confirmed version/);
  assert.throws(() => db.prepare(`INSERT INTO story_decision_revisions
    (decision_id, revision, context_revision, status, title, body, basis_json, created_at, proposal_revision, confirmed_by, confirmed_at)
    VALUES (?, 3, 4, 'confirmed', 'Tampered', 'Body', '{"sources":[]}', 'now', 1, 'Someone', 'now')`).run(proposal.decisionId),
    /Confirmation must pin an unchanged proposal/);
  assert.deepEqual(run('story.context', { projectId }), before);
});

async function raceWriters(directory: string, calls: { operationId: string; input: object }[]) {
  const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openDatabase } = await import(workerData.databaseModule);
      const { Operations } = await import(workerData.coreModule);
      const { workspaceOperations } = await import(workerData.workspaceModule);
      const db = openDatabase(workerData.directory);
      const core = new Operations(db, workspaceOperations);
      parentPort.once('message', () => {
        try {
          const result = core.invoke(workerData.namespace, { ...workerData.call, stepId: 'racing-write' });
          parentPort.postMessage({ ok: true, result });
        } catch (error) {
          parentPort.postMessage({ ok: false, code: error.code });
        } finally { db.close(); parentPort.close(); }
      });
      parentPort.postMessage('ready');
    })().catch(error => { throw error; });
  `;
  const workers = calls.map((call, index) => new Worker(script, { eval: true, workerData: {
    call, directory, namespace: `racer-${index}`,
    databaseModule: new URL('../src/database.ts', import.meta.url).href,
    coreModule: new URL('../src/core/index.ts', import.meta.url).href,
    workspaceModule: new URL('../src/workspace.ts', import.meta.url).href,
  } }));
  try {
    await Promise.all(workers.map(async worker => assert.equal((await once(worker, 'message'))[0], 'ready')));
    const results = workers.map(async worker => (await once(worker, 'message'))[0] as { ok: boolean; code?: string });
    workers.forEach(worker => worker.postMessage('go'));
    return await Promise.all(results);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

test('simultaneous confirmation and proposal serialize with exactly one winner and a durable receipt', { timeout: 25_000 }, async t => {
  let db: DatabaseSync;
  const directory = temporaryDirectory(t, () => db.close());
  db = openDatabase(directory);
  const { run, core } = client(db);
  const { projectId } = run<Project>('project.create', { title: '并发' });
  const proposal = run<Decision>('decision.propose', { projectId, ...content });
  const results = await raceWriters(directory, [
    { operationId: 'decision.confirm', input: { decisionId: proposal.decisionId, expectedRevision: 1, proposalRevision: 1, authorConfirmed: true, confirmedBy: '作者甲' } },
    { operationId: 'decision.propose', input: { projectId, decisionId: proposal.decisionId, expectedRevision: 1, ...content, body: '并发的提案' } },
  ]);
  assert.equal(results.filter(({ ok }) => ok).length, 1);
  assert.equal(results.find(({ ok }) => !ok)?.code, 'decision_revision_conflict');
  assert.equal(run<Decision>('decision.read', reference({ ...proposal, revision: 2 })).revision, 2);
  assert.equal(run<StoryContext>('story.context', { projectId }).revision, 2);
  results.forEach((result, index) => {
    const operationId = index === 0 ? 'decision.confirm' : 'decision.propose';
    if (result.ok) assert.equal(core.receipt(`racer-${index}`, { operationId, stepId: 'racing-write' }).replayed, true);
    else assert.throws(() => core.receipt(`racer-${index}`, { operationId, stepId: 'racing-write' }), problem(404, 'operation_receipt_not_found'));
  });
});

test('simultaneous question revision and resolution cannot close an unseen edited question', { timeout: 25_000 }, async t => {
  let db: DatabaseSync;
  const directory = temporaryDirectory(t, () => db.close());
  db = openDatabase(directory);
  const { run } = client(db);
  const { projectId } = run<Project>('project.create', { title: '并发问题' });
  const answer = confirm(run, run<Decision>('decision.propose', { projectId, ...content }));
  const question = run<Question>('question.save', { projectId, ...content });
  const results = await raceWriters(directory, [
    { operationId: 'question.save', input: { projectId, questionId: question.questionId, expectedRevision: 1, ...content, body: '另一个问题' } },
    { operationId: 'question.resolve', input: { questionId: question.questionId, expectedRevision: 1, decision: reference(answer) } },
  ]);
  assert.equal(results.filter(({ ok }) => ok).length, 1);
  assert.equal(results.find(({ ok }) => !ok)?.code, 'question_revision_conflict');
  assert.deepEqual(run('question.read', { questionId: question.questionId, revision: 1 }), question);
  assert.equal(run<StoryContext>('story.context', { projectId }).revision, 4);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const version of [2, 3, 4]) test(`format ${version} migration preserves legacy rows, tokens, pins and receipts on repeated opens`, t => {
  const directory = temporaryDirectory(t);
  const old = new DatabaseSync(join(directory, 'sth.sqlite'));
  const legacyDDL = version === 3 ? workspaceDDL.replace(storyDDL, sceneDDL) : workspaceDDL.replace(decisionsDDL, '');
  old.exec(operationsDDL + legacyDDL + connectionsDDL);
  old.exec(`PRAGMA application_id = 0x53746831; PRAGMA user_version = ${version}`);
  old.exec(`CREATE TABLE user_extension (id TEXT PRIMARY KEY, body BLOB) STRICT;
    INSERT INTO user_extension VALUES ('keep', x'00ff80');
    INSERT INTO connections VALUES ('old-connection', '助手', 'keep-this-token-digest', 'before', NULL)`);
  const originalInput = { title: '老作品' };
  const original = client(old, 'legacy').invoke('project.create', originalInput, 'original');
  const legacy = client(old, 'legacy-content');
  const source = legacy.run<{ sourceId: string }>('source.create', { title: '旧资料', body: '十点渡船。十点渡船。', kind: 'setting' });
  const sourcePin = { sourceId: source.sourceId, revision: 1, excerpt: '十点渡船。', range: { start: 5, end: 10 } };
  const diary = legacy.run<{ noteId: string }>('diary.create', {
    title: '旧日记', body: '引用后半句。', diaryDate: '2026-11-24', sourcePins: [sourcePin],
  });
  legacy.run('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '九点渡船。' });
  legacy.run('diary.revise', {
    noteId: diary.noteId, expectedRevision: 1, title: '旧日记修订', body: '正文改了，旧引用保留。', diaryDate: '2026-11-24',
  });
  const tables = old.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];
  const originalRows = tables.map(({ name }) => old.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
  old.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = openDatabase(directory);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, workspaceSchemaVersion);
      assert.equal(db.prepare('SELECT version FROM story_decisions_schema').get()?.version, decisionSchemaVersion);
      assert.equal(db.prepare('SELECT digest FROM connections').get()?.digest, 'keep-this-token-digest');
      assert.deepEqual(db.prepare('SELECT body FROM user_extension').get()?.body, new Uint8Array([0, 255, 128]));
      assert.deepEqual(client(db, 'legacy').invoke('project.create', originalInput, 'original'), { ...original, replayed: true });
      tables.forEach(({ name, sql }, index) => {
        assert.equal(db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(name)?.sql, sql);
        assert.deepEqual(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(), originalRows[index]);
      });
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  }
});

test('new databases and reopened decision history support exact replay and old context reconstruction', t => {
  let db: DatabaseSync;
  const directory = temporaryDirectory(t, () => db.close());
  db = openDatabase(directory);
  let caller = client(db);
  const { projectId } = caller.run<Project>('project.create', { title: '新库' });
  const input = { projectId, ...content };
  const original = caller.invoke('decision.propose', input, 'original');
  const approved = confirm(caller.run, original.result as Decision);
  const oldContext = caller.run<StoryContext>('story.context', { projectId });
  caller.run('decision.propose', { ...input, decisionId: approved.decisionId, expectedRevision: approved.revision, body: '后续提案' });
  db.close();
  db = openDatabase(directory);
  caller = client(db);
  assert.deepEqual(caller.invoke('decision.propose', input, 'original'), { ...original, replayed: true });
  assert.deepEqual(caller.run('story.context', { projectId, contextRevision: oldContext.revision }, 'reconstruct-after-reopen'), oldContext);
  assert.deepEqual(caller.run('decision.read', reference(approved), 'read-confirmation-after-reopen'), approved);
  assert.throws(() => caller.invoke('decision.propose', { ...input, body: '不同的请求' }, 'original'), problem(409, 'operation_step_conflict'));
});

test('migration failures roll back DDL, version changes and user data in one transaction', t => {
  const directory = temporaryDirectory(t);
  const old = new DatabaseSync(join(directory, 'sth.sqlite'));
  old.exec(operationsDDL + workspaceDDL.replace(decisionsDDL, '') + connectionsDDL);
  old.exec(`PRAGMA application_id=0x53746831; PRAGMA user_version=3;
    INSERT INTO library_projects VALUES ('keep', '原作品');
    CREATE TABLE story_questions (question_id TEXT PRIMARY KEY) STRICT`);
  const before = old.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all();
  old.close();
  assert.throws(() => openDatabase(directory), /project_id/);
  const checked = new DatabaseSync(join(directory, 'sth.sqlite'), { readOnly: true });
  try {
    assert.equal(checked.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.deepEqual(checked.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all(), before);
    assert.equal(checked.prepare('SELECT title FROM library_projects').get()?.title, '原作品');
  } finally { checked.close(); }
});

test('foreign key corruption and unsupported workspace or story versions are rejected without rewriting', t => {
  for (const mode of ['foreign-key', 'future-story', 'future-workspace', 'old-workspace', 'wrong-app'] as const) {
    const directory = temporaryDirectory(t);
    const old = new DatabaseSync(join(directory, 'sth.sqlite'));
    old.exec(operationsDDL + workspaceDDL.replace(decisionsDDL, '') + connectionsDDL);
    old.exec(`PRAGMA application_id=0x53746831; PRAGMA user_version=4`);
    if (mode === 'foreign-key') old.exec("PRAGMA foreign_keys=OFF; INSERT INTO library_characters (character_id, project_id) VALUES ('orphan', 'missing')");
    if (mode === 'future-story') old.exec('CREATE TABLE story_decisions_schema (singleton INTEGER PRIMARY KEY, version INTEGER); INSERT INTO story_decisions_schema VALUES (1, 9)');
    if (mode === 'future-workspace') old.exec('PRAGMA user_version=99');
    if (mode === 'old-workspace') old.exec('PRAGMA user_version=1');
    if (mode === 'wrong-app') old.exec('PRAGMA application_id=123');
    const before = old.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all();
    const originalVersion = old.prepare('PRAGMA user_version').get()?.user_version;
    old.close();
    assert.throws(() => openDatabase(directory), mode === 'foreign-key' ? /Foreign key check failed/ : /Unsupported/);
    const checked = new DatabaseSync(join(directory, 'sth.sqlite'), { readOnly: true });
    try {
      assert.equal(checked.prepare('PRAGMA user_version').get()?.user_version, originalVersion);
      assert.deepEqual(checked.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all(), before);
    } finally { checked.close(); }
  }
  const db = new DatabaseSync(':memory:');
  try { assert.throws(() => migrateDecisions(db), /startup transaction/); } finally { db.close(); }
});

test('web author and paired sessions discover and share the same versioned decision operations', async t => {
  const { db } = setup(t);
  const app = createApp(db);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    const closed = once(app, 'close');
    app.close(); app.closeAllConnections(); await closed;
  });
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, data: object, token?: string) => {
    const result = await fetch(origin + path, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(data) });
    assert.equal(result.status, 200, await result.clone().text());
    return result.json();
  };
  const { code } = await post('/api/web/connections/code', {});
  const { token } = await post('/api/v1/personal-operations/claim', { code, clientName: '另一个写作会话' });
  const invoke = async (operationId: string, input: object, token?: string) => (await post(
    token ? '/api/v1/personal-operations/invoke' : '/api/web/invoke', { operationId, input, stepId: crypto.randomUUID() }, token,
  )).result;
  const project = await invoke('project.create', { title: '共享作品' });
  const proposed = await invoke('decision.propose', { projectId: project.projectId, ...content }, token);
  const approved = await invoke('decision.confirm', { decisionId: proposed.decisionId, expectedRevision: 1, proposalRevision: 1, authorConfirmed: true, confirmedBy: '作者甲' });
  const context = await invoke('story.context', { projectId: project.projectId }, token) as StoryContext;
  assert.equal(context.confirmedDecisions.items[0].revision, approved.revision);
  assert.equal(context.pendingDecisions.items.length, 0);
  const catalog = await post('/api/v1/personal-operations/catalog', { prefix: 'decision', view: 'index' }, token);
  assert.equal(catalog.operations.length, 5);
});
