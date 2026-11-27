import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import { requireProject } from '../library/storage.ts';
import { validateSourcePins } from '../sources/pins.ts';
import { readBranch, sceneBranchId } from './branches.ts';
import type {
  BasisInput, Decision, DecisionBasis, DecisionScope, DecisionSummary, Question, QuestionSummary, StoryContext,
} from './decision-contracts.ts';
import { readScene, readSceneSummary, sceneHref } from './storage.ts';

type RevisionRow = {
  project_id: string; branch_key: string; revision: number; context_revision: number;
  title: string; body: string; basis_json: string; created_at: string;
};
type DecisionRow = RevisionRow & {
  decision_id: string; status: 'proposed' | 'confirmed';
  proposal_revision: number | null; confirmed_by: string | null; confirmed_at: string | null;
};
type QuestionRow = RevisionRow & {
  question_id: string; status: 'open' | 'resolved'; decision_id: string | null; decision_revision: number | null;
};
const decisionRows = `SELECT d.project_id, d.branch_key, r.* FROM story_decisions d
  JOIN story_decision_revisions r USING (decision_id)`;
const questionRows = `SELECT q.project_id, q.branch_key, r.* FROM story_questions q
  JOIN story_question_revisions r USING (question_id)`;

export function requireDecisionScope(db: DatabaseSync, scope: DecisionScope) {
  requireProject(db, scope.projectId);
  if (scope.branchId === null) return;
  const branch = readBranch(db, scope.branchId);
  const owner = db.prepare('SELECT project_id FROM story_context_scopes WHERE branch_id = ?').get(scope.branchId);
  if (owner) {
    if (owner.project_id !== scope.projectId) {
      throw new OperationError(409, 'story_project_mismatch', 'This IF branch belongs to another project context.');
    }
    return;
  }
  // Existing IF branches may predate project contexts. Follow their fixed origins to the placed mainline scene.
  let origin = readSceneSummary(db, branch.originSceneId, branch.originSceneRevision);
  while (origin.branchFrom) origin = readSceneSummary(db, origin.branchFrom.sceneId, origin.branchFrom.revision);
  if (origin.placement && origin.placement.projectId !== scope.projectId) {
    throw new OperationError(409, 'story_project_mismatch', 'The IF origin is placed in another project.');
  }
}

function requireBasisScene(db: DatabaseSync, scope: DecisionScope, sceneId: string, revision: number) {
  const scene = readSceneSummary(db, sceneId, revision);
  if (sceneBranchId(db, sceneId, scene.branchFrom !== undefined) !== scope.branchId) {
    throw new OperationError(409, 'story_basis_branch_mismatch', 'Pin a scene in the decision or question branch.');
  }
  if (scene.placement && scene.placement.projectId !== scope.projectId) {
    throw new OperationError(409, 'story_project_mismatch', 'The pinned scene is placed in another project.');
  }
}

/** Materialize once. Later reads never follow changing placement, source heads, checkpoints or adoptions. */
export function pinDecisionBasis(db: DatabaseSync, scope: DecisionScope, input: BasisInput): DecisionBasis {
  const sources = validateSourcePins(db, input.sources ?? []);
  let scene: DecisionBasis['scene'];
  if (input.scene) {
    requireBasisScene(db, scope, input.scene.sceneId, input.scene.revision);
    scene = readScene(db, input.scene.sceneId, input.scene.revision);
    scene.href = sceneHref(scene.sceneId, scene.revision);
  }
  let checkpoint: DecisionBasis['checkpoint'];
  if (input.checkpoint) {
    if (input.checkpoint.branchId !== scope.branchId) {
      throw new OperationError(409, 'story_basis_branch_mismatch', 'Pin a checkpoint in the decision or question branch.');
    }
    checkpoint = readBranch(db, input.checkpoint.branchId, input.checkpoint.revision);
    requireBasisScene(db, scope, checkpoint.checkpoint.sceneId, checkpoint.checkpoint.sceneRevision);
  }
  return { sources, ...(scene ? { scene } : {}), ...(checkpoint ? { checkpoint } : {}) };
}

function common(row: RevisionRow) {
  return {
    projectId: row.project_id, branchId: row.branch_key || null, revision: row.revision,
    contextRevision: row.context_revision, title: row.title, body: row.body, createdAt: row.created_at,
  };
}

function decisionSummary(row: DecisionRow): DecisionSummary {
  const fields = { ...common(row), decisionId: row.decision_id };
  return row.status === 'proposed' ? { ...fields, status: 'proposed' } : {
    ...fields, status: 'confirmed', confirmation: {
      proposalRevision: row.proposal_revision!, confirmedBy: row.confirmed_by!, confirmedAt: row.confirmed_at!,
    },
  };
}

function questionSummary(row: QuestionRow): QuestionSummary {
  const fields = { ...common(row), questionId: row.question_id };
  return row.status === 'open' ? { ...fields, status: 'open' } : {
    ...fields, status: 'resolved', resolution: { decisionId: row.decision_id!, revision: row.decision_revision! },
  };
}

export function readDecision(db: DatabaseSync, decisionId: string, revision?: number): Decision {
  const row = db.prepare(`${decisionRows} WHERE d.decision_id = ? AND (? IS NULL OR r.revision = ?)
    ORDER BY r.revision DESC LIMIT 1`).get(decisionId, revision ?? null, revision ?? null) as DecisionRow | undefined;
  if (!row) throw new OperationError(404, revision === undefined ? 'decision_not_found' : 'decision_revision_not_found',
    'The requested decision version was not found.');
  return { ...decisionSummary(row), basis: JSON.parse(row.basis_json) as DecisionBasis };
}

export function readQuestion(db: DatabaseSync, questionId: string, revision?: number): Question {
  const row = db.prepare(`${questionRows} WHERE q.question_id = ? AND (? IS NULL OR r.revision = ?)
    ORDER BY r.revision DESC LIMIT 1`).get(questionId, revision ?? null, revision ?? null) as QuestionRow | undefined;
  if (!row) throw new OperationError(404, revision === undefined ? 'question_not_found' : 'question_revision_not_found',
    'The requested question version was not found.');
  return { ...questionSummary(row), basis: JSON.parse(row.basis_json) as DecisionBasis };
}

export function requireDecisionRevision(kind: 'decision' | 'question', actual: number, expected: number) {
  if (actual !== expected) throw new OperationError(409, `${kind}_revision_conflict`,
    `The ${kind} is at revision ${actual}. Read it before retrying.`);
  if (actual === Number.MAX_SAFE_INTEGER) throw new OperationError(409, 'story_revision_exhausted', 'The revision limit was reached.');
}

export function sameDecisionScope(actual: DecisionScope, expected: DecisionScope) {
  if (actual.projectId !== expected.projectId || actual.branchId !== expected.branchId) {
    throw new OperationError(409, 'story_scope_mismatch', 'Decision and question ownership is fixed to one project and branch.');
  }
}

function nextContextRevision(db: DatabaseSync, { projectId, branchId }: DecisionScope): number {
  if (!db.isTransaction) throw new Error('Story writes require the operation transaction.');
  const key = branchId ?? '';
  db.prepare(`INSERT INTO story_context_scopes (project_id, branch_key, branch_id) VALUES (?, ?, ?)
    ON CONFLICT (project_id, branch_key) DO NOTHING`).run(projectId, key, branchId);
  const row = db.prepare(`UPDATE story_context_scopes SET revision = revision + 1
    WHERE project_id = ? AND branch_key = ? AND revision < 9007199254740991 RETURNING revision`).get(projectId, key);
  if (!row) throw new OperationError(409, 'story_revision_exhausted', 'The context revision limit was reached.');
  return Number(row.revision);
}

type NewVersion<T> = T extends unknown ? Omit<T, 'contextRevision' | 'createdAt'> : never;

export function writeDecision(db: DatabaseSync, value: NewVersion<Decision>) {
  const contextRevision = nextContextRevision(db, value);
  if (value.revision === 1) db.prepare('INSERT INTO story_decisions (decision_id, project_id, branch_key) VALUES (?, ?, ?)')
    .run(value.decisionId, value.projectId, value.branchId ?? '');
  const confirmation = value.status === 'confirmed' ? value.confirmation : undefined;
  db.prepare(`INSERT INTO story_decision_revisions (decision_id, revision, context_revision, status, title, body, basis_json,
    created_at, proposal_revision, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(value.decisionId, value.revision, contextRevision, value.status, value.title, value.body, JSON.stringify(value.basis),
      new Date().toISOString(), confirmation?.proposalRevision ?? null, confirmation?.confirmedBy ?? null, confirmation?.confirmedAt ?? null);
  return readDecision(db, value.decisionId, value.revision);
}

export function writeQuestion(db: DatabaseSync, value: NewVersion<Question>) {
  const contextRevision = nextContextRevision(db, value);
  if (value.revision === 1) db.prepare('INSERT INTO story_questions (question_id, project_id, branch_key) VALUES (?, ?, ?)')
    .run(value.questionId, value.projectId, value.branchId ?? '');
  const resolution = value.status === 'resolved' ? value.resolution : undefined;
  db.prepare(`INSERT INTO story_question_revisions (question_id, revision, context_revision, status, title, body, basis_json,
    created_at, decision_id, decision_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(value.questionId, value.revision, contextRevision, value.status, value.title, value.body, JSON.stringify(value.basis),
      new Date().toISOString(), resolution?.decisionId ?? null, resolution?.revision ?? null);
  return readQuestion(db, value.questionId, value.revision);
}

export function readContextRevision(db: DatabaseSync, scope: DecisionScope, requested?: number) {
  const row = db.prepare('SELECT revision FROM story_context_scopes WHERE project_id = ? AND branch_key = ?')
    .get(scope.projectId, scope.branchId ?? '');
  const latest = row ? Number(row.revision) : 0;
  if (requested !== undefined && requested > latest) {
    throw new OperationError(404, 'story_context_revision_not_found', 'The context has not reached this revision.');
  }
  return requested ?? latest;
}

export function listDecisions(db: DatabaseSync, scope: DecisionScope, at: number, limit: number, offset: number,
  status?: 'proposed' | 'confirmed'): DecisionSummary[] {
  const rows = db.prepare(`${decisionRows} WHERE d.project_id = ? AND d.branch_key = ? AND r.revision = (
    SELECT MAX(v.revision) FROM story_decision_revisions v WHERE v.decision_id = d.decision_id
      AND v.context_revision <= ? AND (? IS NOT 'confirmed' OR v.status = 'confirmed'))
    AND (? IS NULL OR r.status = ?) ORDER BY r.context_revision DESC, d.decision_id LIMIT ? OFFSET ?`)
    .all(scope.projectId, scope.branchId ?? '', at, status ?? null, status ?? null, status ?? null, limit, offset) as DecisionRow[];
  return rows.map(decisionSummary);
}

export function listQuestions(db: DatabaseSync, scope: DecisionScope, at: number, limit: number, offset: number,
  status?: 'open' | 'resolved'): QuestionSummary[] {
  const rows = db.prepare(`${questionRows} WHERE q.project_id = ? AND q.branch_key = ? AND r.revision = (
    SELECT MAX(v.revision) FROM story_question_revisions v WHERE v.question_id = q.question_id AND v.context_revision <= ?)
    AND (? IS NULL OR r.status = ?) ORDER BY r.context_revision DESC, q.question_id LIMIT ? OFFSET ?`)
    .all(scope.projectId, scope.branchId ?? '', at, status ?? null, status ?? null, limit, offset) as QuestionRow[];
  return rows.map(questionSummary);
}

export function decisionRevisions(db: DatabaseSync, decisionId: string, limit: number, offset: number) {
  readDecision(db, decisionId);
  return (db.prepare(`${decisionRows} WHERE d.decision_id = ? ORDER BY r.revision DESC LIMIT ? OFFSET ?`)
    .all(decisionId, limit, offset) as DecisionRow[]).map(decisionSummary);
}

export function questionRevisions(db: DatabaseSync, questionId: string, limit: number, offset: number) {
  readQuestion(db, questionId);
  return (db.prepare(`${questionRows} WHERE q.question_id = ? ORDER BY r.revision DESC LIMIT ? OFFSET ?`)
    .all(questionId, limit, offset) as QuestionRow[]).map(questionSummary);
}

export function contextText(context: Omit<StoryContext, 'text'>) {
  const lines = [`作品 ${context.projectId} / ${context.branchId === null ? '主线' : `IF ${context.branchId}`} / 上下文版本 ${context.revision}`];
  if (context.checkpoint) lines.push(`断点 ${context.checkpoint.branchId}@${context.checkpoint.revision}，场景 ${context.checkpoint.checkpoint.sceneId}@${context.checkpoint.checkpoint.sceneRevision}`);
  for (const [heading, page] of [
    ['待作者确认的提案', context.pendingDecisions], ['作者已确认的决定', context.confirmedDecisions],
    ['开放问题', context.openQuestions], ['已结案问题', context.resolvedQuestions],
  ] as const) {
    lines.push(`\n## ${heading}`);
    if (!page.items.length) lines.push('本页无条目。');
    for (const item of page.items) {
      lines.push(`- ${'decisionId' in item ? item.decisionId : item.questionId}@${item.revision} ${item.title}`, item.body);
      if ('confirmation' in item) lines.push(`作者确认 ${item.confirmation.confirmedBy}，${item.confirmation.confirmedAt}，依据提案版本 ${item.confirmation.proposalRevision}`);
      if ('resolution' in item) lines.push(`结案依据 ${item.resolution.decisionId}@${item.resolution.revision}`);
    }
    if (page.hasMore) lines.push('还有后续条目，使用相同上下文版本和下一页 offset 继续读取。');
  }
  return lines.join('\n');
}
