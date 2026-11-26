import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { workspaceDDL, workspaceOperations } from '../src/workspace.ts';

test('background activity paginates media, research and delegated writing without repeating batch children', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; ${operationsDDL} ${workspaceDDL}`);
  const registry = new Operations(db, workspaceOperations);
  function run<T>(operationId: string, input: object): T {
    return registry.invoke('web', { operationId, input, stepId: randomUUID() }).result as T;
  }
  type Page = {items: { id: string; kind: string; status: string; href: string }[]; nextOffset?: number};
  const { projectId } = run<{projectId:string}>('project.create', { title: 'North quay' });
  const { chapterId, revision } = run<{chapterId:string;revision:number}>('chapter.create', { projectId, title: 'Crossing' });
  const { sceneId } = run<{sceneId:string}>('scene.create', { title: 'Fog' });
  run('chapter.arrange', { chapterId, expectedRevision: revision, sceneIds: [sceneId] });
  const c = run<{compositionId:string;candidates:{candidateId:string}[]}>('composition.create', {
    projectId, sceneId, sceneRevision: 1, candidates: [{ title: 'Harbor', prompt: 'Foggy pier' }],
  });
  const item = { compositionId: c.compositionId, candidateId: c.candidates[0].candidateId };
  run('composition.select', { ...item, expectedSelectionRevision: 0 });
  const media = run<{jobId:string}>('jobs.create', { projectId, title: 'Harbor image', items: [item] });
  const search = run<{jobId:string}>('external.search', { query: 'harbor' });
  const prepared = run<{generationId:string}>('generations.prepare', { title: 'Crossing', brief: 'Write.', templateId: 'diary' });
  const { planId } = run<{planId:string}>('generation.plans.create', {
    title: 'Writing', provider: 'test', model: 'test', executor: 'openai-compatible', parameters: {},
  });
  const single = run<{generationId:string}>('generations.start', { planId, generationId: prepared.generationId });
  const batch = run<{batchId:string}>('generation.batches.create', { planId, title: 'Batch', generationIds: [prepared.generationId] });
  const pages = run<Page>('tasks.list', { limit: 2 });
  assert.equal(pages.nextOffset, 2);
  const last = run<Page>('tasks.list', { limit: 2, offset: pages.nextOffset });
  assert.equal(last.nextOffset, undefined);
  const all = [...pages.items, ...last.items];
  assert.deepEqual(all.map(row => row.href).sort(), [`/jobs/${media.jobId}`, `/research/${search.jobId}`,
    `/generations/${single.generationId}`, `/generation-batches/${batch.batchId}`].sort());
  assert.ok(all.every(row => row.status === 'queued'));
});
