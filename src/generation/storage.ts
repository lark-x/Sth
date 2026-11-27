import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { OperationError } from '../core/index.ts';
import { nameKey } from '../library/storage.ts';
import type { Execution, Failure, Field, Generation, GenerationResult, Plan, PromptInspection, PromptRequestOptions, Template } from './contracts.ts';
import { discloseRequestOptions, type DelegationPromptStatus, type StoredComposition } from './prompt.ts';
import { manuscriptEvidenceDDL } from './evidence-contracts.ts';

const sectionText = (key: string, label: string): Extract<Field, { type: 'text' }> => ({ key, label, type: 'text' });
const starters: Pick<Template, 'templateId' | 'title' | 'kind' | 'fields'>[] = [
  { templateId: 'diary', title: 'Diary', kind: 'diary', fields: [
    sectionText('setting', 'Setting'), sectionText('events', 'Events'),
    sectionText('feelings', 'Feelings'), sectionText('reflection', 'Reflection'),
  ] },
  { templateId: 'short-story', title: 'Short story', kind: 'short-story', fields: [
    sectionText('opening', 'Opening'), sectionText('development', 'Development'), sectionText('ending', 'Ending'),
  ] },
  { templateId: 'screenplay', title: 'Screenplay', kind: 'screenplay', fields: [
    { key: 'scenes', label: 'Scenes', type: 'sections', fields: [
      sectionText('heading', 'Scene heading'), sectionText('action', 'Action'),
      { key: 'dialogue', label: 'Dialogue', type: 'text', required: false },
    ] },
  ] },
  { templateId: 'shot-list', title: 'Shot list', kind: 'shot-list', fields: [
    { key: 'shots', label: 'Shots', type: 'sections', fields: [
      { key: 'number', label: 'Shot number', type: 'integer', minimum: 1 },
      sectionText('framing', 'Framing'), sectionText('action', 'Action'),
      { key: 'sound', label: 'Sound', type: 'text', required: false },
    ] },
  ] },
];

export const generationDDL = `
CREATE TABLE IF NOT EXISTS generation_definitions (
  kind TEXT NOT NULL CHECK (kind IN ('template', 'requirements', 'plan')),
  definition_id TEXT NOT NULL,
  name_key TEXT NOT NULL,
  PRIMARY KEY (kind, definition_id),
  UNIQUE (kind, name_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS generation_definition_revisions (
  kind TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (kind, definition_id, revision),
  FOREIGN KEY (kind, definition_id) REFERENCES generation_definitions(kind, definition_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS generation_records (
  generation_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT REFERENCES library_projects(project_id),
  mode TEXT NOT NULL CHECK (mode IN ('current-chat', 'delegation')),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'queued', 'running', 'succeeded', 'failed', 'uncertain')),
  source_generation_id TEXT REFERENCES generation_records(generation_id),
  composition_json TEXT NOT NULL,
  plan_json TEXT,
  execution_json TEXT NOT NULL,
  raw_output TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  lease_until INTEGER,
  CHECK ((mode = 'delegation') = (plan_json IS NOT NULL AND source_generation_id IS NOT NULL)),
  CHECK ((status = 'running') = (lease_until IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS generation_results (
  result_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL UNIQUE REFERENCES generation_records(generation_id),
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS generation_batches (
  batch_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS generation_batch_attempts (
  batch_id TEXT NOT NULL REFERENCES generation_batches(batch_id),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 50),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 9007199254740991),
  generation_id TEXT NOT NULL UNIQUE REFERENCES generation_records(generation_id),
  canceled_at TEXT,
  PRIMARY KEY (batch_id, position, attempt)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS generation_batches_created ON generation_batches(created_at DESC, batch_id);
CREATE INDEX IF NOT EXISTS generation_records_queue ON generation_records(status, created_at, generation_id);
CREATE INDEX IF NOT EXISTS generation_records_lease ON generation_records(lease_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS generation_records_project ON generation_records(project_id, created_at DESC, generation_id);

${manuscriptEvidenceDDL}

${starters.map(({ templateId, ...body }) => `
INSERT INTO generation_definitions (kind, definition_id, name_key) VALUES ('template', '${templateId}', '${nameKey(body.title)}')
  ON CONFLICT DO NOTHING;
INSERT INTO generation_definition_revisions (kind, definition_id, revision, title, payload_json)
  SELECT 'template', '${templateId}', 1, '${body.title}', '${JSON.stringify(body)}'
  WHERE EXISTS (SELECT 1 FROM generation_definitions WHERE kind = 'template' AND definition_id = '${templateId}')
  ON CONFLICT DO NOTHING;`).join('\n')}
`;

type DefinitionKind = 'template' | 'requirements' | 'plan';
type DefinitionRow = { definition_id: string; revision: number; title: string; payload_json: string };
const definitionPaths = { template: '/templates', requirements: '/writing-requirements', plan: '/generation-plans' };

export function summarizeDefinition(kind: DefinitionKind, row: DefinitionRow) {
  return { revision: row.revision, title: row.title, href: `${definitionPaths[kind]}/${row.definition_id}?revision=${row.revision}` };
}

export function readDefinition<T>(db: DatabaseSync, kind: DefinitionKind, id: string, revision?: number) {
  const row = db.prepare(`SELECT definition_id, revision, title, payload_json FROM generation_definition_revisions
    WHERE kind = ? AND definition_id = ? AND (? IS NULL OR revision = ?) ORDER BY revision DESC LIMIT 1`)
    .get(kind, id, revision ?? null, revision ?? null) as DefinitionRow | undefined;
  if (!row) throw new OperationError(404, 'generation_definition_not_found',
    `No ${kind} ${id}${revision === undefined ? '' : ` at revision ${revision}`} was found.`);
  return { data: JSON.parse(row.payload_json) as T, ...summarizeDefinition(kind, row) };
}

export function readPlan(db: DatabaseSync, planId: string, revision?: number): Plan {
  const { data, ...summary } = readDefinition<Pick<Plan, 'executor' | 'provider' | 'model' | 'parameters'>>(db, 'plan', planId, revision);
  return { planId, ...data, ...summary };
}

const templateAliases = new Map([
  ['日记', 'diary'], ['短篇故事', 'short-story'], ['短故事', 'short-story'], ['短篇小说', 'short-story'],
  ['短篇', 'short-story'], ['剧本', 'screenplay'], ['分镜', 'shot-list'], ['分镜表', 'shot-list'], ['分镜清单', 'shot-list'],
]);

export function listDefinitions(db: DatabaseSync, kind: DefinitionKind, name: string | undefined, limit: number, offset: number) {
  const key = name === undefined ? null : nameKey(name);
  const alias = kind === 'template' && key !== null ? templateAliases.get(key) : undefined;
  return db.prepare(`SELECT d.definition_id, r.revision, r.title, r.payload_json FROM generation_definitions d
    JOIN generation_definition_revisions r ON r.kind = d.kind AND r.definition_id = d.definition_id
      AND r.revision = (SELECT MAX(revision) FROM generation_definition_revisions WHERE kind = d.kind AND definition_id = d.definition_id)
    WHERE d.kind = ? AND (? IS NULL OR d.name_key = ? OR (d.definition_id = ? AND NOT EXISTS
      (SELECT 1 FROM generation_definitions exact WHERE exact.kind = d.kind AND exact.name_key = ?)))
    ORDER BY d.name_key, d.definition_id LIMIT ? OFFSET ?`)
    .all(kind, key, key, alias ?? null, key, limit, offset) as DefinitionRow[];
}

export function writeDefinition(db: DatabaseSync, kind: DefinitionKind, body: { title: string }, target?: { id: string; expectedRevision: number }) {
  const id = target?.id ?? randomUUID();
  const title = body.title.trim();
  const key = nameKey(title);
  const existing = target && readDefinition(db, kind, id);
  if (existing && existing.revision !== target?.expectedRevision) {
    throw new OperationError(409, 'generation_definition_conflict',
      `${kind} ${id} is at revision ${existing.revision}. Read the current revision before editing.`);
  }
  const sameName = db.prepare('SELECT definition_id FROM generation_definitions WHERE kind = ? AND name_key = ?')
    .get(kind, key);
  if (sameName && sameName.definition_id !== id) {
    throw new OperationError(409, 'generation_name_in_use', `The ${kind} name ${JSON.stringify(title)} is in use.`);
  }
  if (target) {
    db.prepare('UPDATE generation_definitions SET name_key = ? WHERE kind = ? AND definition_id = ?').run(key, kind, id);
  } else {
    db.prepare('INSERT INTO generation_definitions VALUES (?, ?, ?)').run(kind, id, key);
  }
  db.prepare('INSERT INTO generation_definition_revisions VALUES (?, ?, ?, ?, ?)')
    .run(kind, id, (existing?.revision ?? 0) + 1, title, JSON.stringify({ ...body, title }));
  return id;
}

type GenerationRow = {
  generation_id: string; title: string; project_id: string | null; mode: Generation['mode']; status: Generation['status'];
  source_generation_id: string | null; composition_json: string; plan_json: string | null; execution_json: string;
  raw_output: string | null; error_json: string | null; created_at: string; started_at: string | null;
  finished_at: string | null; result_id: string | null; canceled_at: string | null;
};

export function summarizeGeneration(row: Omit<GenerationRow, 'composition_json' | 'plan_json' | 'execution_json' | 'raw_output'>) {
  const href = `/generations/${row.generation_id}`;
  const finishedAt = row.canceled_at ?? row.finished_at;
  return {
    generationId: row.generation_id, title: row.title, href, mode: row.mode,
    status: row.canceled_at === null ? row.status : 'canceled' as const, createdAt: row.created_at,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.source_generation_id === null ? {} : { sourceGenerationId: row.source_generation_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(finishedAt === null ? {} : { finishedAt }),
    ...(row.result_id === null ? {} : { result: { resultId: row.result_id, title: row.title, href: `${href}/result` } }),
    ...(row.error_json === null ? {} : { error: JSON.parse(row.error_json) as Failure }),
  };
}

const generationDetails = `FROM generation_records g LEFT JOIN generation_results r ON r.generation_id = g.generation_id
  LEFT JOIN generation_batch_attempts a ON a.generation_id = g.generation_id`;
const generationSummaryFields = `g.generation_id, g.title, g.project_id, g.mode, g.status, g.source_generation_id,
  g.created_at, g.started_at, g.finished_at, g.error_json, r.result_id, a.canceled_at`;

type StoredExecution = Execution & { promptStatus?: DelegationPromptStatus };

function readGenerationRecord(db: DatabaseSync, id: string) {
  const row = db.prepare(`SELECT g.*, r.result_id, a.canceled_at ${generationDetails} WHERE g.generation_id = ?`).get(id) as GenerationRow | undefined;
  if (!row) throw new OperationError(404, 'generation_not_found', `Generation ${id} was not found.`);
  return row;
}

function readComposition(json: string): StoredComposition {
  type LegacyProvenance = NonNullable<StoredComposition['promptProvenance']>[number] | { disposition: 'omitted' };
  const { promptProvenance, ...composition } = JSON.parse(json) as
    Omit<StoredComposition, 'promptProvenance'> & { promptProvenance?: LegacyProvenance[] };
  // Early snapshots traced unselected blocks. Filter them when reading or copying a snapshot.
  return promptProvenance === undefined ? composition : {
    ...composition, promptProvenance: promptProvenance.filter(item => item.disposition === 'included'),
  };
}

export function readGeneration(db: DatabaseSync, id: string): Generation {
  const row = readGenerationRecord(db, id);
  const { promptProvenance: _, ...composition } = JSON.parse(row.composition_json) as StoredComposition;
  const { promptStatus: __, ...execution } = JSON.parse(row.execution_json) as StoredExecution;
  return {
    ...summarizeGeneration(row),
    composition, execution,
    ...(row.plan_json === null ? {} : { plan: JSON.parse(row.plan_json) as Plan }),
    ...(row.raw_output === null ? {} : { rawOutput: JSON.parse(row.raw_output) as string }),
  };
}

export function readGenerationPrompt(db: DatabaseSync, generationId: string): PromptInspection {
  const row = readGenerationRecord(db, generationId);
  const composition = readComposition(row.composition_json);
  const { promptStatus, requestOptions } = JSON.parse(row.execution_json) as StoredExecution;
  const plan = row.plan_json === null ? undefined : JSON.parse(row.plan_json) as Plan;
  // New workers persist only approved options. Older records used an open-ended options field.
  const approved = promptStatus !== undefined ? requestOptions as PromptRequestOptions | undefined
    : plan && discloseRequestOptions(plan, composition.template.fields, requestOptions);
  const historical = composition.promptProvenance === undefined;
  return {
    generationId, title: row.title, href: `/generations/${generationId}/prompt`, mode: row.mode, historical,
    status: promptStatus ?? (row.mode === 'current-chat' && !historical ? 'provided' : 'unknown'),
    messages: composition.messages.map(({ role, content }) => ({
      role, parts: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    })),
    provenance: composition.promptProvenance ?? [],
    parameters: { ...(plan === undefined ? {} : { plan }), ...(approved === undefined ? {} : { requestOptions: approved }) },
  };
}

export function readGenerationSummary(db: DatabaseSync, id: string) {
  const row = db.prepare(`SELECT ${generationSummaryFields} ${generationDetails} WHERE g.generation_id = ?`).get(id) as GenerationRow | undefined;
  if (!row) throw new OperationError(404, 'generation_not_found', `Generation ${id} was not found.`);
  return summarizeGeneration(row);
}

export function listGenerations(db: DatabaseSync, projectId: string | undefined, limit: number, offset: number) {
  const rows = db.prepare(`SELECT ${generationSummaryFields} ${generationDetails}
    WHERE (? IS NULL OR g.project_id = ?) ORDER BY g.created_at DESC, g.generation_id LIMIT ? OFFSET ?`)
    .all(projectId ?? null, projectId ?? null, limit, offset) as GenerationRow[];
  return rows.map(summarizeGeneration);
}

export function enqueueDelegation(db: DatabaseSync, sourceGenerationId: string, plan: Plan) {
  const source = readGenerationRecord(db, sourceGenerationId);
  if (source.mode !== 'current-chat') {
    throw new OperationError(409, 'generation_context_required', 'Use the current-chat generation ID from generations.prepare.');
  }
  const generationId = insertGeneration(db, readComposition(source.composition_json), { plan, sourceGenerationId });
  db.prepare(`INSERT INTO generation_manuscript_targets SELECT ?, scene_id, scene_revision
    FROM generation_manuscript_targets WHERE generation_id = ?`).run(generationId, sourceGenerationId);
  return generationId;
}

export function insertGeneration(db: DatabaseSync, composition: StoredComposition, delegation?: { plan: Plan; sourceGenerationId: string }) {
  const id = randomUUID();
  const execution: StoredExecution = {
    requestedModel: delegation?.plan.model ?? null, reportedModel: null, reportedModelSource: null,
    providerResponseId: null, finishReason: null, providerEndpoint: null,
    ...(delegation ? { promptStatus: 'prepared' } : {}),
  };
  db.prepare(`INSERT INTO generation_records (generation_id, title, project_id, mode, status,
    source_generation_id, composition_json, plan_json, execution_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, composition.title, composition.projectId ?? null, delegation ? 'delegation' : 'current-chat',
      delegation ? 'queued' : 'prepared', delegation?.sourceGenerationId ?? null, JSON.stringify(composition),
      delegation ? JSON.stringify(delegation.plan) : null, JSON.stringify(execution), new Date().toISOString());
  return id;
}

export function recordDelegationDispatch(db: DatabaseSync, generationId: string, execution: Execution, promptStatus: DelegationPromptStatus) {
  return db.prepare(`UPDATE generation_records SET execution_json = ? WHERE generation_id = ? AND status = 'running'`)
    .run(JSON.stringify({ ...execution, promptStatus }), generationId).changes === 1;
}

export function readResult(db: DatabaseSync, resultId: string): GenerationResult {
  const row = db.prepare(`SELECT g.title, r.generation_id, r.output_json, r.created_at FROM generation_results r
    JOIN generation_records g ON g.generation_id = r.generation_id WHERE r.result_id = ?`).get(resultId);
  if (!row) throw new OperationError(404, 'generation_result_not_found', `Result ${resultId} was not found.`);
  const generationId = String(row.generation_id);
  return {
    resultId, generationId, title: String(row.title), createdAt: String(row.created_at),
    href: `/generations/${generationId}/result`, output: JSON.parse(String(row.output_json)),
  };
}

/** Called inside the operation or worker transaction, after validating the structured result. */
export function completeGeneration(db: DatabaseSync, record: Generation, outcome: {
  status: 'succeeded' | 'failed' | 'uncertain'; execution: StoredExecution; output?: Record<string, unknown>; rawOutput?: string; error?: Failure;
}) {
  const finishedAt = new Date().toISOString();
  const update = db.prepare(`UPDATE generation_records SET status = ?, execution_json = ?, raw_output = ?, error_json = ?,
    finished_at = ?, lease_until = NULL WHERE generation_id = ? AND status = ?`)
    .run(outcome.status, JSON.stringify(outcome.execution), outcome.rawOutput === undefined ? null : JSON.stringify(outcome.rawOutput),
      outcome.error === undefined ? null : JSON.stringify(outcome.error), finishedAt, record.generationId, record.status);
  if (update.changes === 1 && outcome.output !== undefined) {
    db.prepare('INSERT INTO generation_results VALUES (?, ?, ?, ?)')
      .run(randomUUID(), record.generationId, JSON.stringify(outcome.output), finishedAt);
  }
}
