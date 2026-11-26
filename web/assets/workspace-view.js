import { display, label } from './workspace-fields.js';
import { domains, internalHref, nameOf, recordHref, stateText, version } from './workspace-model.js';
import { esc, link, path, query, time } from './ui.js';
import { resourceHref } from './character-blocks.js';
import { passageHref, rangeLabel } from './passages.js';

export const prose = value => `<div class="prose">${esc(value)}</div>`;
export const section = (title, body) => body ? `<section class="workspace-section"><h2>${esc(title)}</h2>${body}</section>` : '';
export const anchor = (href, text) => href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
export const reading = (value, title = '正文') => value ? section(title, prose(value)) : '';

export function facts(entries) {
  const fields = entries.filter(([, value]) => value !== '' && value != null);
  return fields.length ? `<dl class="workspace-facts">${fields.map(([key, value]) =>
    `<div><dt>${esc(label(key))}</dt><dd>${value}</dd></div>`).join('')}</dl>` : '';
}

const factsFor = (record, keys) => facts(keys.map(key => [key, Object.hasOwn(record ?? {}, key)
  ? key.endsWith('At') ? time(record[key], 'stamp') || esc(display(record[key])) : esc(display(record[key])) : '']));

export function citations(pins = []) {
  if (!pins.length) return '';
  return section('资料引用', `<ul class="workspace-notes">${pins.map(pin => `<li>${anchor(
    passageHref('sources', pin.sourceId, pin.revision, pin.range), `${nameOf(pin, '查看资料原文')} · ${version(pin.revision)}`,
  )}${pin.excerpt ? `<blockquote>${esc(pin.excerpt)}</blockquote>` : ''}</li>`).join('')}</ul>`);
}

export function recordRows(records, domain, { pinned = false, level = 3 } = {}) {
  return records.length ? `<ul class="rows" role="list">${records.map(record => {
    const title = nameOf(record, record.scene?.title ?? domain.title);
    const href = recordHref(domain, record, pinned);
    const progress = Object.entries(record.progress ?? record.counts ?? {}).filter(([, count]) => count).map(([state, count]) => `${display(state)} ${count}`).join(' · ');
    const meta = [stateText(record), record.kind && display(record.kind), version(record.revision), record.time, record.place, progress,
      domain === domains.compositions && (record.selectedCandidateId ? '已选用' : '待选择')].filter(Boolean).join(' · ');
    const content = `<div class="row-text"><h${level}>${esc(title)}</h${level}>${meta ? `<p class="row-meta">${esc(meta)}</p>` : ''}</div>`;
    return `<li>${href ? `<a class="row" href="${esc(href)}">${content}</a>` : `<div class="row">${content}</div>`}</li>`;
  }).join('')}</ul>` : '<p class="muted">暂无记录</p>';
}

function fieldPreview(fields) {
  if (!fields?.length) return '';
  return `<ol class="workspace-notes">${fields.map(field => `<li><strong>${esc(field.label ?? field.key)}</strong>
    <span class="row-meta"> · ${esc(display(field.type))} · ${field.required === false ? '选填' : '必填'}</span>
    ${field.description ? `<p>${esc(field.description)}</p>` : ''}
    ${factsFor(field, ['maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'])}${fieldPreview(field.fields)}</li>`).join('')}</ol>`;
}

export function outputPreview(output, fields = []) {
  if (output == null) return '<p class="muted">暂无内容</p>';
  if (Array.isArray(output)) return `<ol class="workspace-notes">${output.map(item => `<li>${outputPreview(item, fields)}</li>`).join('')}</ol>`;
  if (typeof output !== 'object') return prose(typeof output === 'boolean' ? display(output) : output);
  const ordered = fields.filter(field => Object.hasOwn(output, field.key)).map(field => field.key);
  const keys = [...ordered, ...Object.keys(output).filter(key => !ordered.includes(key))];
  return facts(keys.map(key => {
    const field = fields.find(field => field.key === key);
    return [field?.label ?? key, outputPreview(output[key], field?.fields)];
  }));
}

function origin(record) {
  const item = record.branchFrom;
  return item ? section('IF 分支', `${facts([
    ['sceneId', anchor(recordHref(domains.scenes, item, true), `原场景 · ${version(item.revision)}`)],
    ['draftId', item.draft && anchor(recordHref(domains.drafts, item.draft, true), `原候选稿 · ${version(item.draft.revision)}`)],
    ['divergence', esc(item.divergence)],
  ])}`) : '';
}

function linkedDefinitions(record) {
  const composition = record.composition ?? {};
  return facts([
    ['templateId', composition.template && anchor(recordHref(domains.templates, composition.template, true), `${composition.template.title} · ${version(composition.template.revision)}`)],
    ['requirementId', composition.requirements && anchor(recordHref(domains['writing-requirements'], composition.requirements, true), `${composition.requirements.title} · ${version(composition.requirements.revision)}`)],
    ['planId', record.plan && anchor(recordHref(domains['generation-plans'], record.plan, true), `${record.plan.title} · ${version(record.plan.revision)}`)],
    ['resultId', record.result && anchor(internalHref(record.result.href) || `${path('generations', record.generationId)}/result`, nameOf(record.result, '查看生成结果'))],
  ]);
}

function previewFile(record) {
  const href = internalHref(record.contentHref);
  if (href !== `/api/web/media/${encodeURIComponent(record.mediaId)}/content`) return '';
  const dimensions = Number.isSafeInteger(record.width) && Number.isSafeInteger(record.height) ? ` width="${record.width}" height="${record.height}"` : '';
  return `<figure class="workspace-media"><img src="${esc(href)}"${dimensions} alt="${esc(nameOf(record, '生成图片'))}">
    <figcaption><a href="${esc(href)}" target="_blank" rel="noopener">打开媒体文件</a></figcaption></figure>`;
}

export function recordBody(domain, record, data) {
  if (domain === domains.sources) {
    const titles = record.projectIds?.map(id => data.projects?.find(project => project.projectId === id)?.title ?? id) ?? [];
    const external = record.external;
    return section('原文', data.passage ?? prose(record.body)) + reading(record.origin, '出处') +
      (external ? section('外部文档', outputPreview(external)) : '') +
      section('关联项目', titles.length ? `<ul>${titles.map(title => `<li>${esc(title)}</li>`).join('')}</ul>` : '<p class="muted">个人资料</p>');
  }
  if (domain === domains.scenes) {
    return facts([['time', esc(record.time)], ['place', esc(record.place)], ['chapterId', record.placement && anchor(
      path('chapters', record.placement.chapterId), data.chapter?.title ?? `查看章节 · 位置 ${record.placement.position}`,
    )]]) + origin(record) + section('当前采用稿', record.adopted ?
      `<h3>${anchor(recordHref(domains.drafts, record.adopted, true), `${nameOf(record.adopted, '候选稿')} · ${version(record.adopted.revision)}`)}</h3>${prose(record.adopted.body)}` :
      '<p class="muted">尚未采纳候选稿</p>') + section('出场角色', record.characters?.length ? `<ul class="workspace-notes">${record.characters.map(item =>
      `<li><details><summary>${esc(item.name)} · ${esc(version(item.revision))}</summary>${prose(item.persona)}
        ${anchor(resourceHref('character', item.characterId, item.revision), '查看角色证据')}</details></li>`).join('')}</ul>` : '') + citations(record.sources);
  }
  if (domain === domains.drafts) {
    return section('正文', data.passage ?? prose(record.body)) + section('所属场景', anchor(recordHref(domains.scenes, { sceneId: record.sceneId, revision: record.sceneRevision }, true),
      `${nameOf(data.scene, '查看场景')} · ${version(record.sceneRevision)}`)) + citations(record.sources ?? data.scene?.sources);
  }
  if (domain === domains.chapters) {
    return facts([['projectId', esc(data.projects?.find(item => item.projectId === record.projectId)?.title ?? record.projectId)],
      ['position', esc(record.position)]]) + section('章节场景', recordRows(record.scenes ?? [], domains.scenes));
  }
  if (domain === domains.templates) return section('结构预览', fieldPreview(record.fields));
  if (domain === domains['writing-requirements']) return factsFor(record, ['viewpoint', 'tone']) +
    section('写作约束', record.constraints?.length ? `<ul>${record.constraints.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : '');
  if (domain === domains['generation-plans']) return section('执行配置', factsFor(record, ['executor', 'provider', 'model']) + factsFor(record.parameters, ['temperature', 'topP', 'maxOutputTokens']));
  if (domain === domains.generations) {
    const refs = record.composition?.references ?? [];
    const story = record.composition?.story;
    const checkpoint = story?.checkpoint;
    return linkedDefinitions(record) + (story ? section('采用的讲述', anchor(passageHref('narratives', story.narrativeId, story.revision), version(story.revision))) : '') +
      (checkpoint ? section('采用的 IF 接续点', anchor(passageHref('branches', checkpoint.branchId, checkpoint.revision), version(checkpoint.revision))) : '') +
      section('执行记录', factsFor(record, ['mode', 'status', 'createdAt', 'startedAt', 'finishedAt']) +
      factsFor(record.execution, ['requestedModel', 'reportedModel', 'reportedModelSource', 'providerResponseId', 'finishReason']) +
      (record.error ? `<p class="notice">${esc(record.error.message)}</p>` : '')) + reading(record.composition?.brief, '创作要求') +
      section('参考资料', refs.length ? `<ul class="workspace-notes">${refs.map(ref => `<li>${anchor(ref.range ? resourceHref(ref.kind, ref.id, ref.revision, ref.range) : internalHref(ref.href), `${ref.title} · ${version(ref.revision)}`)}</li>`).join('')}</ul>` : '') +
      (record.rawOutput ? `<details class="workspace-section"><summary>执行方原文</summary>${prose(record.rawOutput)}</details>` : '');
  }
  if (domain === domains.media) {
    return previewFile(record) + factsFor(record, ['contentType', 'width', 'height', 'byteLength', 'createdAt']) +
      section('来源', `<div class="actions">${sourceScene(record)}${anchor(path('compositions', record.compositionId), '查看构图')}
      ${anchor(path('jobs', record.jobId), '查看任务')}</div>`) + section('生成参数', factsFor(record.attempt, ['provider', 'providerJobId', 'requestId']) + outputPreview(record.attempt?.parameters));
  }
  if (domain === domains.compositions) return section('来源', sourceScene(record));
  return factsFor(record, ['status', 'mode', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'reason']);
}

export function sourceScene(record) {
  const sceneId = record.sceneId ?? record.scene?.sceneId;
  const revision = record.sceneRevision ?? record.scene?.revision;
  return sceneId ? anchor(query(path('scenes', sceneId), { revision }), `查看场景${revision ? ` · ${version(revision)}` : ''}`) : '';
}

export function backlinkList(uses) {
  return section('引用这条资料的内容', uses.length ? `<ul class="workspace-notes">${uses.map(({ owner, pin, stance }) => `<li>${anchor(
    internalHref(owner.href), `${display(owner.kind)} · ${owner.title} · ${version(owner.revision)}`,
  )}${stance ? ` · ${esc(display(stance))}` : ''}<blockquote>${esc(pin.excerpt)}</blockquote>${pin.range ? anchor(passageHref('sources', pin.sourceId, pin.revision, pin.range), rangeLabel(pin.range)) : ''}</li>`).join('')}</ul>` : '<p class="muted">暂无引用</p>');
}

export function impactRows(items) {
  const states = { current: '当前版本', historical: '历史版本', snapshot: '提示词快照' };
  return `<ul class="workspace-notes">${items.map(item => `<li><h2>${anchor(internalHref(item.href), item.title)}</h2>
    <p class="row-meta">${esc(display(item.kind))} · ${esc(states[item.state])}${item.revision ? ` · ${esc(version(item.revision))}` : ''} · 资料${esc(version(item.sourceRevision))}</p>
    ${item.via.length ? `<p class="row-meta">经由 ${item.via.map(ref => anchor(resourceHref(ref.kind, ref.id, ref.revision), `${display(ref.kind)} · ${version(ref.revision)}`)).join(' → ')}</p>` : ''}</li>`).join('')}</ul>`;
}
