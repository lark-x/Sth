import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { jobsDDL, jobsOperations } from '../src/jobs/index.ts';
import { libraryDDL, libraryOperations } from '../src/library/index.ts';
import { sourcesDDL, sourceOperations } from '../src/sources/index.ts';
import { storyDDL, storyOperations } from '../src/story/index.ts';
import type { Scene } from '../src/story/contracts.ts';

type Candidate = { compositionId: string; candidateId: string };
type Composition = { compositionId: string; selectionRevision: number; candidates: { candidateId: string }[];
  scene: Pick<Scene, 'sceneId' | 'revision' | 'title' | 'href'> };
export type JobItem = Candidate & { itemId: string; scene: Composition['scene']; status: string;
  attempt?: { requestId: string; providerJobId?: string; number: number; message?: string }; mediaId?: string; mediaHref?: string;
  reconciliationQueued: boolean };
export type Job = { jobId: string; items: JobItem[]; attemptsStarted: number; progress: Record<string, number>; mode: string };

export function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'sth-jobs-'));
  const file = join(directory, 'jobs.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    ${operationsDDL} ${libraryDDL} ${sourcesDDL} ${storyDDL} ${jobsDDL}`);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const operations = new Operations(db, [...libraryOperations, ...sourceOperations, ...storyOperations, ...jobsOperations]);
  let step = 0;
  function invoke<T>(operationId: string, input: unknown, stepId = `jobs-test-${++step}`): T {
    return operations.invoke('jobs-fixture', { operationId, input, stepId }).result as T;
  }
  const { projectId } = invoke<{ projectId: string }>('project.create', { title: 'North Harbor' });
  const { chapterId, revision } = invoke<{ chapterId: string; revision: number }>('chapter.create', { projectId, title: 'The harbor' });
  const readJob = (jobId: string) => invoke<Job>('jobs.read', { jobId });

  function makeCompositions(prompts: string[]) {
    const scenes = prompts.map((_, index) => invoke<Scene>('scene.create', { title: `Scene ${index + 1}`, place: 'North Harbor' }));
    invoke('chapter.arrange', { chapterId, expectedRevision: revision, sceneIds: scenes.map(({ sceneId }) => sceneId) });
    return scenes.map(({ sceneId, revision }, index) => {
      const scene = invoke<Scene>('scene.read', { sceneId, revision });
      const input = { projectId, sceneId: scene.sceneId, sceneRevision: scene.revision, candidates: [
        { title: 'Wide angle', prompt: prompts[index] }, { title: 'Close-up', prompt: 'A different viewpoint' },
      ] };
      const result = invoke<Composition>('composition.create', input);
      const selection = { compositionId: result.compositionId, candidateId: result.candidates[0].candidateId };
      return { input, result, selection };
    });
  }

  function select({ compositionId, candidateId }: Candidate, expectedSelectionRevision = 0) {
    return invoke<Composition>('composition.select', { compositionId, candidateId, expectedSelectionRevision });
  }
  return { db, directory, file, invoke, operations, projectId, makeCompositions, select, readJob };
}

export async function waitFor<T>(read: () => T, check: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (check(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for expected state. Last value: ${JSON.stringify(value)}`);
    await delay(20);
  }
}
