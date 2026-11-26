import { listAll, read } from './api.js';
import { operationPage } from './workspace-actions.js';
import { display } from './workspace-fields.js';
import { domains, nameOf, recordHref, referenceChoices, schemaOf, version } from './workspace-model.js';
import { anchor, prose, recordRows, section } from './workspace-view.js';
import { esc, link, path, query } from './ui.js';
import { bindPassage, passageHref, passageView, rangeFrom, sourcePin, validRange } from './passages.js';

const href = (domain, id, revision) => passageHref(domain, id, revision);
const pin = (record, key) => ({ [key]: record[key], revision: record.revision });
const choice = (record, key) => [record[key], `${nameOf(record)} · ${version(record.revision)}`, record];
const actions = html => `<div class="actions">${html}</div>`;
const versionLink = (route, ref, key, label = version(ref.revision)) => anchor(href(route, ref[key], ref.revision), label);

const sceneBranch = scene => scene.branchId ?? (scene.branchFrom ? scene.sceneId : null);

async function eventChoices(branchId, signal) {
  const [local, branch] = await Promise.all([listAll('event.list', { branchId }, signal), branchId && read('branch.read', { branchId }, signal)]);
  return [...local, ...await Promise.all((branch?.sharedEvents ?? []).map(ref => read('event.read', ref, signal)))];
}

export async function sceneStory(ctx, operations, scene) {
  if (!operations.has('narrative.list')) return '';
  const params = ctx.url.searchParams;
  const selected = params.get('narrativeId');
  const narratives = await listAll('narrative.list', { sceneId: scene.sceneId }, ctx.signal);
  const branchId = sceneBranch(scene);
  const branch = branchId && operations.has('branch.read') ? link(path('branches', branchId), '查看 IF 接续', null, 'secondary') : '';
  return (selected ? link(query(path('narratives', selected), { revision: params.get('narrativeRevision') }), '打开此版本讲述', null, 'secondary') : '') +
    section('事件与讲述', actions(link(query('/narratives/new', { sceneId: scene.sceneId, sceneRevision: scene.revision }), '新建讲述', 'plus', 'primary') +
      link(query('/events', { branchId }), '查看事件', null, 'secondary') + branch) + recordRows(narratives, domains.narratives, { pinned: true }));
}

export async function storyForm(ctx, operations, domain, record, action) {
  const params = ctx.url.searchParams;
  let id, title, backTo, schema, values, fixed, choices, orderable;
  if (domain === domains.narratives && (action === 'new' || action === 'revise')) {
    id = 'narrative.save';
    title = record ? '修订讲述' : '新建讲述';
    const sceneId = record?.sceneId ?? params.get('sceneId');
    const sceneRevision = record?.sceneRevision ?? Number(params.get('sceneRevision'));
    const scene = await read('scene.read', { sceneId, ...(sceneRevision && { revision: sceneRevision }) }, ctx.signal);
    const branchId = record ? record.branchId : sceneBranch(scene);
    const [events, characters, drafts] = await Promise.all([eventChoices(branchId, ctx.signal),
      listAll('character.list', {}, ctx.signal), listAll('draft.list', { sceneId }, ctx.signal)]);
    fixed = { sceneId, sceneRevision: scene.revision, narrativeId: record?.narrativeId, expectedRevision: record?.revision };
    values = record ?? { viewpoint: { kind: 'omniscient' }, draft: scene.adopted && pin(scene.adopted, 'draftId') };
    choices = { eventId: events.map(item => choice(item, 'eventId')), characterId: characters.map(item => choice(item, 'characterId')),
      draftId: drafts.map(item => choice(item, 'draftId')) };
    orderable = ['eventOrder'];
    backTo = record ? recordHref(domain, record, true) : href('scenes', sceneId, scene.revision);
  } else if (domain === domains.narratives && action === 'branch') {
    id = 'scene.branch';
    title = '从此讲述建立 IF';
    fixed = { sceneId: record.sceneId, revision: record.sceneRevision, narrative: pin(record, 'narrativeId'), draft: undefined };
    values = { sharedEvents: record.knownEvents };
    choices = { eventId: (await Promise.all(record.knownEvents.map(ref => read('event.read', ref, ctx.signal)))).map(item => choice(item, 'eventId')) };
    backTo = recordHref(domain, record, true);
  } else if (domain === domains.branches && action === 'checkpoint') {
    id = 'branch.save';
    title = '保存接续位置';
    const sceneId = params.get('sceneId') ?? record.checkpoint.sceneId;
    const requested = Number(params.get('sceneRevision'));
    const scene = await read('scene.read', { sceneId, ...(requested && { revision: requested }) }, ctx.signal);
    const [drafts, narratives, characters] = await Promise.all([listAll('draft.list', { sceneId }, ctx.signal),
      listAll('narrative.list', { sceneId }, ctx.signal), listAll('character.list', {}, ctx.signal)]);
    fixed = { branchId: record.branchId, expectedRevision: record.revision, sceneId, sceneRevision: scene.revision };
    values = { ...record.checkpoint, ...(record.checkpoint.sceneId === sceneId && record.checkpoint.sceneRevision === scene.revision ? {} : { narrative: undefined, draft: scene.adopted && pin(scene.adopted, 'draftId') }) };
    choices = { draftId: drafts.map(item => choice(item, 'draftId')), characterId: characters.map(item => choice(item, 'characterId')),
      narrativeId: narratives.filter(item => item.sceneRevision === scene.revision).map(item => choice(item, 'narrativeId')) };
    backTo = path('branches', record.branchId);
  } else if (domain === domains.events && action === 'order') {
    id = 'event.order';
    title = '记录事件先后';
    const events = (await listAll('event.list', { branchId: record.branchId }, ctx.signal)).map(item => choice(item, 'eventId'));
    values = { beforeEventId: record.eventId };
    choices = { beforeEventId: events, afterEventId: events };
    backTo = path('events', record.eventId);
  } else if (domain === domains.events && (action === 'new' || action === 'revise')) {
    id = 'event.save';
    title = record ? '修订事件' : '新建事件';
    const draftId = params.get('draftId');
    const draftRevision = Number(params.get('draftRevision'));
    const range = rangeFrom(params);
    const draft = draftId && range && draftRevision ? await read('draft.read', { draftId, revision: draftRevision }, ctx.signal) : null;
    const source = !record && await sourcePin(params, ctx.signal);
    const branchId = record ? record.branchId : draft ? sceneBranch(await read('scene.read', { sceneId: draft.sceneId }, ctx.signal)) : params.get('branchId') || null;
    fixed = { eventId: record?.eventId, expectedRevision: record?.revision, branchId };
    const judgmentId = params.get('judgmentId');
    const judgmentRevision = Number(params.get('judgmentRevision'));
    values = record ?? { evidence: source ? [{ kind: 'source', ...source }] : draft && validRange(draft.body, range) ?
      [{ kind: 'draft', draftId, revision: draftRevision, excerpt: draft.body.slice(range.start, range.end), range }] : judgmentId && judgmentRevision ?
        [{ kind: 'judgment', judgmentId, revision: judgmentRevision }] : undefined };
    schema = schemaOf(operations, id);
    choices = await referenceChoices(operations, schema, {}, ctx.signal);
    const scenes = await listAll('scene.list', { branchId }, ctx.signal);
    choices.draftId = (await Promise.all(scenes.map(scene => listAll('draft.list', { sceneId: scene.sceneId }, ctx.signal))))
      .flat().map(item => choice(item, 'draftId'));
    backTo = record ? path('events', record.eventId) : query('/events', { branchId });
  } else return false;
  if (!operations.has(id)) return false;
  await operationPage(ctx, operations, { id, title, backTo, schema, fixed, values, choices, orderable,
    latest: record && fixed?.expectedRevision ? () => read(`${domain.prefix}.read`, { [domain.key]: record[domain.key] }, ctx.signal) : undefined,
    complete(result) {
      const target = id === 'scene.branch' ? path('branches', result.sceneId) : id === 'event.order' ? backTo : recordHref(domain, result);
      ctx.saved(target, '已保存');
    },
  });
  return true;
}

export async function storyDetail(ctx, operations, domain, record) {
  const base = recordHref(domain, record, true);
  if (domain === domains.events) {
    const [events, relations] = await Promise.all([listAll('event.list', { branchId: record.branchId }, ctx.signal),
      listAll('event.relations', { eventId: record.eventId }, ctx.signal)]);
    return section('事件概述', passageView([], 'event-summary')) + section('证据', `<ul class="workspace-notes">${record.evidence.map(item => `<li>
      ${anchor(passageHref({ source: 'sources', draft: 'drafts', judgment: 'judgments' }[item.kind], item.sourceId ?? item.draftId ?? item.judgmentId, item.revision, item.range), `${display(item.kind)} · ${version(item.revision)}`)}${item.excerpt ? `<blockquote>${esc(item.excerpt)}</blockquote>` : ''}</li>`).join('')}</ul>`) +
      section('已确定的先后', (relations.length ? `<ul>${relations.map(({ beforeEventId, afterEventId }) => `<li>${anchor(path('events', beforeEventId), nameOf(events.find(item => item.eventId === beforeEventId)))} 先于 ${anchor(path('events', afterEventId), nameOf(events.find(item => item.eventId === afterEventId)))}</li>`).join('')}</ul>` : '<p class="muted">先后待定</p>') +
      actions(link(query(base.split('?')[0], { revision: record.revision, action: 'order' }), '记录事件先后', null, 'secondary')));
  }
  if (domain === domains.narratives) {
    const refs = [...new Map([...record.eventOrder, ...record.knownEvents].map(item => [`${item.eventId}@${item.revision}`, item])).values()];
    const events = await Promise.all(refs.map(item => read('event.read', item, ctx.signal)));
    const eventRows = (items, ordered = false) => items.length ? `<${ordered ? 'ol' : 'ul'} class="workspace-notes">${items.map(item => `<li>${versionLink('events', item, 'eventId', nameOf(events.find(event => event.eventId === item.eventId && event.revision === item.revision)))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>` : '<p class="muted">暂无事件</p>';
    const viewpoint = record.viewpoint.kind === 'character' ? await read('character.read', pin(record.viewpoint, 'characterId'), ctx.signal) : null;
    return `<div class="actions context-actions">${link(query('/generations/new', { narrativeId: record.narrativeId, narrativeRevision: record.revision }), '用此讲述准备写作', 'pen', 'primary') +
      link(query(path('narratives', record.narrativeId), { revision: record.revision, action: 'branch' }), '从此讲述建立 IF', null, 'secondary')}</div>` +
      section('叙述视角', viewpoint ? versionLink('characters', viewpoint, 'characterId', viewpoint.name) : '全知') +
      section('讲述顺序', eventRows(record.eventOrder, true)) + section('视角已知事件', eventRows(record.knownEvents)) +
      (record.draft ? section('候选稿', versionLink('drafts', record.draft, 'draftId')) : '');
  }
  if (domain === domains.branches) {
    const checkpoint = record.checkpoint;
    const selectedCharacter = ctx.url.searchParams.get('characterId');
    const continuation = checkpoint.narrative && schemaOf(operations, 'generations.prepare')?.properties.story?.properties.checkpointRevision
      ? link(query('/generations/new', { narrativeId: checkpoint.narrative.narrativeId, narrativeRevision: checkpoint.narrative.revision,
        branchId: record.branchId, checkpointRevision: record.revision }), '从此接续点准备写作', 'pen', 'secondary') : '';
    const [scene, members] = await Promise.all([read('scene.read', { sceneId: checkpoint.sceneId, revision: checkpoint.sceneRevision }, ctx.signal),
      listAll('scene.list', { branchId: record.branchId }, ctx.signal)]);
    const shared = await Promise.all(record.sharedEvents.map(ref => read('event.read', ref, ctx.signal)));
    return section('分歧点', prose(record.divergence) + actions(link(href('scenes', record.originSceneId, record.originSceneRevision), '查看原场景', null, 'quiet') +
      (record.originNarrative ? link(href('narratives', record.originNarrative.narrativeId, record.originNarrative.revision), '查看原讲述', null, 'quiet') : '') +
      (record.originDraft ? link(href('drafts', record.originDraft.draftId, record.originDraft.revision), '查看原稿', null, 'quiet') : ''))) +
      section('接续位置', actions(link(href('scenes', scene.sceneId, scene.revision), scene.title, 'pen', 'primary') +
      link(query('/scenes/new', { branchId: record.branchId }), '新建接续场景', 'plus', 'secondary') +
      link(query(path('branches', record.branchId), { action: 'checkpoint' }), '保存接续位置', null, 'secondary') + continuation) +
      prose(checkpoint.note) + (checkpoint.narrative ? versionLink('narratives', checkpoint.narrative, 'narrativeId', '接续讲述') : '') +
      (checkpoint.draft ? ` · ${versionLink('drafts', checkpoint.draft, 'draftId', '接续稿件')}` : '')) +
      section('分支角色状态', checkpoint.characterStates.length ? `<ul class="workspace-notes">${checkpoint.characterStates.map(item => `<li>${versionLink('characters', item, 'characterId', `角色 · ${version(item.revision)}`)}${item.characterId === selectedCharacter ? passageView([], 'checkpoint-state') : prose(item.state)}</li>`).join('')}</ul>` : '') +
      section('沿用的已知事件', recordRows(shared, domains.events, { pinned: true })) +
      section('分支场景', `<ul class="workspace-notes">${members.map(item => `<li>${anchor(href('scenes', item.sceneId, item.revision), item.title)}
      ${link(query(path('branches', record.branchId), { action: 'checkpoint', sceneId: item.sceneId, sceneRevision: item.revision }), '设为接续位置', null, 'quiet')}</li>`).join('')}</ul>`);
  }
  return '';
}

export function bindStoryDetail(ctx, domain, record) {
  const range = rangeFrom(ctx.url.searchParams);
  if (domain === domains.events) bindPassage(ctx, record.summary, range, {}, 'event-summary');
  if (domain === domains.branches) {
    const characterId = ctx.url.searchParams.get('characterId');
    const state = record.checkpoint.characterStates.find(item => item.characterId === characterId);
    if (state) bindPassage(ctx, state.state, range, {}, 'checkpoint-state');
  }
}
