import type { Operation } from './core/index.ts';
import { libraryDDL, libraryOperations } from './library/index.ts';
import { sourcesDDL, sourceOperations } from './sources/index.ts';
import { externalDDL, externalOperations } from './sources/external.ts';
import { storyDDL, storyOperations } from './story/index.ts';
import { generationDDL, generationOperations } from './generation/index.ts';
import { jobsDDL, jobsOperations } from './jobs/index.ts';
import { assetsDDL, assetOperations } from './assets/index.ts';
import { taskActivity } from './jobs/activity.ts';

interface WorkspaceModule {
  ddl: string;
  operations: readonly Operation[];
  resourcePaths: readonly string[];
}

// Dependencies precede consumers. Transport adapters use this directory for internal links.
const modules: WorkspaceModule[] = [
  { ddl: assetsDDL, operations: assetOperations, resourcePaths: [] },
  { ddl: libraryDDL, operations: libraryOperations, resourcePaths: ['diaries', 'characters'] },
  { ddl: sourcesDDL + externalDDL, operations: [...sourceOperations, ...externalOperations], resourcePaths: ['sources', 'judgments', 'research'] },
  { ddl: storyDDL, operations: storyOperations, resourcePaths: ['scenes', 'drafts', 'chapters', 'events', 'narratives', 'branches'] },
  { ddl: generationDDL, operations: generationOperations, resourcePaths: ['templates', 'writing-requirements', 'generation-plans', 'generation-batches', 'generations'] },
  { ddl: jobsDDL, operations: [...jobsOperations, taskActivity], resourcePaths: ['jobs', 'media', 'compositions'] },
];

export const workspaceSchemaVersion = 4;
export const workspaceDDL = modules.map(module => module.ddl).join('\n');
export const workspaceOperations = modules.flatMap(module => module.operations);
export const workspaceResourcePaths = modules.flatMap(module => module.resourcePaths);
