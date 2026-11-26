import { ApiError, listAll, read } from './api.js';
import { display, properties } from './workspace-fields.js';
import { path, query } from './ui.js';

const resource = (route, title, prefix, key, extra = {}) => ({ route, title, prefix, key, ...extra });
export const domains = {
  sources: resource('sources', '资料', 'source', 'sourceId', { glyph: 'diary', tab: 'sources', create: '新建资料' }),
  judgments: resource('judgments', '判断', 'judgment', 'judgmentId', { glyph: 'book', tab: 'sources', create: '新建判断' }),
  events: resource('events', '事件', 'event', 'eventId', { glyph: 'diary', tab: 'create', create: '新建事件', verbs: { create: 'save', revise: 'save' } }),
  narratives: resource('narratives', '讲述', 'narrative', 'narrativeId', { glyph: 'pen', tab: 'create', create: '新建讲述', scope: 'sceneId', verbs: { create: 'save', revise: 'save' } }),
  branches: resource('branches', 'IF 分支', 'branch', 'branchId', { glyph: 'folder', tab: 'create', verbs: { revise: 'save' } }),
  scenes: resource('scenes', '场景', 'scene', 'sceneId', { glyph: 'diary', tab: 'create', create: '新建场景' }),
  drafts: resource('drafts', '候选稿', 'draft', 'draftId', { glyph: 'pen', tab: 'create', create: '新建候选稿', scope: 'sceneId' }),
  chapters: resource('chapters', '章节', 'chapter', 'chapterId', { glyph: 'folder', tab: 'create', create: '新建章节' }),
  templates: resource('templates', '内容模板', 'templates', 'templateId', { glyph: 'diary', tab: 'create', create: '新建模板', verbs: { read: 'get', revise: 'update' } }),
  'writing-requirements': resource('writing-requirements', '写作要求', 'writing.requirements', 'requirementId', { glyph: 'pen', tab: 'create', create: '新建写作要求', verbs: { read: 'get', create: 'set', revise: 'set' } }),
  'generation-plans': resource('generation-plans', '生成方案', 'generation.plans', 'planId', { glyph: 'folder', tab: 'create', create: '新建生成方案', verbs: { read: 'get', revise: 'update' } }),
  generations: resource('generations', '生成记录', 'generations', 'generationId', { glyph: 'diary', tab: 'jobs', create: '准备写作', verbs: { read: 'get', create: 'prepare' } }),
  'generation-batches': resource('generation-batches', '文本批量任务', 'generation.batches', 'batchId', { glyph: 'folder', tab: 'jobs', create: '新建文本批量任务', verbs: { read: 'get' } }),
  jobs: resource('jobs', '任务', 'jobs', 'jobId', { glyph: 'folder', tab: 'jobs', create: '新建任务' }),
  media: resource('media', '媒体', 'media', 'mediaId', { glyph: 'folder', tab: 'jobs' }),
  compositions: resource('compositions', '构图候选', 'composition', 'compositionId', { glyph: 'pen', tab: 'jobs', create: '新建构图', scope: 'projectId' }),
};

export const creationLinks = [
  ['/create', '场景'], ['/projects', '作品'], ['/chapters', '章节'], ['/templates', '内容模板'],
  ['/writing-requirements', '写作要求'], ['/generation-plans', '生成方案'],
];
export const taskLinks = [
  ['/jobs', '全部任务'], ['/generations', '生成记录'], ['/generation-batches', '文本批量任务'], ['/compositions', '构图候选'], ['/media', '媒体'],
];
export const researchLinks = [['/sources', '已归档资料'], ['/research', '外部检索'], ['/judgments', '判断']];

const aliases = { candidates: 'drafts', requirements: 'writing-requirements', plans: 'generation-plans', records: 'generations', tasks: 'jobs' };
export const domainFor = section => Object.hasOwn(domains, section) ? domains[section] : Object.hasOwn(aliases, section) ? domains[aliases[section]] : undefined;
export const operation = (catalog, domain, verb) => {
  const id = `${domain.prefix}.${domain.verbs?.[verb] ?? verb}`;
  return catalog.has(id) ? id : undefined;
};
export const schemaOf = (catalog, id) => catalog.get(id)?.inputSchema;
export const inputFor = (catalog, id, values) => Object.fromEntries(properties(schemaOf(catalog, id))
  .filter(([key]) => Object.hasOwn(values, key) && values[key] !== undefined && values[key] !== '')
  .map(([key]) => [key, values[key]]));

export function internalHref(value) {
  if (typeof value !== 'string' || !/^\/(?!\/)[\w%/-]+(?:[?#][^\\\u0000-\u0020]*)?$/.test(value)) return '';
  const url = new URL(value, location.origin);
  return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : '';
}

export function recordHref(domain, record, pinned = false) {
  const id = record?.[domain.key];
  const href = internalHref(record?.href);
  if (id) {
    return query(path(domain.route, id), { revision: pinned ? record.revision : undefined });
  }
  return href;
}

export const version = value => Number.isSafeInteger(value) && value > 0 ? `第 ${value} 版` : '';
export const nameOf = (record, fallback = '未命名') => record?.title ?? record?.name ?? record?.label ?? fallback;

export async function readRecord(catalog, domain, id, revision, signal) {
  const operationId = operation(catalog, domain, 'read');
  if (!operationId) throw new ApiError(404, 'operation_not_available');
  return read(operationId, inputFor(catalog, operationId, { [domain.key]: id, revision }), signal);
}

const refs = {
  projectId: ['project.list', 'projectId'], characterId: ['character.list', 'characterId'],
  sourceId: ['source.list', 'sourceId'], sceneId: ['scene.list', 'sceneId'], chapterId: ['chapter.list', 'chapterId'],
  draftId: ['draft.list', 'draftId'], templateId: ['templates.list', 'templateId'],
  requirementId: ['writing.requirements.list', 'requirementId'], planId: ['generation.plans.list', 'planId'],
  compositionId: ['composition.list', 'compositionId'], generationId: ['generations.list', 'generationId'],
  eventId: ['event.list', 'eventId'], narrativeId: ['narrative.list', 'narrativeId'], branchId: ['branch.list', 'branchId'], judgmentId: ['judgment.list', 'judgmentId'],
};

export async function referenceChoices(catalog, schema, context, signal) {
  const keys = new Set();
  function collect(rule) {
    for (const [key, child] of properties(rule)) {
      keys.add(key);
      collect(child);
    }
    if (rule?.items) collect(rule.items);
    for (const variant of rule?.anyOf ?? rule?.oneOf ?? []) collect(variant);
  }
  collect(schema);
  const result = await Promise.all(Object.entries(refs).map(async ([key, [id, identity]]) => {
    const plural = `${key}s`;
    if ((!keys.has(key) && !keys.has(plural)) || !catalog.has(id)) return [];
    const input = inputFor(catalog, id, context);
    if (schemaOf(catalog, id)?.required?.some(key => !Object.hasOwn(input, key))) return [];
    const records = (await listAll(id, input, signal)).filter(record => key !== 'generationId' || record.mode === 'current-chat');
    return [[key, records], [plural, records]].map(([name, data]) => [name, data.map(record =>
      [record[identity], [nameOf(record, record[identity]), version(record.revision)].filter(Boolean).join(' · '), record])]);
  }));
  const choices = Object.fromEntries(result.flat());
  if (keys.has('references')) {
    const operations = [['source', 'sourceId'], ['scene', 'sceneId'], ['character', 'characterId'], ['judgment', 'judgmentId'], ['event', 'eventId']];
    const all = await Promise.all(operations.filter(([kind]) => catalog.has(`${kind}.list`)).map(([kind, key]) => listAll(`${kind}.list`,
      kind === 'event' && context.branchId ? { branchId: context.branchId } : {}, signal)
      .then(records => [kind, records.map(record => [record[key], `${nameOf(record)} · ${version(record.revision)}`, record])])));
    choices.byKind = Object.fromEntries(all);
    choices.byKind.draft = [];
    if (catalog.has('draft.list')) {
      const scenes = choices.byKind.scene;
      for (let offset = 0; offset < scenes.length; offset += 8) {
        const group = await Promise.all(scenes.slice(offset, offset + 8).map(async ([sceneId, sceneTitle]) => {
          const drafts = await listAll('draft.list', { sceneId }, signal);
          return drafts.map(draft => [draft.draftId, `${nameOf(draft)} · ${sceneTitle} · ${version(draft.revision)}`, draft]);
        }));
        choices.byKind.draft.push(...group.flat());
      }
    }
  }
  return choices;
}

export function stateText(record) {
  return record?.status ? display(record.status) : '';
}
