import type { DatabaseSync } from 'node:sqlite';
import { Type } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { requireProject } from '../library/storage.ts';
import { generationBatchOperations } from './batches.ts';
import { assertText, validateOutput, validateTemplate } from './composition.ts';
import {
  generation, generationResult, generationStoryRef, generationSummary, id, inputFields, listOf, pagination, plan, planDefinition,
  promptInspection, promptPage, promptPageInput, referenceInput, requirements, requirementsDefinition, resultLink, revision,
  strict, template, templateDefinition, title, type Requirements, type Template,
} from './contracts.ts';
import { readPromptPage } from './prompt-page.ts';
import { prepareComposition } from './prompt.ts';
import { pinReferences } from './references.ts';
import {
  completeGeneration, enqueueDelegation, insertGeneration, listDefinitions, listGenerations, readDefinition, readGeneration,
  readGenerationPrompt, readGenerationSummary, readPlan, readResult, summarizeDefinition, writeDefinition,
} from './storage.ts';

export { generationDDL } from './storage.ts';
export { processNextGeneration, startGenerationWorker, type GenerationWorkerOptions } from './worker.ts';
export { createOpenAICompatibleProvider, type GenerationProvider, type GenerationProviderRequest } from './provider.ts';

const namedPage = Type.Object({ name: Type.Optional(title), ...pagination }, strict);
const expectedRevision = revision;
const readRevision = Type.Optional(revision);
const resultInteraction = { resultLink };

function readTemplate(db: DatabaseSync, templateId: string, revision?: number): Template {
  const { data, ...summary } = readDefinition<Pick<Template, 'kind' | 'fields'>>(db, 'template', templateId, revision);
  return { templateId, ...data, ...summary };
}

function readRequirements(db: DatabaseSync, requirementId: string, revision?: number): Requirements {
  const { data, ...summary } = readDefinition<Pick<Requirements, 'viewpoint' | 'tone' | 'constraints'>>(db, 'requirements', requirementId, revision);
  return { requirementId, ...data, ...summary };
}

export const generationOperations = [
  defineOperation({
    id: 'templates.list', effect: 'read',
    description: 'Find reusable structure templates by title. Built-ins also accept Chinese names such as 日记, 短篇故事, 短篇小说, 剧本 and 分镜. Exact titles take precedence. Get a template to read its ordered fields.',
    inputSchema: namedPage, outputSchema: listOf(Type.Pick(template, ['templateId', 'title', 'revision', 'href'])),
    run({ name, limit = 20, offset = 0 }, { db }) {
      assertText(name);
      return { items: listDefinitions(db, 'template', name, limit, offset).map(row => ({
        templateId: row.definition_id, ...summarizeDefinition('template', row),
      })) };
    },
  }),
  defineOperation({
    id: 'templates.get', effect: 'read',
    description: 'Read a template and its ordered fields. Supply revision to retrieve an exact historical definition.',
    inputSchema: Type.Object({ templateId: id, revision: readRevision }, strict), outputSchema: template,
    interaction: resultInteraction,
    run: ({ templateId, revision }, { db }) => readTemplate(db, templateId, revision),
  }),
  defineOperation({
    id: 'templates.create', effect: 'write',
    description: 'Create a reusable structure template. Field order is significant. Fields are required by default. A sections field repeats a group of child fields.',
    inputSchema: Type.Object(templateDefinition, strict), outputSchema: template, interaction: resultInteraction,
    run(input, { db }) {
      assertText(input.title);
      validateTemplate(input.fields);
      return readTemplate(db, writeDefinition(db, 'template', input));
    },
  }),
  defineOperation({
    id: 'templates.update', effect: 'write',
    description: 'Save a full new template revision. Supply expectedRevision from the current template. Earlier generations retain their pinned versions.',
    inputSchema: Type.Object({ templateId: id, expectedRevision, ...templateDefinition }, strict),
    outputSchema: template, interaction: resultInteraction,
    run({ templateId, expectedRevision, ...input }, { db }) {
      assertText(input.title);
      validateTemplate(input.fields);
      return readTemplate(db, writeDefinition(db, 'template', input, { id: templateId, expectedRevision }));
    },
  }),
  defineOperation({
    id: 'writing.requirements.list', effect: 'read',
    description: 'List reusable writing requirements. Use name for an exact case-insensitive title match.',
    inputSchema: namedPage, outputSchema: listOf(Type.Pick(requirements, ['requirementId', 'title', 'revision', 'href'])),
    run({ name, limit = 20, offset = 0 }, { db }) {
      assertText(name);
      return { items: listDefinitions(db, 'requirements', name, limit, offset).map(row => ({
        requirementId: row.definition_id, ...summarizeDefinition('requirements', row),
      })) };
    },
  }),
  defineOperation({
    id: 'writing.requirements.get', effect: 'read',
    description: 'Read reusable writing requirements including viewpoint, tone, and constraints. Supply revision for a historical version.',
    inputSchema: Type.Object({ requirementId: id, revision: readRevision }, strict), outputSchema: requirements,
    interaction: resultInteraction,
    run: ({ requirementId, revision }, { db }) => readRequirements(db, requirementId, revision),
  }),
  defineOperation({
    id: 'writing.requirements.set', effect: 'write',
    description: 'Create reusable writing requirements or save a full revision by supplying both requirementId and expectedRevision.',
    inputSchema: Type.Object({ requirementId: Type.Optional(id), expectedRevision: Type.Optional(revision), ...requirementsDefinition }, strict),
    outputSchema: requirements, interaction: resultInteraction,
    run({ requirementId, expectedRevision, ...input }, { db }) {
      if ((requirementId === undefined) !== (expectedRevision === undefined)) {
        throw new OperationError(400, 'generation_requirement_revision_required', 'Supply both requirementId and expectedRevision to edit writing requirements.');
      }
      const { title, viewpoint, tone, constraints } = input;
      assertText(title, viewpoint, tone, ...(constraints ?? []));
      if (viewpoint === undefined && tone === undefined && constraints === undefined) {
        throw new OperationError(400, 'generation_requirements_empty', 'Provide a viewpoint, tone, or constraint.');
      }
      const target = requirementId !== undefined && expectedRevision !== undefined ? { id: requirementId, expectedRevision } : undefined;
      return readRequirements(db, writeDefinition(db, 'requirements', input, target));
    },
  }),
  defineOperation({
    id: 'generation.plans.list', effect: 'read',
    description: 'Find named delegation plans. Use name for an exact case-insensitive match when the author names a plan.',
    inputSchema: namedPage, outputSchema: listOf(Type.Pick(plan, ['planId', 'title', 'revision', 'href'])),
    run({ name, limit = 20, offset = 0 }, { db }) {
      assertText(name);
      return { items: listDefinitions(db, 'plan', name, limit, offset).map(row => ({
        planId: row.definition_id, ...summarizeDefinition('plan', row),
      })) };
    },
  }),
  defineOperation({
    id: 'generation.plans.get', effect: 'read',
    description: 'Read a named delegation plan, its provider alias, model, and supported request parameters. Supply revision for a historical version.',
    inputSchema: Type.Object({ planId: id, revision: readRevision }, strict), outputSchema: plan,
    interaction: resultInteraction,
    run: ({ planId, revision }, { db }) => readPlan(db, planId, revision),
  }),
  defineOperation({
    id: 'generation.plans.create', effect: 'write',
    description: 'Create a named OpenAI-compatible text delegation plan using a server-configured provider alias and requested model. Omitted parameters use the provider defaults.',
    inputSchema: Type.Object(planDefinition, strict), outputSchema: plan, interaction: resultInteraction,
    run(input, { db }) {
      assertText(input.title, input.model);
      return readPlan(db, writeDefinition(db, 'plan', input));
    },
  }),
  defineOperation({
    id: 'generation.plans.update', effect: 'write',
    description: 'Save a full new named plan revision. Supply expectedRevision from the current plan. Queued and historical delegations retain their pinned plan.',
    inputSchema: Type.Object({ planId: id, expectedRevision, ...planDefinition }, strict), outputSchema: plan,
    interaction: resultInteraction,
    run({ planId, expectedRevision, ...input }, { db }) {
      assertText(input.title, input.model);
      return readPlan(db, writeDefinition(db, 'plan', input, { id: planId, expectedRevision }));
    },
  }),
  defineOperation({
    id: 'generations.prepare', effect: 'write',
    description: 'Prepare and persist Sth writing context. Pin a saved telling with story (narrativeId, revision, branchId, using null for mainline). For an IF, optionally add checkpointRevision from a checkpoint that pins this exact telling. Only the viewpoint character can contribute local state. Explicit references can select pinned judgments, events, and source ranges. Character references include the description by default. Set includeDescription to false and select entryIds or entryId and original zero-based blockIndex to use specific blocks. Call generations.save with the structured draft.',
    inputSchema: Type.Object({
      ...inputFields, templateId: id, templateRevision: readRevision, requirementId: Type.Optional(id),
      requirementRevision: readRevision, references: Type.Optional(Type.Array(referenceInput, { maxItems: 32 })),
      story: Type.Optional(generationStoryRef),
    }, strict), outputSchema: generation, interaction: resultInteraction,
    run(input, { db }) {
      const { templateId, templateRevision, requirementId, requirementRevision, references = [], story, ...parts } = input;
      assertText(parts.title, parts.brief, ...references.map(reference => reference.excerpt));
      if (parts.projectId !== undefined) requireProject(db, parts.projectId);
      if (requirementId === undefined && requirementRevision !== undefined) {
        throw new OperationError(400, 'generation_requirement_required', 'Provide requirementId with requirementRevision.');
      }
      const context = prepareComposition({
        ...parts, title: parts.title.trim(), template: readTemplate(db, templateId, templateRevision),
        ...(requirementId === undefined ? {} : { requirements: readRequirements(db, requirementId, requirementRevision) }),
      }, pinReferences(db, references, story, parts.projectId));
      return readGeneration(db, insertGeneration(db, context));
    },
  }),
  defineOperation({
    id: 'generations.save', effect: 'write',
    description: 'Validate and save the actual structured draft composed in the current chat for a prepared generation. Supply reportedModel only if the current executor reported it. A prepared generation can produce one immutable result.',
    inputSchema: Type.Object({ generationId: id, output: Type.Unknown(), reportedModel: Type.Optional(title) }, strict),
    outputSchema: generation, interaction: resultInteraction,
    run({ generationId, output, reportedModel }, { db }) {
      const record = readGeneration(db, generationId);
      if (record.mode !== 'current-chat' || record.status !== 'prepared') {
        throw new OperationError(409, 'generation_not_prepared', 'Only an unsaved current-chat generation can be saved. Read the generation for its current status.');
      }
      assertText(reportedModel);
      const result = validateOutput(output, record.composition.template.fields);
      completeGeneration(db, record, {
        status: 'succeeded', output: result,
        execution: { ...record.execution, reportedModel: reportedModel ?? null, reportedModelSource: reportedModel === undefined ? null : 'chat-client' },
      });
      return readGeneration(db, generationId);
    },
  }),
  defineOperation({
    id: 'generations.start', effect: 'write',
    description: 'Queue one external draft only when the author explicitly requests a named plan. Use the identified planId and a current-chat generationId from generations.prepare. The delegated draft has its own record and shares the exact prepared inputs. Use generations.get with a fresh step to check progress.',
    inputSchema: Type.Object({ generationId: id, planId: id, planRevision: readRevision }, strict),
    outputSchema: generationSummary, interaction: resultInteraction,
    run({ generationId, planId, planRevision }, { db }) {
      const id = enqueueDelegation(db, generationId, readPlan(db, planId, planRevision));
      return readGenerationSummary(db, id);
    },
  }),
  defineOperation({
    id: 'generations.list', effect: 'read',
    description: 'List current-chat and delegated generation records. Filter by projectId or omit it to include all projects and personal drafts.',
    inputSchema: Type.Object({ projectId: Type.Optional(id), ...pagination }, strict), outputSchema: listOf(generationSummary),
    run: ({ projectId, limit = 20, offset = 0 }, { db }) => ({ items: listGenerations(db, projectId, limit, offset) }),
  }),
  defineOperation({
    id: 'generations.get', effect: 'read',
    description: 'Read generation status, pinned context and plan, requested and reported models, validation errors, and result link. Use a fresh step when polling.',
    inputSchema: Type.Object({ generationId: id }, strict), outputSchema: generation, interaction: resultInteraction,
    run: ({ generationId }, { db }) => readGeneration(db, generationId),
  }),
  defineOperation({
    id: 'generations.prompt', effect: 'read',
    description: 'Read the ordered Sth prompt with pinned provenance and dispatch status. Selected media parts carry immutable asset metadata and SHA-256. Historical records may lack provenance and dispatch evidence. Current-chat records describe context provided by Sth.',
    inputSchema: Type.Object({ generationId: id }, strict), outputSchema: promptInspection, interaction: resultInteraction,
    run: ({ generationId }, { db }) => readGenerationPrompt(db, generationId),
  }),
  defineOperation({
    id: 'generations.prompt.page', effect: 'read',
    description: 'Read a bounded fragment of the saved prompt messages array (default) or provenance array. Start without a cursor. Keep the same generationId and section, and pass nextCursor as cursor with a fresh stepId until it is null. Join fragments as-is in start order and parse the joined JSON once. Start, end (exclusive), totalLength and cursors count UTF-16 code units in the serialized array.',
    inputSchema: promptPageInput, outputSchema: promptPage,
    run: (input, { db }) => readPromptPage(db, input),
  }),
  defineOperation({
    id: 'generations.result.get', effect: 'read',
    description: 'Read the saved structured output by resultId from the generation record.',
    inputSchema: Type.Object({ resultId: id }, strict), outputSchema: generationResult, interaction: resultInteraction,
    run: ({ resultId }, { db }) => readResult(db, resultId),
  }),
  ...generationBatchOperations,
];
