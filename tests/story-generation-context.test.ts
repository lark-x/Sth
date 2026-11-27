import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { connectionsDDL } from '../src/connections.ts';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { openDatabase } from '../src/database.ts';
import { maxAuthorContextBytes, maxAuthorContextItems } from '../src/generation/author-context-contracts.ts';
import type { Generation, Plan, PromptInspection, PromptPage } from '../src/generation/contracts.ts';
import { processNextGeneration } from '../src/generation/index.ts';
import type { Scene } from '../src/story/contracts.ts';
import type { Branch, Decision, Event, Narrative, Question, StoryContext } from '../src/story/index.ts';
import { workspaceDDL, workspaceOperations } from '../src/workspace.ts';

const brief = { title: '北港', brief: '按选定版本续写。', templateId: 'short-story' };
const problem = (code: string) => ({ name: 'OperationError', code });

function client(db: DatabaseSync, namespace = 'generation-context') {
  const ops = new Operations(db, workspaceOperations);
  let step = 0;
  function call<T>(operationId: string, input: unknown, stepId = `step-${++step}`): T {
    return ops.invoke(namespace, { operationId, stepId, input }).result as T;
  }
  const inspect = ({ generationId }: { generationId: string }) => call<PromptInspection>('generations.prompt', { generationId });
  const confirm = (proposal: Decision) => call<Decision>('decision.confirm', {
    decisionId: proposal.decisionId, expectedRevision: proposal.revision, proposalRevision: proposal.revision,
    authorConfirmed: true, confirmedBy: '测试作者',
  });
  return { ops, call, inspect, confirm };
}

function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(operationsDDL + workspaceDDL + connectionsDDL);
  t.after(() => db.close());
  const caller = client(db);
  const { projectId } = caller.call<{ projectId: string }>('project.create', { title: '北港作品' });
  return { db, ...caller, projectId };
}

function snapshot(trace: PromptInspection, path: string) {
  const row = trace.provenance.find(item => item.path === path);
  assert.ok(row && row.start !== undefined && row.end !== undefined, path);
  const part = trace.messages[row.messageIndex].parts[row.partIndex];
  assert.ok(part.type === 'text');
  return { row, value: JSON.parse(part.text.slice(row.start, row.end)) };
}

function expectPrepareError(db: DatabaseSync, call: ReturnType<typeof client>['call'], input: object, code: string) {
  const counts = () => [db.prepare('SELECT count(*) AS n FROM generation_records').get()?.n,
    db.prepare('SELECT count(*) AS n FROM operation_receipts').get()?.n];
  const before = counts();
  assert.throws(() => call('generations.prepare', { ...brief, ...input }), problem(code));
  assert.deepEqual(counts(), before, 'failed prepare must save neither a generation nor a receipt');
  assert.equal(db.isTransaction, false);
}

function telling(call: ReturnType<typeof client>['call'], scene: Scene, viewpoint: object = { kind: 'omniscient' }, events: Event[] = []) {
  const pins = events.map(({ eventId, revision }) => ({ eventId, revision }));
  return call<Narrative>('narrative.save', { title: '选定讲法', sceneId: scene.sceneId, sceneRevision: scene.revision,
    viewpoint, eventOrder: pins, knownEvents: pins });
}

function storyRef({ narrativeId, revision, branchId }: Narrative) { return { narrativeId, revision, branchId }; }

test('author context requires an exact complete scope and supports empty revision zero', t => {
  const { db, call, inspect, projectId } = setup(t);
  const authorContext = { projectId, branchId: null, contextRevision: 0 };
  const prepared = call<Generation>('generations.prepare', { ...brief, authorContext });
  assert.equal(prepared.composition.projectId, projectId);
  assert.deepEqual(prepared.composition.authorContext, { ...authorContext, policy: 'full',
    confirmedDecisions: [], pendingDecisions: [], openQuestions: [], resolvedQuestions: [] });
  assert.equal(snapshot(inspect(prepared), '/authorContext').row.contextRevision, 0);
  assert.equal(inspect(prepared).provenance[0].revision, 4);
  for (const invalid of [{ projectId, contextRevision: 0 }, { branchId: null, contextRevision: 0 }, { projectId, branchId: null },
    { ...authorContext, contextRevision: -1 }, { ...authorContext, contextRevision: 0.5 },
    { ...authorContext, contextRevision: 'latest' }, { ...authorContext, contextRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...authorContext, policy: 'full' }]) {
    expectPrepareError(db, call, { authorContext: invalid }, 'operation_invalid_input');
  }
  expectPrepareError(db, call, { authorContext: { ...authorContext, contextRevision: 1 } }, 'story_context_revision_not_found');
  expectPrepareError(db, call, { authorContext: { ...authorContext, projectId: 'missing' } }, 'project_not_found');
  expectPrepareError(db, call, { authorContext: { ...authorContext, branchId: 'missing' } }, 'branch_not_found');
});

test('confirmed constraints coexist with pending proposals and trace exact proposal and historical answer versions', t => {
  const { call, inspect, confirm, projectId } = setup(t);
  const proposal = call<Decision>('decision.propose', { projectId, title: '去向', body: '已确认方案甲。' });
  const approved = confirm(proposal);
  const question = call<Question>('question.save', { projectId, title: '是否出发', body: '等待作者选择。' });
  call('question.resolve', { questionId: question.questionId, expectedRevision: 1,
    decision: { decisionId: approved.decisionId, revision: approved.revision } });
  const replacement = call<Decision>('decision.propose', { projectId, decisionId: approved.decisionId,
    expectedRevision: approved.revision, title: '去向', body: '作者改判方案乙。' });
  const rejudged = confirm(replacement);
  const pending = call<Decision>('decision.propose', { projectId, decisionId: approved.decisionId,
    expectedRevision: rejudged.revision, title: '去向', body: 'AI 新提案丙，尚未确认。' });
  call('question.save', { projectId, title: '可能藏着什么', body: '这些猜测仍待作者裁决。' });
  const { revision } = call<StoryContext>('story.context', { projectId });
  const prepared = call<Generation>('generations.prepare', { ...brief, authorContext: { projectId, branchId: null, contextRevision: revision } });
  const context = prepared.composition.authorContext!;
  assert.equal(context.policy, 'full');
  assert.deepEqual(context.confirmedDecisions.map(item => [item.decisionId, item.revision, item.body]), [[approved.decisionId, 4, rejudged.body]]);
  assert.deepEqual(context.pendingDecisions.map(item => [item.decisionId, item.revision]), [[pending.decisionId, 5]]);
  assert.deepEqual(context.resolvedQuestions[0].resolution, { decisionId: approved.decisionId, revision: 2 });
  assert.equal(context.openQuestions.length, 1);
  assert.ok(!JSON.stringify(context).includes('basis'));
  const trace = inspect(prepared);
  const system = trace.messages[0].parts[0];
  assert.ok(system.type === 'text');
  assert.match(system.text, /confirmedDecisions as binding author constraints/);
  assert.match(system.text, /pendingDecisions and authorContext.openQuestions are unconfirmed planning material, not established facts/);
  assert.match(system.text, /Do not promote their suggestions or assumptions into story facts/);
  assert.match(system.text, /historical answer versions and does not override the effective confirmed decisions/);
  assert.match(system.text, /Never use author context to reveal a secret outside the viewpoint knowledge/);
  assert.deepEqual(snapshot(trace, '/authorContext').value, context);
  const confirmation = snapshot(trace, '/authorContext/confirmedDecisions/0/body');
  assert.equal(confirmation.value, rejudged.body);
  assert.equal(confirmation.row.kind, 'author-context');
  assert.equal(confirmation.row.referenceKind, 'decision');
  assert.equal(confirmation.row.contextRevision, revision);
  assert.deepEqual(confirmation.row.target, { kind: 'decision', id: approved.decisionId, revision: 4 });
  assert.deepEqual(snapshot(trace, '/authorContext/confirmedDecisions/0/confirmation/proposalRevision').row.target,
    { kind: 'decision', id: approved.decisionId, revision: 3 });
  const answer = snapshot(trace, '/authorContext/resolvedQuestions/0/resolution');
  assert.equal(answer.row.referenceKind, 'question');
  assert.equal(answer.row.id, question.questionId);
  assert.equal(answer.row.revision, 2);
  assert.deepEqual(answer.row.target, { kind: 'decision', id: approved.decisionId, revision: 2 });
});

test('two author rejudgments preserve saved and reconstructed compositions through reopen and delegation dispatch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-generation-context-'));
  let db = openDatabase(directory);
  t.after(() => { db.close(); rmSync(directory, { force: true, recursive: true }); });
  let caller = client(db, 'first-session');
  const { projectId } = caller.call<{ projectId: string }>('project.create', { title: '持久化作品' });
  const source = caller.call<{ sourceId: string }>('source.create', { title: '记录', kind: 'excerpt', body: '旧依据。' });
  const scene = caller.call<Scene>('scene.create', { title: '港口' });
  const draft = caller.call<{ draftId: string }>('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title: '初稿', body: '旧采纳正文。' });
  const adopted = caller.call<Scene>('scene.adopt', { sceneId: scene.sceneId, expectedRevision: 1, draftId: draft.draftId, draftRevision: 1 });
  const basis = { scene: { sceneId: scene.sceneId, revision: adopted.revision },
    sources: [{ sourceId: source.sourceId, revision: 1, excerpt: '旧依据。' }] };
  let decision = caller.confirm(caller.call<Decision>('decision.propose', { projectId, title: '结局', body: '原判，留在北港。', basis }));
  const question = caller.call<Question>('question.save', { projectId, title: '去向', body: '选择结局。' });
  caller.call('question.resolve', { questionId: question.questionId, expectedRevision: 1,
    decision: { decisionId: decision.decisionId, revision: decision.revision } });
  const originalDecision = decision;
  const originalRevision = caller.call<StoryContext>('story.context', { projectId }).revision;
  const input = { ...brief, authorContext: { projectId, branchId: null, contextRevision: originalRevision } };
  const first = caller.call<Generation>('generations.prepare', input, 'original-prepare');
  const trace = caller.inspect(first);
  const savedBytes = db.prepare('SELECT composition_json FROM generation_records WHERE generation_id = ?').get(first.generationId)?.composition_json;
  for (const [index, body] of ['第一次改判，登船。', '第二次改判，转向南岸。'].entries()) {
    decision = caller.confirm(caller.call<Decision>('decision.propose', { projectId, decisionId: decision.decisionId,
      expectedRevision: decision.revision, title: '结局', body }));
    const revision = caller.call<StoryContext>('story.context', { projectId }).revision;
    const latest = caller.call<Generation>('generations.prepare', { ...input, authorContext: { ...input.authorContext, contextRevision: revision } });
    assert.equal(latest.composition.authorContext?.confirmedDecisions[0].revision, 4 + index * 2);
    assert.equal(latest.composition.authorContext?.confirmedDecisions[0].body, body);
    assert.deepEqual(latest.composition.authorContext?.resolvedQuestions[0].resolution, { decisionId: decision.decisionId, revision: 2 });
    assert.deepEqual(caller.call<Generation>('generations.prepare', input).composition, first.composition);
    assert.deepEqual(caller.inspect(first), trace);
  }
  caller.call('source.revise', { sourceId: source.sourceId, expectedRevision: 1, body: '后来的依据。' });
  caller.call('draft.revise', { draftId: draft.draftId, expectedRevision: 1, body: '后来的正文。' });
  caller.call('scene.adopt', { sceneId: scene.sceneId, expectedRevision: adopted.revision, draftId: draft.draftId, draftRevision: 2 });
  db.close();
  db = openDatabase(directory);
  caller = client(db, 'reopened-session');
  assert.deepEqual(caller.call<Generation>('generations.get', { generationId: first.generationId }), first);
  assert.deepEqual(caller.call<Generation>('generations.prepare', input).composition, first.composition);
  assert.deepEqual(caller.inspect(first), trace);
  assert.deepEqual(caller.call('decision.read', { decisionId: decision.decisionId, revision: 2 }), originalDecision);
  assert.equal(db.prepare('SELECT composition_json FROM generation_records WHERE generation_id = ?').get(first.generationId)?.composition_json, savedBytes);
  const replay = caller.ops.receipt('first-session', { operationId: 'generations.prepare', stepId: 'original-prepare' });
  assert.deepEqual(replay.result, first);
  const plan = caller.call<Plan>('generation.plans.create', { title: '固定委托', executor: 'openai-compatible',
    provider: 'fixture', model: 'fixture-model', parameters: {} });
  const delegated = caller.call<{ generationId: string }>('generations.start', { generationId: first.generationId, planId: plan.planId });
  assert.deepEqual(caller.inspect(delegated).messages, trace.messages);
  assert.deepEqual(caller.inspect(delegated).provenance, trace.provenance);
  let sent = false;
  assert.equal(await processNextGeneration(db, { prepare(request) {
    assert.deepEqual(request.messages, first.composition.messages);
    const user = request.messages[1].content;
    assert.ok(typeof user === 'string');
    assert.deepEqual(JSON.parse(user).authorContext, first.composition.authorContext);
    return { async execute() {
      sent = true;
      return { content: JSON.stringify({ opening: '夜。', development: '风起。', ending: '归港。' }),
        reportedModel: 'fixture-model', responseId: null, finishReason: 'stop' };
    } };
  } }), true);
  assert.equal(sent, true);
  assert.equal(caller.call<Generation>('generations.get', { generationId: delegated.generationId }).status, 'succeeded');
  assert.deepEqual(caller.inspect(delegated).messages, trace.messages);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('generation, telling and explicit scene or draft references enforce project and IF scope atomically', t => {
  const { db, call, projectId } = setup(t);
  const other = call<{ projectId: string }>('project.create', { title: '另一作品' });
  const scene = call<Scene>('scene.create', { title: '已归属场景' });
  const chapter = call<{ chapterId: string }>('chapter.create', { projectId, title: '第一章' });
  call('chapter.arrange', { chapterId: chapter.chapterId, expectedRevision: 1, sceneIds: [scene.sceneId] });
  const main = telling(call, scene);
  const draft = call<{ draftId: string }>('draft.create', { title: '草稿', body: '正文。', sceneId: scene.sceneId, sceneRevision: 1 });
  const left = call<Scene>('scene.branch', { sceneId: scene.sceneId, revision: 1, divergence: '左侧 IF' });
  const right = call<Scene>('scene.branch', { sceneId: scene.sceneId, revision: 1, divergence: '右侧 IF' });
  const leftTelling = telling(call, left);
  const rightDraft = call<{ draftId: string }>('draft.create', { title: '右侧草稿', body: '右侧秘密。', sceneId: right.sceneId, sceneRevision: 1 });
  const authorContext = { projectId, branchId: null, contextRevision: 0 };
  expectPrepareError(db, call, { projectId: other.projectId, authorContext }, 'generation_author_context_project_mismatch');
  for (const references of [[{ kind: 'scene', id: scene.sceneId, revision: 1 }], [{ kind: 'draft', id: draft.draftId, revision: 1 }]]) {
    expectPrepareError(db, call, { references, authorContext: { ...authorContext, projectId: other.projectId } }, 'generation_author_context_project_mismatch');
  }
  expectPrepareError(db, call, { story: storyRef(main), authorContext: { ...authorContext, projectId: other.projectId } }, 'generation_author_context_project_mismatch');
  expectPrepareError(db, call, { story: storyRef(leftTelling), authorContext }, 'generation_author_context_branch_mismatch');
  expectPrepareError(db, call, { story: storyRef(main), authorContext: { ...authorContext, branchId: left.sceneId } }, 'generation_author_context_branch_mismatch');
  expectPrepareError(db, call, { authorContext: { ...authorContext, branchId: left.sceneId },
    references: [{ kind: 'draft', id: rightDraft.draftId, revision: 1 }] }, 'generation_reference_branch_mismatch');
  expectPrepareError(db, call, { authorContext, references: [{ kind: 'scene', id: right.sceneId, revision: 1 }] }, 'generation_reference_branch_mismatch');
  expectPrepareError(db, call, { authorContext: { ...authorContext, projectId: other.projectId, branchId: left.sceneId } }, 'story_project_mismatch');
  for (const scope of [{ projectId, branchId: null }, { projectId, branchId: left.sceneId }, { projectId, branchId: right.sceneId },
    { projectId: other.projectId, branchId: null }]) {
    call('decision.propose', { ...scope, title: `范围 ${scope.branchId ?? scope.projectId}`, body: JSON.stringify(scope) });
  }
  const prepared = call<Generation>('generations.prepare', { ...brief, story: storyRef(leftTelling),
    authorContext: { ...authorContext, branchId: left.sceneId, contextRevision: 1 } });
  assert.equal(prepared.composition.authorContext?.pendingDecisions.length, 1);
  assert.equal(prepared.composition.authorContext?.pendingDecisions[0].branchId, left.sceneId);
  assert.ok(!JSON.stringify(prepared).includes(right.sceneId));
});

test('character viewpoint withholds all author sections and metadata while retaining only its pinned checkpoint state', t => {
  const { db, call, inspect, confirm, projectId } = setup(t);
  const main = call<Scene>('scene.create', { title: '港口' });
  const fork = call<Scene>('scene.branch', { sceneId: main.sceneId, revision: 1, divergence: 'SECRET_DIVERGENCE' });
  const scope = { projectId, branchId: fork.sceneId };
  const lin = call<{ characterId: string }>('character.create', { name: '林', description: 'SECRET_CHARACTER_CARD' });
  const tao = call<{ characterId: string }>('character.create', { name: 'SECRET_OTHER_CHARACTER' });
  const source = call<{ sourceId: string }>('source.create', { title: 'SECRET_SOURCE_TITLE', kind: 'excerpt', body: 'SECRET_SOURCE_BODY' });
  const visible = call<Event>('event.save', { branchId: fork.sceneId, title: '钟声', summary: '她听见钟声。' });
  const pov = telling(call, fork, { kind: 'character', characterId: lin.characterId, revision: 1 }, [visible]);
  const checkpoint = call<Branch>('branch.save', { branchId: fork.sceneId, expectedRevision: 1,
    sceneId: fork.sceneId, sceneRevision: 1, narrative: { narrativeId: pov.narrativeId, revision: 1 }, note: 'SECRET_AUTHOR_NOTE',
    characterStates: [{ characterId: lin.characterId, revision: 1, state: '她手握船票。' },
      { characterId: tao.characterId, revision: 1, state: 'SECRET_OTHER_STATE' }] });
  const basis = { sources: [{ sourceId: source.sourceId, revision: 1, excerpt: 'SECRET_SOURCE_BODY' }],
    checkpoint: { branchId: fork.sceneId, revision: checkpoint.revision } };
  const approved = confirm(call<Decision>('decision.propose', { ...scope, title: 'SECRET_CONFIRMED_TITLE', body: 'SECRET_CONFIRMED_BODY', basis }));
  const pending = call<Decision>('decision.propose', { ...scope, title: 'SECRET_PENDING_TITLE', body: 'SECRET_PENDING_BODY', basis });
  const opened = call<Question>('question.save', { ...scope, title: 'SECRET_OPEN_TITLE', body: 'SECRET_OPEN_BODY', basis });
  const resolved = call<Question>('question.save', { ...scope, title: 'SECRET_RESOLVED_TITLE', body: 'SECRET_RESOLVED_BODY', basis });
  call('question.resolve', { questionId: resolved.questionId, expectedRevision: 1, decision: { decisionId: approved.decisionId, revision: 2 } });
  const { revision } = call<StoryContext>('story.context', scope);
  const authorContext = { ...scope, contextRevision: revision };
  const input = { ...brief, authorContext, story: { ...storyRef(pov), checkpointRevision: checkpoint.revision } };
  const prepared = call<Generation>('generations.prepare', input);
  const trace = inspect(prepared);
  assert.deepEqual(prepared.composition.authorContext, { ...authorContext, policy: 'withheld-for-character-viewpoint',
    confirmedDecisions: [], pendingDecisions: [], openQuestions: [], resolvedQuestions: [] });
  assert.equal(prepared.composition.story?.checkpoint?.characterState?.state, '她手握船票。');
  assert.doesNotMatch(JSON.stringify([prepared, trace]), /SECRET_|测试作者/);
  for (const hidden of [approved.decisionId, pending.decisionId, opened.questionId, resolved.questionId, source.sourceId, tao.characterId]) {
    assert.ok(!JSON.stringify([prepared, trace]).includes(hidden), hidden);
  }
  assert.ok(trace.provenance.every(row => row.referenceKind !== 'decision' && row.referenceKind !== 'question'));
  const system = trace.messages[0].parts[0];
  assert.ok(system.type === 'text');
  assert.match(system.text, /empty sections do not establish that the author has made no decisions/);
  assert.match(system.text, /Use only the supplied story projection and its visible knowledge/);
  expectPrepareError(db, call, { ...input, authorContext: { ...authorContext, contextRevision: revision + 1 } }, 'story_context_revision_not_found');
  const omniscient = telling(call, fork);
  const full = call<Generation>('generations.prepare', { ...brief, authorContext, story: storyRef(omniscient) });
  assert.equal(full.composition.authorContext?.policy, 'full');
  assert.equal(full.composition.authorContext?.confirmedDecisions[0].decisionId, approved.decisionId);
  assert.equal(full.composition.authorContext?.pendingDecisions[0].decisionId, pending.decisionId);
  assert.equal(full.composition.authorContext?.openQuestions[0].questionId, opened.questionId);
  assert.equal(full.composition.authorContext?.resolvedQuestions[0].questionId, resolved.questionId);
  call('branch.save', { branchId: fork.sceneId, expectedRevision: checkpoint.revision, sceneId: fork.sceneId, sceneRevision: 1,
    narrative: { narrativeId: pov.narrativeId, revision: 1 }, note: 'SECRET_NEW_NOTE', characterStates: [] });
  call('decision.propose', { ...scope, decisionId: approved.decisionId, expectedRevision: 2, title: 'SECRET_NEW_TITLE', body: 'SECRET_NEW_BODY' });
  assert.deepEqual(call<Generation>('generations.prepare', input).composition, prepared.composition);
  assert.deepEqual(inspect(prepared), trace);
});

test('author sections collect every storage page in stable order at the exact revision', t => {
  const { call, projectId } = setup(t);
  const expected: string[] = [];
  for (let index = 0; index < 57; index++) {
    expected.unshift(call<Decision>('decision.propose', { projectId, title: `提案 ${index}`, body: `内容 ${index}` }).decisionId);
  }
  for (let index = 0; index < 53; index++) call('question.save', { projectId, title: `问题 ${index}`, body: '仍待裁决。' });
  const authorContext = { projectId, branchId: null, contextRevision: 110 };
  const first = call<Generation>('generations.prepare', { ...brief, authorContext });
  assert.deepEqual(first.composition.authorContext?.pendingDecisions.map(item => item.decisionId), expected);
  assert.equal(first.composition.authorContext?.openQuestions.length, 53);
  call('decision.propose', { projectId, title: '稍后提案', body: '不能混入旧上下文。' });
  assert.deepEqual(call<Generation>('generations.prepare', { ...brief, authorContext }).composition, first.composition);
});

test('the combined 200 entry limit counts effective confirmations and pending heads separately and fails atomically', t => {
  const { db, call, confirm, projectId } = setup(t);
  const approved = confirm(call<Decision>('decision.propose', { projectId, title: '已确认', body: '已确认。' }));
  call('decision.propose', { projectId, decisionId: approved.decisionId, expectedRevision: 2, title: '待确认', body: '仍待确认。' });
  for (let index = 0; index < maxAuthorContextItems - 2; index++) call('question.save', { projectId, title: `问题 ${index}`, body: '待定。' });
  const revision = call<StoryContext>('story.context', { projectId }).revision;
  const authorContext = { projectId, branchId: null, contextRevision: revision };
  const prepared = call<Generation>('generations.prepare', { ...brief, authorContext });
  const context = prepared.composition.authorContext!;
  assert.equal(context.confirmedDecisions.length + context.pendingDecisions.length + context.openQuestions.length, maxAuthorContextItems);
  call('question.save', { projectId, title: '超出总数', body: '必须拒绝。' });
  expectPrepareError(db, call, { authorContext: { ...authorContext, contextRevision: revision + 1 } }, 'generation_author_context_too_large');
  assert.deepEqual(call<Generation>('generations.prepare', { ...brief, authorContext }).composition, prepared.composition);
});

test('the author byte limit uses serialized UTF-8 bytes and accepts its exact boundary', t => {
  const { db, call, projectId } = setup(t);
  for (let index = 0; index < 16; index++) call('question.save', { projectId, title: `问题 ${index}`, body: '界'.repeat(4_000) });
  const ref = { projectId, branchId: null, contextRevision: 16 };
  const initial = call<Generation>('generations.prepare', { ...brief, authorContext: ref }).composition.authorContext!;
  // The last row's fixed metadata contributes to the exact UTF-8 boundary too.
  const last = call<Question>('question.save', { projectId, title: '最后一题', body: 'x' });
  const measured = call<Generation>('generations.prepare', { ...brief, authorContext: { ...ref, contextRevision: last.contextRevision } }).composition.authorContext!;
  const remaining = maxAuthorContextBytes - Buffer.byteLength(JSON.stringify(measured));
  assert.ok(remaining > 0 && remaining < 12_000);
  const body = '界'.repeat(Math.floor((remaining + 1) / 3)) + 'x'.repeat((remaining + 1) % 3);
  assert.ok(body.length <= 4_000);
  const exact = call<Question>('question.save', { projectId, questionId: last.questionId, expectedRevision: 1, title: last.title, body });
  const context = call<Generation>('generations.prepare', { ...brief, authorContext: { ...ref, contextRevision: exact.contextRevision } }).composition.authorContext!;
  assert.equal(Buffer.byteLength(JSON.stringify(context)), maxAuthorContextBytes);
  const over = call<Question>('question.save', { projectId, questionId: last.questionId, expectedRevision: 2, title: last.title, body: body + 'x' });
  expectPrepareError(db, call, { authorContext: { ...ref, contextRevision: over.contextRevision } }, 'generation_author_context_too_large');
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) < maxAuthorContextBytes);
});

test('the existing total context budget still applies after author context has passed its own budget', t => {
  const { db, call, projectId } = setup(t);
  call('decision.propose', { projectId, title: '提案', body: '尚未确认。' });
  const authorContext = { projectId, branchId: null, contextRevision: 1 };
  expectPrepareError(db, call, { authorContext, inputs: { large: '界'.repeat(170_000) } }, 'generation_context_too_large');
});

test('prompt pages reassemble author messages and provenance exactly across Chinese and astral text', t => {
  const { call, inspect, confirm, projectId } = setup(t);
  confirm(call<Decision>('decision.propose', { projectId, title: '渡船🚢', body: '她说 "等待"。🚢\n'.repeat(150) }));
  call('question.save', { projectId, title: '下一步', body: '问题🌙。'.repeat(300) });
  for (let index = 0; index < 8; index++) call('question.save', { projectId, title: `待决问题 ${index}`, body: '问题🌙。'.repeat(300) });
  const prepared = call<Generation>('generations.prepare', { ...brief, authorContext: { projectId, branchId: null, contextRevision: 11 } });
  const trace = inspect(prepared);
  for (const section of ['messages', 'provenance'] as const) {
    const parts: string[] = [];
    let cursor = 0;
    for (;;) {
      const page = call<PromptPage>('generations.prompt.page', { generationId: prepared.generationId, section, cursor });
      assert.equal(page.start, cursor);
      assert.equal(page.end - page.start, page.fragment.length);
      assert.ok(page.end > page.start);
      assert.doesNotMatch(page.fragment, /\p{Surrogate}/u);
      parts.push(page.fragment);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.ok(parts.length > 1);
    assert.equal(parts.join(''), JSON.stringify(trace[section]));
    assert.deepEqual(JSON.parse(parts.join('')), trace[section]);
  }
  const json = JSON.stringify(trace.messages);
  const start = json.indexOf('🚢');
  assert.ok(start >= 0);
  assert.throws(() => call('generations.prompt.page', { generationId: prepared.generationId, cursor: start + 1 }),
    problem('generation_prompt_cursor_invalid'));
});

test('requests omitting author context keep the original shape, messages, fixed revision and provenance without reading author tables', t => {
  const { db, call, inspect, projectId } = setup(t);
  const first = call<Generation>('generations.prepare', brief);
  const firstTrace = inspect(first);
  assert.equal(first.composition.authorContext, undefined);
  assert.equal(first.composition.projectId, undefined);
  assert.equal(firstTrace.provenance[0].revision, 1);
  assert.ok(firstTrace.provenance.every(item => item.kind !== 'author-context'));
  const scene = call<Scene>('scene.create', { title: '港口' });
  const narrative = telling(call, scene);
  const withStory = call<Generation>('generations.prepare', { ...brief, story: storyRef(narrative) });
  assert.equal(inspect(withStory).provenance[0].revision, 2);
  call('decision.propose', { projectId, title: '后来提案', body: '旧请求不自动包含。' });
  db.exec(`DROP TABLE story_question_revisions; DROP TABLE story_questions;
    DROP TABLE story_decision_revisions; DROP TABLE story_decisions; DROP TABLE story_context_scopes`);
  const again = call<Generation>('generations.prepare', brief);
  assert.deepEqual(again.composition, first.composition);
  assert.deepEqual(inspect(again).messages, firstTrace.messages);
  assert.deepEqual(inspect(again).provenance, firstTrace.provenance);
  assert.deepEqual(call<Generation>('generations.prepare', { ...brief, story: storyRef(narrative) }).composition, withStory.composition);
});
