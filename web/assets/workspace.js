import { ApiError, catalog as loadCatalog, listAll, mediaProvider, pager, read } from './api.js';
import { bindWrite, errorBox, operationPage, workspaceError } from './workspace-actions.js';
import { display, literals, properties } from './workspace-fields.js';
import { creationLinks, domainFor, domains, inputFor, internalHref, nameOf, operation, readRecord, recordHref, referenceChoices, researchLinks, schemaOf, stateText, taskLinks, version } from './workspace-model.js';
import { anchor, backlinkList, facts, impactRows, outputPreview, prose, recordBody, recordRows, section, sourceScene } from './workspace-view.js';
import { back, button, empty, esc, field, heading, link, path, query, subnav, time } from './ui.js';
import { characterSelections, promptPage } from './prompt.js';
import { characterBacklinksView } from './character-blocks.js';
import { taskProgress } from './tasks.js';
import { adoptEntries } from './adoption.js';
import { bindPassage, contextText, passageHref, passageView, pinFromSelection, rangeFrom, sourcePin } from './passages.js';
import { bindStoryDetail, sceneStory, storyDetail, storyForm } from './story-context.js';

const scopes = { projectId: ['project.list', 'projectId', '项目'], sceneId: ['scene.list', 'sceneId', '场景'] };
const effects = { revise: '保存修订', adopt: '采纳候选稿', branch: '建立 IF 分支', arrange: '编排章节',
  select: '选择构图', cancel: '取消待执行项', retry: '重试失败项', reconcile: '核对待确认项', start: '用指定方案生成对照稿', save: '保存结构化稿件' };

function tabs(catalog, domain, params) {
  if (domain.tab === 'sources') return subnav('资料工作区', researchLinks.filter(([href]) =>
    href === '/sources' || catalog.has(href === '/research' ? 'external.providers' : 'judgment.list')), `/${domain.route}`);
  const group = domain.tab === 'create' ? creationLinks : domain.tab === 'jobs' ? taskLinks : null;
  if (!group) return '';
  const scope = href => ['/templates', '/writing-requirements', '/generation-plans', '/generation-batches'].includes(href) ? href :
    query(href, { projectId: params.get('projectId'), sceneId: href === '/compositions' ? params.get('sceneId') : undefined });
  const current = domain === domains.scenes ? '/create' : `/${domain.route}`;
  return subnav(domain.tab === 'create' ? '创作工作区' : '任务视图', group.map(([href, text]) => [scope(href), text]), scope(current));
}

function actionHref(href, action, params = {}) {
  const url = new URL(href, location.origin);
  return query(url.pathname, { ...Object.fromEntries(url.searchParams), ...params, action });
}

function positive(value) {
  const number = Number(value);
  return /^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(number) ? number : undefined;
}

function searchControl(catalog, domain, list, params, choices) {
  const rule = schemaOf(catalog, list)?.properties ?? {};
  const search = operation(catalog, domain, 'search');
  const term = search ? 'query' : rule.name ? 'name' : rule.title ? 'title' : '';
  const fields = Object.entries(choices).map(([key, values]) => field(key, scopes[key][2], {
    value: params.get(key) ?? '', required: false, options: [['', domain.scope === key ? '请选择' : '全部'], ...values],
  })).join('');
  const kinds = rule.kind ? field('kind', '类型', { value: params.get('kind') ?? '', required: false,
    options: [['', '全部'], ...literals(rule.kind).map(value => [value, display(value)])] }) : '';
  const searchField = term ? field('q', search ? '关键词' : '完整名称', { type: 'search', required: false,
    value: params.get('q') ?? '', schema: search ? schemaOf(catalog, search).properties.query : rule[term] }) : '';
  const html = fields + kinds + searchField;
  return { term, html: html ? `<search><form action="/${domain.route}" class="workspace-filter" aria-label="筛选${domain.title}">
    ${html}${button('workspace-filter', searchField ? '搜索' : '筛选', null, 'secondary', 'submit')}</form></search>` : '' };
}

const providerStates = { ready: '可用', unconfigured: '未配置', invalid_config: '配置无效', unreachable: '无法连接' };
const providerView = provider => provider ? `<p class="masthead-meta">图片供应商 · ${esc(providerStates[provider.status] ?? '状态未知')}${provider.provider ? ` · ${esc(provider.provider)}` : ''}</p>` : '';

async function listPage(ctx, catalog, domain) {
  const params = ctx.url.searchParams;
  const list = operation(catalog, domain, 'list');
  const rules = schemaOf(catalog, list)?.properties ?? {};
  const scopeEntries = await Promise.all(Object.entries(scopes).filter(([key]) => rules[key])
    .map(async ([key, [operationId, identity]]) => [key, (await listAll(operationId, {}, ctx.signal)).map(item => [item[identity], nameOf(item)])]));
  const choices = Object.fromEntries(scopeEntries);
  const { html: search, term } = searchControl(catalog, domain, list, params, choices);
  const text = params.get('q')?.trim();
  const filters = Object.fromEntries(scopeEntries.map(([key]) => [key, params.get(key)]).filter(([, value]) => value));
  if (domain === domains.events && params.get('branchId')) filters.branchId = params.get('branchId');
  const op = (text && operation(catalog, domain, 'search')) || list;
  const missing = domain.scope && !filters[domain.scope];
  const next = op && !missing ? await pager(op, inputFor(catalog, op, { ...filters, [term]: text, kind: params.get('kind') || undefined }), ctx.signal) : undefined;
  const [initial, provider] = await Promise.all([
    next ? next() : { records: [], more: false }, domain === domains.jobs ? mediaProvider(ctx.signal).catch(() => null) : null,
  ]);
  const records = [...initial.records];
  const create = operation(catalog, domain, 'create');
  const scopedCreate = domain === domains.drafts ? !missing : true;
  const actions = create && scopedCreate ? link(query(`/${domain.route}/new`, filters), domain.create, 'plus', 'primary') : '';
  function contents() {
    if (records.length) return recordRows(records, domain, { level: 2 });
    if (!list) return empty(domain.glyph, '此功能暂不可用');
    if (missing) return empty(domain.glyph, `请选择${scopes[domain.scope][2]}`);
    return empty(domain.glyph, text ? '没有匹配的记录' : `还没有${domain.title}`);
  }
  const title = ctx.url.pathname === '/create' ? '创作' : domain.title;
  const createWriting = domain === domains.scenes && catalog.has('generations.prepare') ? link('/generations/new', '准备写作', 'pen', 'secondary') : '';
  const branchAccess = domain === domains.scenes && catalog.has('branch.list') ? link('/branches', 'IF 分支', null, 'quiet') : '';
  const rows = () => domain === domains.sources && text ? `<ul class="workspace-notes passage-matches">${records.map(record => `<li>${anchor(query(path('sources', record.sourceId), { revision: record.revision, q: text }), record.title)}
    ${record.origin ? `<p class="row-meta">${esc(record.origin)}</p>` : ''}</li>`).join('')}</ul>` : contents();
  if (!ctx.show(title, `${heading(title, { actions: actions + createWriting + branchAccess, meta: providerView(provider) })}${tabs(catalog, domain, params)}${search}
    <p class="workspace-count count" id="workspace-count" role="status">${records.length} 条记录</p>
    <div id="workspace-list">${records.length ? rows() : contents()}</div><div class="load-more"${initial.more ? '' : ' hidden'}>
      ${button('workspace-more', '加载更多', null, 'secondary')}<span id="workspace-list-status" role="status"></span></div>`)) return;
  ctx.main.querySelector('search form')?.addEventListener('submit', event => {
    event.preventDefault();
    ctx.go(query(`/${domain.route}`, Object.fromEntries(new FormData(event.currentTarget))));
  });
  const more = ctx.main.querySelector('#workspace-more');
  more.onclick = async () => {
    more.disabled = true;
    const status = ctx.main.querySelector('#workspace-list-status');
    try {
      const previous = records.length;
      const page = await next();
      if (!ctx.active()) return;
      records.push(...page.records);
      ctx.main.querySelector('#workspace-list').innerHTML = records.length ? rows() : contents();
      ctx.main.querySelector('#workspace-count').textContent = `${records.length} 条记录`;
      if (!page.more) more.hidden = true;
      (ctx.main.querySelectorAll('#workspace-list .row')[previous] ?? ctx.main.querySelector('h1'))?.focus();
    } catch (error) {
      if (ctx.active()) status.textContent = workspaceError(error);
    } finally {
      more.disabled = false;
    }
  };
}

async function chapterScenes(catalog, chapter, signal) {
  const scenes = [...chapter.scenes];
  const op = operation(catalog, domains.chapters, 'read');
  while (scenes.length < chapter.sceneCount) {
    const page = await read(op, { chapterId: chapter.chapterId, offset: scenes.length, limit: 50 }, signal);
    if (page.revision !== chapter.revision || !page.scenes.length) throw new ApiError(409, 'chapter_revision_conflict');
    scenes.push(...page.scenes);
  }
  return scenes;
}

async function history(catalog, domain, record, signal) {
  const id = operation(catalog, domain, 'history') ?? operation(catalog, domain, 'revisions');
  if (id) return listAll(id, { [domain.key]: record[domain.key] }, signal);
  if (!schemaOf(catalog, operation(catalog, domain, 'read'))?.properties?.revision || !record.revision) return [];
  const latest = await readRecord(catalog, domain, record[domain.key], undefined, signal);
  return Array.from({ length: latest.revision }, (_, index) => ({ [domain.key]: record[domain.key], revision: latest.revision - index }));
}

function historyView(domain, record, snapshots) {
  return snapshots.length ? section('版本历史', `<ul class="workspace-history" role="list">${snapshots.map(item =>
    `<li>${anchor(recordHref(domain, item, true), `${version(item.revision)}${item.title && item.title !== record.title ? ` · ${item.title}` : ''}`)}${item.revision === record.revision ? '<span class="row-meta">正在阅读</span>' : ''}</li>`).join('')}</ul>`) : '';
}

async function createPage(ctx, catalog, domain) {
  const id = operation(catalog, domain, 'create');
  if (!id) return listPage(ctx, catalog, domain);
  const params = ctx.url.searchParams;
  if ([domains.events, domains.narratives].includes(domain) && await storyForm(ctx, catalog, domain, null, 'new')) return;
  const values = Object.fromEntries(['projectId', 'sceneId', 'branchId'].map(key => [key, params.get(key)]).filter(([, value]) => value));
  const fixed = {};
  let backTo = query(`/${domain.route}`, values);
  if (domain === domains.scenes && values.branchId) {
    fixed.branchId = values.branchId;
    backTo = path('branches', values.branchId);
  }
  if (domain === domains.judgments || domain === domains.scenes) {
    const pin = await sourcePin(params, ctx.signal);
    if (pin) {
      if (domain === domains.judgments) values.evidence = [{ stance: 'support', pin }];
      else values.sources = [pin];
      backTo = passageHref('sources', pin.sourceId, pin.revision, pin.range);
    }
  }
  if (domain === domains.generations && params.get('narrativeId') && schemaOf(catalog, id).properties.story) {
    const narrativeId = params.get('narrativeId');
    const revision = positive(params.get('narrativeRevision'));
    const narrative = await read('narrative.read', { narrativeId, revision }, ctx.signal);
    fixed.story = { narrativeId: narrative.narrativeId, revision: narrative.revision, branchId: narrative.branchId };
    fixed.sceneId = undefined;
    values.title = narrative.title;
    backTo = passageHref('narratives', narrative.narrativeId, narrative.revision);
    if (params.has('checkpointRevision')) {
      const checkpointRevision = positive(params.get('checkpointRevision'));
      if (!checkpointRevision || !narrative.branchId || narrative.branchId !== params.get('branchId') ||
        !schemaOf(catalog, id).properties.story.properties.checkpointRevision) {
        throw new ApiError(400, 'invalid_checkpoint', '需要为所选 IF 讲述指定接续版本。');
      }
      fixed.story.checkpointRevision = checkpointRevision;
      backTo = passageHref('branches', narrative.branchId, checkpointRevision);
    }
    if (narrative.viewpoint.kind === 'character') fixed.references = undefined;
  }
  if (domain === domains.generations && !Object.hasOwn(fixed, 'story')) fixed.story = undefined;
  if (domain === domains.generations && params.get('draftId') && !params.get('narrativeId')) {
    const draft = await read('draft.read', { draftId: params.get('draftId'), revision: positive(params.get('draftRevision')) }, ctx.signal);
    values.title = draft.title;
    values.references = [{ kind: 'draft', id: draft.draftId, revision: draft.revision }];
    backTo = passageHref('drafts', draft.draftId, draft.revision);
  }
  if (values.sceneId && [domains.drafts, domains.compositions].includes(domain)) {
    const scene = await readRecord(catalog, domains.scenes, values.sceneId, positive(params.get('revision')), ctx.signal);
    Object.assign(fixed, { sceneId: scene.sceneId, sceneRevision: scene.revision });
    if (domain === domains.compositions && scene.placement?.projectId) fixed.projectId = scene.placement.projectId;
  }
  if (domain === domains.jobs) return jobForm(ctx, catalog, values.projectId, params.get('compositionId'));
  if (domain === domains['writing-requirements']) Object.assign(fixed, { requirementId: undefined, expectedRevision: undefined });
  const base = schemaOf(catalog, id);
  const items = base.properties.references?.items;
  const character = (items?.anyOf ?? items?.oneOf)?.find(item => item.properties?.selections);
  // Render the shared reference fields once. Add block selection only for character references.
  const schema = character && { ...base, properties: { ...base.properties,
    references: { ...base.properties.references, items: { ...character, properties: {
      ...Object.fromEntries(properties(character).filter(([key]) => !['entryIds', 'selections', 'includeDescription'].includes(key))),
      ...(items.anyOf ?? items.oneOf).find(item => item.properties?.range)?.properties?.range && {
        range: (items.anyOf ?? items.oneOf).find(item => item.properties?.range).properties.range,
      },
      kind: { enum: (items.anyOf ?? items.oneOf).flatMap(item => literals(item.properties.kind)) },
    } } },
  } };
  return operationPage(ctx, catalog, { id, title: domain.create, backTo: fixed.sceneId ? path('scenes', fixed.sceneId) : backTo, schema,
    subtitle: fixed.story ? `${values.title} · 讲述${version(fixed.story.revision)}${fixed.story.checkpointRevision ? ` · 接续${version(fixed.story.checkpointRevision)}` : ''}` : undefined,
    referenceExtras: character && (controls => characterSelections(ctx, controls)),
    values, fixed, orderable: domain === domains.templates ? ['fields'] : undefined,
    complete: result => ctx.saved(recordHref(domain, result) || backTo, '已保存') });
}

function cleanScenePins(record) {
  return { ...record, characters: record.characters?.map(({ characterId, revision }) => ({ characterId, revision })),
    sources: record.sources?.map(({ sourceId, revision, excerpt, range }) => ({ sourceId, revision, excerpt, range })) };
}

async function editAction(ctx, catalog, domain, record, action, pinned) {
  if (action !== 'revise' && !{
    adopt: [domains.drafts, domains.scenes], branch: [domains.scenes], arrange: [domains.chapters],
    start: [domains.generations], save: [domains.generations],
  }[action]?.includes(domain)) return false;
  const detail = recordHref(domain, record, Boolean(pinned));
  const latest = () => readRecord(catalog, domain, record[domain.key], undefined, ctx.signal);
  const current = pinned && ['revise', 'adopt'].includes(action) ? await latest() : record;
  let id = operation(catalog, domain, action);
  let title = action === 'revise' ? `修订${domain.title}` : effects[action];
  let fixed = { [domain.key]: record[domain.key] };
  let values = action === 'revise' ? current : {};
  let schema;
  let choices;
  let orderable;
  let outputDomain = domain;
  if (action === 'revise') {
    fixed.expectedRevision = current.revision;
    if (domain === domains.scenes) values = cleanScenePins(current);
    if (domain === domains.templates) orderable = ['fields'];
  }
  if (action === 'branch') fixed.revision = record.revision;
  if (domain === domains.judgments && action === 'revise') {
    values = { ...current, evidence: current.evidence.map(({ stance, pin: { href, ...pin } }) => ({ stance, pin })) };
  }
  if (domain === domains.scenes && action === 'branch') {
    const draftId = ctx.url.searchParams.get('draftId');
    const revision = positive(ctx.url.searchParams.get('draftRevision'));
    if (draftId && revision) fixed.draft = { draftId, revision };
    if (schemaOf(catalog, id)?.properties.narrative) Object.assign(fixed, { narrative: undefined, sharedEvents: undefined });
  }
  if (domain === domains.drafts && action === 'adopt') {
    id = operation(catalog, domains.scenes, 'adopt');
    const scene = await readRecord(catalog, domains.scenes, record.sceneId, undefined, ctx.signal);
    fixed = { sceneId: scene.sceneId, expectedRevision: scene.revision, draftId: record.draftId, draftRevision: record.revision };
    outputDomain = domains.scenes;
  }
  if (domain === domains.scenes && action === 'adopt') fixed.expectedRevision = current.revision;
  if (action === 'arrange') {
    fixed.expectedRevision = record.revision;
    values = { sceneIds: (await chapterScenes(catalog, record, ctx.signal)).map(scene => scene.sceneId) };
    const scenes = await listAll('scene.list', {}, ctx.signal);
    choices = { sceneIds: scenes.filter(scene => !scene.placement || scene.placement.chapterId === record.chapterId)
      .map(scene => [scene.sceneId, scene.title, scene]) };
    orderable = ['sceneIds'];
  }
  if (action === 'save' && domain === domains.generations) {
    const base = schemaOf(catalog, id);
    schema = { ...base, properties: { ...base.properties, output: templateOutputSchema(record.composition.template.fields) } };
  }
  if (!id || !title) return false;
  await operationPage(ctx, catalog, { id, title, subtitle: `${nameOf(record, domain.title)}${record.revision ? ` · ${version(record.revision)}` : ''}`,
    backTo: detail, values, fixed, choices, schema, orderable, clearable: ['origin', 'time', 'place', 'scope', 'projectId'], latest,
    submit: action === 'revise' ? effects.revise : title, complete(result) {
      ctx.saved(recordHref(outputDomain, result) || detail, '已保存');
    } });
  return true;
}

function templateOutputSchema(fields) {
  return { type: 'object', required: fields.filter(field => field.required !== false).map(field => field.key),
    properties: Object.fromEntries(fields.map(field => [field.key, { title: field.label, description: field.description, ...(
      field.type === 'sections' ? { type: 'array', items: templateOutputSchema(field.fields), minItems: field.minItems, maxItems: field.maxItems }
        : field.type === 'text' ? { type: 'string', maxLength: field.maxLength, format: 'multiline' }
          : { type: field.type, minimum: field.minimum, maximum: field.maximum }
    ) }])) };
}

async function comparePage(ctx, catalog, scene) {
  const href = recordHref(domains.scenes, scene);
  const drafts = await listAll('draft.list', { sceneId: scene.sceneId }, ctx.signal);
  const revisions = (await Promise.all(drafts.map(draft => history(catalog, domains.drafts, draft, ctx.signal)))).flat();
  const refKey = draft => `${draft.draftId}@${draft.revision}`;
  const options = revisions.map(draft => [refKey(draft), `${draft.title} · ${version(draft.revision)}`]);
  const params = ctx.url.searchParams;
  const left = revisions.find(draft => refKey(draft) === params.get('left')) ?? revisions[0];
  const right = revisions.find(draft => refKey(draft) === params.get('right')) ?? revisions.find(draft => draft.draftId !== left?.draftId) ?? revisions[1];
  const pin = ({ draftId, revision }) => ({ draftId, revision });
  const compared = left && right ? await read('draft.compare', { sceneId: scene.sceneId, left: pin(left), right: pin(right) }, ctx.signal) : undefined;
  if (!ctx.show('对照候选稿', `${heading('对照候选稿', { trail: back(href, scene.title) })}${compared ? `<form class="workspace-filter" id="compare-form" action="${esc(href)}">
    ${field('left', '左稿', { options, value: refKey(left) })}${field('right', '右稿', { options, value: refKey(right) })}
    ${button('compare-submit', '对照', null, 'primary', 'submit')}</form><div class="workspace-comparison">${[compared.left, compared.right].map((draft, index) =>
    `<article><h2>${index === 0 ? '左稿' : '右稿'} · ${anchor(recordHref(domains.drafts, draft, true), `${draft.title} · ${version(draft.revision)}`)}</h2>
    ${prose(draft.body)}${catalog.has('scene.adopt') ? link(actionHref(recordHref(domains.drafts, draft, true), 'adopt'), `采纳${index === 0 ? '左稿' : '右稿'}`, null, 'secondary') : ''}</article>`).join('')}</div>` :
    empty('pen', '需要两份稿件版本', '', link(query('/drafts/new', { sceneId: scene.sceneId, revision: scene.revision }), '新建候选稿', 'plus', 'secondary'))}`)) return;
  ctx.main.querySelector('#compare-form')?.addEventListener('submit', event => {
    event.preventDefault();
    ctx.go(actionHref(href, 'compare', Object.fromEntries(new FormData(event.currentTarget))));
  });
}

function inlineAction(catalog, bindings, key, id, input, label, confirm = false) {
  if (!catalog.has(id)) return '';
  bindings.set(key, { id, input });
  const form = `<form id="${key}" class="workspace-inline" method="post" action="/api/web/invoke" aria-label="${esc(label)}">
    ${button(`${key}-submit`, confirm ? '确认取消待执行项' : label, null, 'secondary', 'submit')}${errorBox}</form>`;
  return confirm ? `<details class="workspace-cancel"><summary>${esc(label)}</summary>${form}</details>` : form;
}

function taskDetail(catalog, record, bindings) {
  const { jobId, progress, items = [] } = record;
  const statuses = Object.entries(progress ?? {}).filter(([, count]) => count > 0);
  const actions = [['failed', 'retry'], ['unknown', 'reconcile'], ['queued', 'cancel']].map(([status, verb]) =>
    progress?.[status] ? inlineAction(catalog, bindings, `job-${verb}`, `jobs.${verb}`, { jobId }, effects[verb], verb === 'cancel') : '').join('');
  return section('进度', `${taskProgress(progress)}${facts(statuses.map(([key, value]) => [display(key), esc(value)]))}<div class="actions">${actions}</div>`) +
    section('任务明细', `<ol class="workspace-notes">${items.map((item, index) => `<li>
      <h3>${esc(item.title)} <span class="row-meta">· ${esc(display(item.status))}</span></h3>
      <div class="actions">${sourceScene(item)}${anchor(path('compositions', item.compositionId), '查看构图')}${item.mediaId ? anchor(path('media', item.mediaId), '查看生成图片') : ''}</div>
      ${item.attempt ? sectionAttempt(item.attempt) : ''}${item.reconciliationQueued ? '<p class="muted">已安排核对</p>' : ''}
      ${item.status === 'failed' ? inlineAction(catalog, bindings, `item-retry-${index}`, 'jobs.retry', { jobId, itemIds: [item.itemId] }, `重试 ${item.title}`) : ''}
      ${item.status === 'unknown' && !item.reconciliationQueued ? inlineAction(catalog, bindings, `item-check-${index}`, 'jobs.reconcile', { jobId, itemIds: [item.itemId] }, `核对 ${item.title}`) : ''}</li>`).join('')}</ol>`);
}

function sectionAttempt(attempt) {
  return `<details><summary>第 ${esc(attempt.number)} 次 · ${esc(attempt.provider)}</summary>${facts([
    ['上游任务', esc(attempt.providerJobId ?? '未知')], ['请求编号', esc(attempt.requestId)], ['message', esc(attempt.message)],
    ['updatedAt', time(attempt.updatedAt, 'stamp')],
  ])}${outputPreview(attempt.parameters)}</details>`;
}

function compositionDetail(catalog, record, bindings) {
  const selected = record.selectedCandidateId;
  return section('构图候选', `<ol class="workspace-notes">${record.candidates.map((item, index) => `<li><h3>${esc(item.title)}
    ${selected === item.candidateId ? '<span class="row-meta">· 已选用</span>' : ''}</h3>${prose(item.prompt)}
    ${selected !== item.candidateId ? inlineAction(catalog, bindings, `composition-select-${index}`, 'composition.select', {
      compositionId: record.compositionId, candidateId: item.candidateId, expectedSelectionRevision: record.selectionRevision,
    }, `选用 ${item.title}`) : ''}</li>`).join('')}</ol>`);
}

function textBatchDetail(catalog, record, bindings, offset) {
  const domain = domains['generation-batches'];
  const target = { batchId: record.batchId };
  const counts = Object.entries(record.counts).filter(([, count]) => count > 0);
  const action = (key, verb, text, confirm) => inlineAction(catalog, bindings, key, `generation.batches.${verb}`, target, text, confirm);
  const actions = (record.counts.failed ? action('batch-retry', 'retry-confirmed-failures', effects.retry) : '') +
    (record.counts.queued ? action('batch-cancel', 'cancel', effects.cancel, true) : '');
  const entries = list => `<ol class="workspace-notes">${list.map(({ position, attempt, generation }) => `<li>
    <h3>${anchor(recordHref(domains.generations, generation), `${position}. ${generation.title}`)}</h3>
    <p class="row-meta">第 ${esc(attempt)} 次 · ${esc(display(generation.status))}</p>
    ${generation.result ? anchor(internalHref(generation.result.href), '查看生成结果') : ''}</li>`).join('')}</ol>`;
  const href = recordHref(domain, record);
  return section('批量进度', `${taskProgress(record.counts)}${facts(counts.map(([key, count]) => [display(key), esc(count)]))}<div class="actions">${actions}</div>`) +
    section('生成方案', anchor(recordHref(domains['generation-plans'], record.plan, true), `${record.plan.title} · ${version(record.plan.revision)}`)) +
    section('各项当前状态', entries(record.items)) + section('尝试历史', entries(record.attempts) + `<div class="actions">
      ${offset ? link(query(href, { attemptOffset: Math.max(0, offset - 50) }), '上一页', null, 'secondary') : ''}
      ${record.nextAttemptOffset ? link(query(href, { attemptOffset: record.nextAttemptOffset }), '下一页', null, 'secondary') : ''}</div>`);
}

async function jobForm(ctx, catalog, projectId, selected) {
  const id = operation(catalog, domains.jobs, 'create');
  const projects = await listAll('project.list', {}, ctx.signal);
  if (!projectId) {
    if (!ctx.show('新建任务', `${heading('新建任务', { trail: back('/jobs', '任务') })}
      <form class="editor" id="job-project" action="/jobs/new">${field('projectId', '项目', {
        options: [['', '请选择'], ...projects.map(item => [item.projectId, item.title])],
      })}<div class="actions">${button('choose-project', '选择项目', null, 'primary', 'submit')}${link('/projects/new', '新建项目', null, 'quiet')}</div></form>`)) return;
    ctx.main.querySelector('#job-project').onsubmit = event => {
      event.preventDefault();
      ctx.go(query('/jobs/new', Object.fromEntries(new FormData(event.currentTarget))));
    };
    return;
  }
  const compositions = await listAll('composition.list', { projectId }, ctx.signal);
  const ready = await Promise.all(compositions.filter(item => item.selectedCandidateId).map(item => read('composition.read', { compositionId: item.compositionId }, ctx.signal)));
  const candidates = ready.map(item => ({ ...item, candidate: item.candidates.find(candidate => candidate.candidateId === item.selectedCandidateId) })).filter(item => item.candidate);
  const backTo = query('/jobs', { projectId });
  const base = schemaOf(catalog, id);
  const items = base.properties.items;
  const schema = { ...base, properties: { ...base.properties, items: { ...items, items: items.items.properties.compositionId } } };
  if (!candidates.length) {
    ctx.show('新建任务', `${heading('新建任务', { trail: back(backTo, '任务') })}${empty('folder', '这个项目还没有已选构图', '',
      link(query('/compositions', { projectId }), '查看构图候选', null, 'primary'))}`);
    return;
  }
  return operationPage(ctx, catalog, { id, title: '新建任务', submit: '启动任务', backTo, schema,
    subtitle: projects.find(item => item.projectId === projectId)?.title, fixed: { projectId, mode: 'manual', maxImages: undefined },
    values: selected && candidates.some(item => item.compositionId === selected) ? { items: [selected] } : {},
    choices: { items: candidates.map(item => [item.compositionId, `${item.scene.title} · ${item.candidate.title}`]) },
    input: input => ({ ...input, items: input.items.map(compositionId => ({ compositionId,
      candidateId: candidates.find(item => item.compositionId === compositionId)?.selectedCandidateId })) }),
    complete: result => ctx.saved(recordHref(domains.jobs, result), '任务已加入队列') });
}

async function impactPage(ctx, catalog, source, pinned) {
  const params = ctx.url.searchParams;
  const offset = positive(params.get('offset')) ?? 0;
  const currentOnly = params.get('currentOnly') === '1';
  const kind = params.get('kind') ?? '';
  const limit = 20;
  const detail = passageHref('sources', source.sourceId, pinned, rangeFrom(params));
  const kinds = literals(schemaOf(catalog, 'source.impact').properties.kind);
  const selectedKind = kinds.includes(kind) ? kind : undefined;
  const result = await read('source.impact', { sourceId: source.sourceId, revision: pinned, kind: selectedKind, currentOnly, limit, offset }, ctx.signal);
  const next = target => actionHref(detail, 'impact', { kind: selectedKind, currentOnly: currentOnly ? '1' : undefined, offset: target });
  const title = '资料影响';
  if (!ctx.show(title, `${heading(title, { trail: back(detail, source.title), meta: pinned ? `<p class="masthead-meta">资料${version(pinned)}</p>` : '' })}
    <form class="workspace-filter" id="impact-filter" action="${esc(path('sources', source.sourceId))}">
      ${field('kind', '资源类型', { value: selectedKind, required: false, options: [['', '全部资源'], ...kinds.map(value => [value, display(value)])] })}
      ${field('currentOnly', '版本范围', { value: currentOnly ? '1' : '', required: false, options: [['', '全部版本和快照'], ['1', '当前版本']] })}
      ${button('impact-search', '筛选', null, 'secondary', 'submit')}</form>
    ${result.items.length ? impactRows(result.items) : empty('book', '没有匹配的引用')}
    <div class="actions load-more">${offset ? link(next(Math.max(0, offset - limit)), '上一页', 'back', 'secondary') : ''}
      ${result.nextOffset ? link(next(result.nextOffset), '下一页', 'next', 'secondary') : ''}</div>`)) return;
  ctx.main.querySelector('#impact-filter').onsubmit = event => {
    event.preventDefault();
    ctx.go(actionHref(detail, 'impact', Object.fromEntries(new FormData(event.currentTarget))));
  };
}

async function detailPage(ctx, catalog, domain, id, suffix) {
  const params = ctx.url.searchParams;
  const pinned = positive(params.get('revision'));
  if (params.has('revision') && !pinned) throw new ApiError(400, 'invalid_revision', '版本号必须为正整数。');
  const textBatch = domain === domains['generation-batches'];
  const attemptOffset = positive(params.get('attemptOffset')) ?? 0;
  const record = textBatch ? await read(operation(catalog, domain, 'read'), { batchId: id, attemptOffset }, ctx.signal)
    : await readRecord(catalog, domain, id, pinned, ctx.signal);
  const latestHref = recordHref(domain, record);
  const href = recordHref(domain, record, Boolean(pinned));
  const listHref = query(`/${domain.route}`, { sceneId: domain === domains.drafts ? record.sceneId : undefined,
    projectId: domain === domains.compositions || domain === domains.chapters ? record.projectId : undefined });
  if (suffix === 'result') {
    if (!record.result || !catalog.has('generations.result.get')) throw new ApiError(404, 'generation_result_not_found');
    const result = await read('generations.result.get', { resultId: record.result.resultId }, ctx.signal);
    return ctx.show(result.title, `${heading(result.title, { trail: back(latestHref, '生成记录'), actions:
      (catalog.has('generations.prompt') ? link(`${latestHref}/prompt`, '提示词组成', 'book', 'secondary') : '') + link('/jobs', '全部任务', 'tasks', 'quiet') })}
      ${section('结构化正文', outputPreview(result.output, record.composition.template.fields))}`);
  }
  const action = params.get('action');
  if (domain === domains.sources && action === 'impact' && catalog.has('source.impact')) return impactPage(ctx, catalog, record, pinned);
  const storyDomain = [domains.events, domains.narratives, domains.branches].includes(domain);
  if (storyDomain && action && await storyForm(ctx, catalog, domain, record, action)) return;
  const passageKind = domain === domains.sources ? 'source' : domain === domains.drafts ? 'draft' : domain === domains.judgments ? 'judgment' : null;
  const passageText = record.body ?? record.statement;
  const selectedRange = rangeFrom(params);
  if (action === 'adopt-entry' && passageKind && catalog.has('character.adopt-entries')) return adoptEntries(ctx, catalog, passageKind, id, record, passageText);
  if (action === 'compare' && domain === domains.scenes && catalog.has('draft.compare')) return comparePage(ctx, catalog, record);
  if (action && ['revise', 'adopt', 'branch', 'arrange', 'start', 'save'].includes(action) && await editAction(ctx, catalog, domain, record, action, pinned)) return;
  const needsProjects = [domains.sources, domains.chapters].includes(domain);
  const [snapshots, projects, uses, drafts, branches, scene, chapter, provider, evidence] = await Promise.all([
    history(catalog, domain, record, ctx.signal), needsProjects ? listAll('project.list', {}, ctx.signal) : [],
    domain === domains.sources && catalog.has('source.backlinks') ? listAll('source.backlinks', inputFor(catalog, 'source.backlinks', { sourceId: id, revision: pinned }), ctx.signal) : [],
    domain === domains.scenes && catalog.has('draft.list') ? listAll('draft.list', { sceneId: id }, ctx.signal) : [],
    domain === domains.scenes ? listAll('scene.list', { branchOf: id }, ctx.signal) : [],
    domain === domains.drafts ? readRecord(catalog, domains.scenes, record.sceneId, record.sceneRevision, ctx.signal) : undefined,
    domain === domains.scenes && record.placement ? readRecord(catalog, domains.chapters, record.placement.chapterId, undefined, ctx.signal) : undefined,
    domain === domains.jobs ? mediaProvider(ctx.signal).catch(() => null) : null,
    (domain === domains.scenes || passageKind) && catalog.has('character.backlinks') ? listAll('character.backlinks', { kind: passageKind ?? 'scene', id, revision: record.revision }, ctx.signal) : [],
  ]);
  if (domain === domains.chapters) record.scenes = await chapterScenes(catalog, record, ctx.signal);
  const current = !pinned || snapshots[0]?.revision === pinned;
  let actions = domain !== domains.branches && operation(catalog, domain, 'revise') && current ? link(actionHref(latestHref, 'revise'), `修订${domain.title}`, 'pen', 'secondary') : '';
  if (pinned) actions += link(latestHref, '查看当前版本', null, 'quiet');
  if (domain === domains.sources && catalog.has('source.impact')) actions += link(actionHref(passageHref('sources', id, pinned, selectedRange), 'impact'), '查看影响', 'link', 'secondary');
  if (domain === domains.judgments && catalog.has('event.save')) actions += link(query('/events/new', { judgmentId: id, judgmentRevision: record.revision }), '用作事件证据', null, 'secondary');
  if (domain === domains.drafts && catalog.has('scene.adopt')) actions += link(actionHref(recordHref(domain, record, true), 'adopt'), '采纳此版本', null, 'primary');
  if (domain === domains.drafts && catalog.has('scene.branch')) actions += link(actionHref(recordHref(domains.scenes, scene, true), 'branch', { draftId: record.draftId, draftRevision: record.revision }), '从此稿建立 IF', null, 'secondary');
  if (domain === domains.drafts && catalog.has('generations.prepare')) actions += link(query('/generations/new', { draftId: id, draftRevision: record.revision }), '用此稿准备写作', 'pen', 'quiet');
  if (domain === domains.chapters && catalog.has('chapter.arrange')) actions += link(actionHref(href, 'arrange'), effects.arrange, 'pen', 'primary');
  if (domain === domains.scenes && catalog.has('scene.branch')) actions += link(actionHref(href, 'branch'), effects.branch, null, 'secondary');
  if (domain === domains.jobs || domain === domains.generations || textBatch) actions += button('workspace-refresh', '刷新状态', 'refresh', 'secondary');
  if (domain === domains.generations && catalog.has('generations.prompt')) actions += link(`${latestHref}/prompt`, '提示词组成', 'book', 'secondary');
  if (domain === domains.generations && record.mode === 'current-chat') {
    if (record.status === 'prepared' && catalog.has('generations.save')) actions += link(actionHref(href, 'save'), effects.save, 'pen', 'primary');
    if (catalog.has('generations.start')) actions += link(actionHref(href, 'start'), effects.start, null, 'secondary');
  }
  if (domain === domains.compositions && record.selectedCandidateId && catalog.has('jobs.create')) {
    actions += link(query('/jobs/new', { projectId: record.projectId, compositionId: id }), '用此构图新建任务', 'plus', 'primary');
  }
  const bindings = new Map();
  const passageActions = [];
  const callbacks = {};
  function passageAction(key, label, callback) {
    passageActions.push([key, label]);
    callbacks[key] = callback;
  }
  if (passageKind && catalog.has('character.adopt-entries')) passageAction('adopt', '采纳为角色条目', range =>
    ctx.go(actionHref(passageHref(domain.route, id, record.revision, range), 'adopt-entry')));
  if (domain === domains.sources) {
    for (const [op, key, label, target] of [['judgment.create', 'judgment', '用作判断依据', '/judgments/new'],
      ['diary.create', 'diary', '引用到日记', '/diaries/new'], ['event.save', 'event', '提炼为事件', '/events/new'],
      ['scene.create', 'scene', '引用到场景', '/scenes/new']]) {
      if (catalog.has(op) && (key !== 'diary' && key !== 'scene' || catalog.get(op).inputSchema.properties[key === 'diary' ? 'sourcePins' : 'sources']?.items?.properties?.range)) {
        passageAction(key, label, range => ctx.go(query(target, pinFromSelection(id, record.revision, range))));
      }
    }
  }
  if (domain === domains.drafts && catalog.has('event.save')) passageAction('event', '提炼为事件', range =>
    ctx.go(query('/events/new', { draftId: id, draftRevision: record.revision, start: String(range.start), end: range.end })));
  let extra = '';
  if (domain === domains.sources && catalog.has('source.backlinks')) extra = backlinkList(uses);
  if (domain === domains.sources && catalog.get('source.search')?.inputSchema?.properties?.matchLimit) {
    const q = params.get('q')?.trim();
    const matchOffset = positive(params.get('matchOffset')) ?? 0;
    if (q) {
      const matches = (await read('source.search', { sourceId: id, revision: record.revision, query: q, matchLimit: 11, matchOffset }, ctx.signal)).items[0]?.matches ?? [];
      const matchHref = offset => query(latestHref, { revision: record.revision, q, matchOffset: offset });
      extra = section('原文匹配', matches.length ? `<ol class="workspace-notes passage-matches">${matches.slice(0, 10).map((range, index) => `<li><p class="prose">${contextText(record.body, range.start, range.end)}</p>
        ${anchor(passageHref('sources', id, record.revision, range), `定位第 ${matchOffset + index + 1} 处`)}</li>`).join('')}</ol><div class="actions">
        ${matchOffset ? link(matchHref(Math.max(0, matchOffset - 10)), '上一页', null, 'secondary') : ''}${matches.length > 10 ? link(matchHref(matchOffset + 10), '下一页', null, 'secondary') : ''}</div>` : '<p class="muted">关键词可能位于标题或出处。</p>') + extra;
    }
  }
  if (domain === domains.judgments) extra = section('判断', passageView(passageActions)) + (record.scope ? section('适用范围', prose(record.scope)) : '') +
    section('依据与反证', record.evidence.length ? `<ul class="workspace-notes">${record.evidence.map(({ stance, pin }) => `<li>${esc(display(stance))} · ${anchor(passageHref('sources', pin.sourceId, pin.revision, pin.range), `原文 · ${version(pin.revision)}`)}<blockquote>${esc(pin.excerpt)}</blockquote></li>`).join('')}</ul>` : '<p class="muted">暂无证据</p>');
  if (domain === domains.scenes) {
    const newDraft = catalog.has('draft.create') ? link(query('/drafts/new', { sceneId: id, revision: record.revision }), '新建候选稿', 'plus', 'primary') : '';
    const compare = drafts.length && catalog.has('draft.compare') ? link(actionHref(latestHref, 'compare'), '对照候选稿', null, 'secondary') : '';
    const addComposition = record.placement && catalog.has('composition.create') ? link(query('/compositions/new', { sceneId: id, revision: record.revision }), '新建构图', 'plus', 'secondary') : '';
    const compositions = record.placement && catalog.has('composition.list') ? link(query('/compositions', { projectId: record.placement.projectId, sceneId: id }), '查看构图', null, 'quiet') : '';
    extra = await sceneStory(ctx, catalog, record) + section('候选稿', `<div class="actions">${newDraft}${compare}</div>${recordRows(drafts, domains.drafts)}`) +
      (branches.length ? section('IF 分支场景', recordRows(branches, domains.scenes)) : '') +
      (addComposition ? section('场景构图', `<div class="actions">${addComposition}${compositions}</div>`) : '');
  }
  if (domain === domains.jobs) extra = taskDetail(catalog, record, bindings);
  if (domain === domains.compositions) extra = compositionDetail(catalog, record, bindings);
  if (textBatch) extra = textBatchDetail(catalog, record, bindings, attemptOffset);
  if (storyDomain) extra = await storyDetail(ctx, catalog, domain, record);
  const title = nameOf(record, record.scene?.title ? `${record.scene.title} · 构图` : domain.title);
  const meta = [version(record.revision), record.kind && display(record.kind), stateText(record)].filter(Boolean).join(' · ');
  const trail = domain === domains.narratives ? passageHref('scenes', record.sceneId, record.sceneRevision) : domain === domains.events ? query('/events', { branchId: record.branchId }) : listHref;
  const body = storyDomain || domain === domains.judgments ? '' : recordBody(domain, record, { projects, scene, chapter, passage: passageKind ? passageView(passageActions) : undefined });
  if (!ctx.show(title, `${heading(title, { trail: back(trail, domain === domains.narratives ? '场景' : domain.title), actions, meta: (meta ? `<p class="masthead-meta">${esc(meta)}</p>` : '') + providerView(provider) })}
    ${body}${extra}${characterBacklinksView(evidence)}${historyView(domain, record, snapshots)}`)) return;
  if (passageKind) bindPassage(ctx, passageText, selectedRange, callbacks);
  if (storyDomain) bindStoryDetail(ctx, domain, record);
  ctx.main.querySelector('#workspace-refresh')?.addEventListener('click', ctx.refresh);
  for (const [key, config] of bindings) {
    bindWrite(ctx, catalog, ctx.main.querySelector(`#${key}`), config.id, () => config.input, () => {
      ctx.announce('操作已保存');
      ctx.refresh();
    }, { key: `${ctx.key}:${key}` });
  }
}

export async function workspaceRoute(ctx, domain, id, suffix) {
  const catalog = await loadCatalog();
  const narrativeId = ctx.url.searchParams.get('narrativeId');
  if (id && domain === domains.scenes && narrativeId && catalog.has('narrative.read')) {
    const revision = positive(ctx.url.searchParams.get('narrativeRevision'));
    const narrative = await read('narrative.read', { narrativeId, revision }, ctx.signal);
    const sceneRevision = positive(ctx.url.searchParams.get('revision'));
    if (narrative.sceneId !== id || (sceneRevision && narrative.sceneRevision !== sceneRevision)) throw new ApiError(404, 'narrative_scene_mismatch');
    const target = new URL(passageHref('narratives', narrativeId, narrative.revision), ctx.url);
    return detailPage({ ...ctx, url: target }, catalog, domains.narratives, narrativeId);
  }
  if (suffix === 'prompt') {
    if (!catalog.has('generations.prompt')) throw new ApiError(404, 'operation_not_available');
    return promptPage(ctx, id);
  }
  if (!id) return listPage(ctx, catalog, domain);
  if (id === 'new') return createPage(ctx, catalog, domain);
  return detailPage(ctx, catalog, domain, id, suffix);
}

export { domainFor };
