import { optionMarkup } from './ui.js';
import { read } from './api.js';
import { contextText, passageHref, rangeLabel } from './passages.js';

export const labels = {
  title: '标题', name: '名称', kind: '类型', body: '正文', origin: '出处', excerpt: '引用原文',
  sourceId: '资料', sourceIds: '资料', sources: '资料引用', sourcePins: '资料引用', projectId: '项目', projectIds: '关联项目',
  characterId: '角色', characters: '出场角色', characterPins: '出场角色', sceneId: '场景', sceneRevision: '场景版本',
  sceneIds: '场景', chapterId: '章节', draftId: '候选稿', draft: '候选稿', draftRevision: '稿件版本',
  candidateId: '候选稿', candidateRevision: '稿件版本', revision: '版本', expectedRevision: '当前版本',
  expectedSceneRevision: '当前场景版本', expectedChapterRevision: '当前章节版本',
  expectedTaskRevision: '当前任务版本', position: '顺序', time: '时间', place: '地点', divergence: '分歧点',
  fields: '结构字段', key: '字段标识', label: '显示名称', description: '说明', required: '必填', type: '字段类型',
  minItems: '最少项数', maxItems: '最多项数', maxLength: '最多字数', minimum: '最小值', maximum: '最大值',
  viewpoint: '叙述视角', tone: '语气', constraints: '写作约束', executor: '执行方式', provider: '供应商',
  model: '模型', parameters: '模型参数', temperature: '温度', topP: 'Top P', maxOutputTokens: '最大输出 Token',
  templateId: '内容模板', templateRevision: '模板版本', requirementId: '写作要求', requirementRevision: '要求版本',
  planId: '生成方案', planRevision: '方案版本', generationId: '生成记录', resultId: '生成结果', reference: '引用',
  references: '参考资料', brief: '创作要求', inputs: '输入变量', output: '结构化正文', id: '记录编号',
  status: '状态', mode: '执行模式', taskId: '任务', itemId: '任务项', itemIds: '任务项', items: '任务项',
  compositionId: '构图', compositions: '构图候选', composition: '构图', candidates: '画面候选', mediaId: '媒体', prompt: '画面描述',
  negativePrompt: '排除内容', width: '宽度', height: '高度', seed: '随机种子', reason: '原因', labelField: '显示名称',
  requestedModel: '请求模型', reportedModel: '实际模型', reportedModelSource: '模型信息来源',
  providerResponseId: '上游请求编号', finishReason: '结束原因', providerEndpoint: '执行地址',
  code: '错误代码', message: '说明', createdAt: '创建时间', updatedAt: '更新时间',
  startedAt: '开始时间', finishedAt: '结束时间', byteLength: '文件字节数', contentType: '文件类型',
  generationIds: '生成记录', batchId: '文本批量任务', requestId: '请求编号', providerJobId: '上游任务编号', value: '值',
  statement: '判断', scope: '适用范围', stance: '证据用途', pin: '引用位置', evidence: '证据', summary: '事件概述',
  eventId: '事件', beforeEventId: '先发生', afterEventId: '后发生', eventOrder: '讲述顺序', knownEvents: '视角已知事件',
  branchId: 'IF 分支', branchName: '分支名称', narrative: '讲述', narrativeId: '讲述', sharedEvents: '沿用已知事件',
  characterStates: '分支角色状态', state: '此分支中的状态', note: '接续笔记', judgmentId: '判断',
};

const values = {
  setting: '设定', inspiration: '灵感', excerpt: '摘录', diary: '日记', 'short-story': '短故事',
  screenplay: '剧本', 'shot-list': '分镜', custom: '自定义', text: '文本', integer: '整数', boolean: '是／否',
  sections: '重复段落', 'current-chat': '当前对话', 'chat-client': '对话客户端', delegation: '指定方案',
  prepared: '待保存结果', queued: '排队中', pending: '等待执行', running: '执行中', succeeded: '已完成',
  failed: '失败', uncertain: '待核对', cancelled: '已取消', canceled: '已取消', draft: '候选稿',
  source: '资料', scene: '场景', character: '角色', template: '内容模板', requirements: '写作要求',
  image: '图片', audio: '音频', video: '视频', direct: '作者直接发起', manual: '作者直接发起', autonomous: '自主执行',
  submitting: '正在提交', submitted: '上游已接收', unknown: '待核对', partial: '部分完成',
  support: '依据', counter: '反证', omniscient: '全知', judgment: '判断', event: '事件', narrative: '讲述', generation: '生成记录',
};

export const label = (key, schema) => schema?.title ?? (Object.hasOwn(labels, key) ? labels[key] : key);
export const display = value => value == null ? '未知' : typeof value === 'boolean' ? (value ? '是' : '否') : Object.hasOwn(values, value) ? values[value] : String(value);

export function properties(schema) {
  return Object.entries(schema?.properties ?? {});
}

function make(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

function fieldset(holder, name, required) {
  const block = make('fieldset', { class: 'workspace-fieldset' });
  block.append(make('legend', {}, `${name}${required ? ' *' : ''}`));
  holder.append(block);
  return block;
}

const variants = schema => schema.anyOf ?? schema.oneOf ?? [];
export function literals(schema) {
  if (Object.hasOwn(schema, 'const')) return [schema.const];
  if (schema.enum) return schema.enum;
  const options = variants(schema);
  return options.length && options.every(option => Object.hasOwn(option, 'const')) ? options.map(option => option.const) : [];
}

const initial = (schema, value) => value ?? schema.default;
const present = value => value !== undefined;
const multiline = new Set(['body', 'excerpt', 'brief', 'origin', 'prompt', 'negativePrompt', 'persona', 'description', 'divergence', 'constraints', 'content', 'statement', 'scope', 'summary', 'state', 'note']);

function locateExcerpt(parent, source, revision, excerpt, initialRange, signal, draft) {
  const region = make('div', { class: 'passage-choice' });
  const find = make('button', { type: 'button', class: 'button quiet' }, '定位引用原文');
  const status = make('p', { class: 'row-meta', role: 'status' });
  const results = make('ul', { class: 'workspace-notes passage-matches' });
  region.append(find, status, results);
  parent.append(region);
  let range = initialRange;
  let token = 0;
  const selected = () => `${source.get()}/${revision.get()}/${excerpt.get()}`;
  let active = selected();
  status.textContent = rangeLabel(range);
  function reset() {
    if (active === selected()) return;
    token++;
    active = selected();
    range = undefined;
    status.textContent = '';
    results.replaceChildren();
  }
  for (const control of [source, revision, excerpt]) {
    control.node.addEventListener('input', reset);
    control.node.addEventListener('change', reset);
  }
  find.onclick = async () => {
    reset();
    const sourceId = source.get();
    const version = revision.get();
    const text = excerpt.get();
    if (!sourceId || !Number.isSafeInteger(version) || !text?.trim()) {
      status.textContent = '请选择资料、版本并填写摘录。';
      return;
    }
    const request = ++token;
    const selection = selected();
    status.textContent = '正在查找原文…';
    results.replaceChildren();
    try {
      const record = await read(draft ? 'draft.read' : 'source.read', { [draft ? 'draftId' : 'sourceId']: sourceId, revision: version }, signal);
      if (request !== token || selection !== selected() || !region.isConnected) return;
      const matches = [];
      for (let start = record.body.indexOf(text); start !== -1; start = record.body.indexOf(text, start + 1)) {
        matches.push({ start, end: start + text.length });
      }
      status.textContent = matches.length ? `找到 ${matches.length} 处原文` : '这个版本中没有匹配的原文。';
      function show(offset = 0) {
        results.replaceChildren();
        for (const [index, match] of matches.slice(offset, offset + 20).entries()) {
          const li = make('li');
          li.innerHTML = `<p class="prose">${contextText(record.body, match.start, match.end)}</p>`;
          const pick = make('button', { type: 'button', class: 'button secondary' }, `选用第 ${offset + index + 1} 处`);
          pick.onclick = () => {
            range = match;
            status.textContent = rangeLabel(range);
            find.focus();
            results.replaceChildren();
            excerpt.node.dispatchEvent(new Event('change', { bubbles: true }));
          };
          li.append(pick);
          results.append(li);
        }
        for (const [target, text] of [[offset - 20, '上一页'], [offset + 20, '下一页']]) {
          if (target < 0 || target >= matches.length) continue;
          const li = make('li');
          const page = make('button', { type: 'button', class: 'button quiet' }, text);
          page.onclick = () => { show(target); results.querySelector('button')?.focus(); };
          li.append(page);
          results.append(li);
        }
      }
      show();
    } catch {
      if (request === token && region.isConnected) status.textContent = '无法读取这一版原文，请重试。';
    }
  };
  return { region, get: () => active === selected() ? range : undefined };
}

// The catalog owns payload shape and constraints. Choices give identifiers readable names.
export function renderFields(holder, schema, value, options = {}) {
  let sequence = 0;

  function control(parent, rule, key, value, required, choicesOverride) {
    const name = label(key, rule);
    value = initial(rule, value);
    const allowed = literals(rule);
    const alternatives = variants(rule);
    if (alternatives.length && !allowed.length) {
      const concrete = alternatives.filter(option => option.type !== 'null');
      if (concrete.length === 1) {
        const child = control(parent, concrete[0], key, value, false);
        return { ...child, get: () => child.get() ?? (required || options.clearable?.includes(key) ? null : undefined) };
      }
      // Template field variants share a discriminator. Each type displays its own inputs.
      const discriminator = Object.keys(concrete[0]?.properties ?? {}).find(prop => concrete.every(option =>
        option.properties?.[prop] && Object.hasOwn(option.properties[prop], 'const')));
      if (discriminator) {
        const block = fieldset(parent, name, required);
        const choices = concrete.map(option => option.properties[discriminator].const);
        const picker = control(block, { enum: choices, type: 'string' }, discriminator, value?.[discriminator] ?? choices[0], true);
        const rest = make('div', { class: 'workspace-fields' });
        block.append(rest);
        let extract;
        function showVariant(previous) {
          const active = concrete[choices.indexOf(picker.get())] ?? concrete[0];
          const { [discriminator]: _, ...fields } = active.properties;
          rest.replaceChildren();
          extract = object(rest, { ...active, properties: fields }, previous, true);
        }
        showVariant(value);
        picker.node.addEventListener('change', () => showVariant(extract.get()));
        return { get: () => ({ ...extract.get(), [discriminator]: picker.get() }) };
      }
    }
    if (rule.type === 'object' && rule.properties) {
      const block = fieldset(parent, name, required);
      if (required) return object(block, rule, value, true);
      const enable = make('button', { type: 'button', class: 'button quiet' });
      const fields = make('div', { class: 'workspace-fields' });
      let child;
      function toggle(show) {
        fields.replaceChildren();
        child = show ? object(fields, rule, value, true) : undefined;
        enable.textContent = `${show ? '移除' : '添加'}${name}`;
        enable.setAttribute('aria-expanded', String(show));
      }
      block.append(fields, enable);
      toggle(value != null);
      enable.onclick = () => toggle(!child);
      return { get: () => child?.get() };
    }
    if (rule.type === 'object' && !rule.properties) {
      const pair = { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] };
      const result = repeat(parent, { items: pair }, key, Object.entries(value ?? {}).map(([key, value]) => ({ key, value })), required);
      return { get: () => {
        const entries = result.get();
        return entries ? Object.fromEntries(entries.map(({ key, value }) => [key, value])) : undefined;
      } };
    }
    if (rule.type === 'array') return repeat(parent, rule, key, value, required);
    if (allowed.length === 1) {
      parent.append(make('p', { class: 'form-note' }, `${name} · ${display(allowed[0])}`));
      return { get: () => allowed[0] };
    }

    const id = `${options.prefix ?? 'operation'}-field-${++sequence}`;
    const group = make('div', { class: 'field' });
    const caption = make('label', { for: id }, name);
    if (required) caption.append(make('span', { class: 'required', 'aria-hidden': 'true' }, ' *'));
    const attrs = { id, name: key, required: required ? '' : null };
    const choices = choicesOverride ?? options.choices?.[key];
    const numeric = rule.type === 'number' || rule.type === 'integer';
    const fillOptions = (node, candidates, selected) => {
      const fallback = selected != null && !candidates.some(([id]) => id === String(selected)) ? [[String(selected), String(selected)]] : [];
      node.innerHTML = optionMarkup([['', required ? '请选择' : '未指定'], ...candidates, ...fallback], String(selected ?? ''));
    };
    let node;
    let get;
    if (choices || allowed.length || rule.type === 'boolean') {
      const candidates = choices ?? (allowed.length ? allowed : [true, false]).map(value => [String(value), display(value)]);
      node = make('select', attrs);
      fillOptions(node, candidates, value);
      get = () => node.value === '' ? undefined : rule.type === 'boolean' ? node.value === 'true' : numeric ? Number(node.value) : node.value;
    } else {
      const textAttrs = { ...attrs, maxlength: rule.maxLength, minlength: rule.minLength };
      const long = multiline.has(key) || rule.maxLength >= 4000;
      if (!numeric && (long || rule.format === 'multiline')) node = make('textarea', { ...textAttrs, rows: key === 'body' ? 10 : 4 });
      else node = make('input', { ...textAttrs, type: numeric ? 'number' : rule.format === 'date' ? 'date' : 'text',
        step: numeric ? (rule.type === 'integer' ? 1 : 'any') : null, min: rule.minimum, max: rule.maximum,
        pattern: !numeric && rule.pattern === '\\S' ? '.*\\S.*' : null });
      node.value = value ?? '';
      get = () => node.value === '' && !required ? undefined : numeric ? node.valueAsNumber : node.value;
    }
    group.append(caption, node);
    if (rule.description) {
      const hint = make('p', { class: 'form-note', id: `${id}-description` }, rule.description);
      node.setAttribute('aria-describedby', hint.id);
      group.append(hint);
    }
    parent.append(group);
    return { node, get, setChoices: candidates => fillOptions(node, candidates) };
  }

  function object(parent, rule, value, required, fixed = {}) {
    const sourceRange = rule.properties?.range && rule.properties?.excerpt && (rule.properties.sourceId || rule.properties.id || rule.properties.draftId);
    const fields = properties(rule).filter(([key]) => !Object.hasOwn(fixed, key) && !(sourceRange && key === 'range'));
    const mandatory = new Set(rule.required);
    const byKind = rule.properties?.id && rule.properties?.kind && options.choices?.byKind;
    const children = fields.map(([key, child]) => [key, control(parent, child, key, value?.[key], mandatory.has(key),
      byKind && key === 'id' ? byKind[value?.kind] ?? [] : undefined)]);
    const controls = new Map(children);
    if (byKind) {
      const kind = controls.get('kind');
      const reference = controls.get('id');
      const revision = controls.get('revision');
      const excerpt = controls.get('excerpt');
      const updateExcerpt = () => {
        if (!excerpt?.node) return;
        const enabled = kind.get() === 'source';
        excerpt.node.closest('.field').hidden = !enabled;
        if (!enabled) excerpt.node.value = '';
      };
      updateExcerpt();
      kind.node.addEventListener('change', () => {
        reference.setChoices(byKind[kind.get()] ?? []);
        revision.node.value = '';
        updateExcerpt();
      });
      reference.node.addEventListener('change', () => {
        const record = byKind[kind.get()]?.find(([id]) => id === reference.get())?.[2];
        revision.node.value = record?.revision ?? '';
        revision.node.dispatchEvent(new Event('change'));
      });
    }
    for (const [key, child] of children) {
      const related = controls.get(`${key.replace(/Id$/, '')}Revision`) ?? (key.endsWith('Id') ? controls.get('revision') : undefined);
      if (!child.node || !related?.node) continue;
      child.node.addEventListener('change', () => {
        const record = options.choices?.[key]?.find(([id]) => id === child.get())?.[2];
        if (record?.revision) related.node.value = record.revision;
        else related.node.value = '';
      });
    }
    const draft = controls.has('draftId');
    const source = controls.get('sourceId') ?? (byKind ? controls.get('id') : controls.get('draftId'));
    const revision = controls.get('revision');
    const extras = byKind && options.referenceExtras?.({ kind: controls.get('kind').node, reference: source.node, revision: revision.node });
    if (extras) parent.append(extras.region);
    const range = sourceRange && source?.node && revision?.node && locateExcerpt(parent, source, revision, controls.get('excerpt'), value?.range, options.signal, draft);
    if (source?.node && revision?.node && controls.has('excerpt')) {
      const open = make('a', { class: 'workspace-reference', target: '_blank', rel: 'noopener' }, '查看所选版本原文');
      const update = () => {
        const id = source.get();
        const selected = revision.get();
        open.hidden = !id || !Number.isSafeInteger(selected) || selected < 1 || Boolean(byKind && controls.get('kind').get() !== 'source');
        if (range) range.region.hidden = Boolean(byKind && controls.get('kind').get() !== 'source');
        if (!open.hidden) open.href = passageHref(draft ? 'drafts' : 'sources', id, selected, range?.get());
      };
      revision.node.closest('.field').append(open);
      source.node.addEventListener('change', update);
      revision.node.addEventListener('input', update);
      controls.get('kind')?.node?.addEventListener('change', update);
      controls.get('excerpt').node.addEventListener('change', update);
      update();
    }
    return { get: () => {
      const entries = children.map(([key, child]) => [key, child.get()]).filter(([, value]) => present(value));
      const located = range?.get();
      return required || entries.length ? { ...fixed, ...Object.fromEntries(entries), ...(located && { range: located }), ...extras?.get() } : undefined;
    } };
  }

  function repeat(parent, rule, key, value, required) {
    const name = label(key, rule);
    const block = fieldset(parent, name, required);
    const list = make('div', { class: 'workspace-repeat' });
    const add = make('button', { type: 'button', class: 'button secondary' }, `添加${name}`);
    const minimum = rule.minItems ?? 0;
    const maximum = rule.maxItems ?? Infinity;
    const entries = new Map();
    const orderable = options.orderable?.includes(key);
    block.append(list, add);

    function sync() {
      add.disabled = entries.size >= maximum;
      for (const [row, { remove, up, down }] of entries) {
        remove.disabled = required && entries.size <= minimum;
        if (up) up.disabled = !row.previousElementSibling;
        if (down) down.disabled = !row.nextElementSibling;
      }
    }

    function insert(value, focus = false) {
      const row = make('div', { class: 'workspace-repeat-row' });
      const child = rule.items?.type === 'object' && rule.items.properties
        ? object(row, rule.items, value, true)
        : control(row, rule.items ?? { type: 'string' }, key, value, true);
      const remove = make('button', { type: 'button', class: 'button quiet' }, `移除${name}`);
      const actions = make('div', { class: 'actions' });
      let up;
      let down;
      if (orderable) {
        up = make('button', { class: 'button quiet', type: 'button' }, '上移');
        down = make('button', { class: 'button quiet', type: 'button' }, '下移');
        up.onclick = () => { row.previousElementSibling.before(row); sync(); (up.disabled ? down : up).focus(); };
        down.onclick = () => { row.nextElementSibling.after(row); sync(); (down.disabled ? up : down).focus(); };
        actions.append(up, down);
      }
      actions.append(remove);
      row.append(actions);
      list.append(row);
      entries.set(row, { child, remove, up, down });
      remove.onclick = () => {
        const next = row.nextElementSibling ?? row.previousElementSibling;
        entries.delete(row);
        row.remove();
        sync();
        (next?.querySelector('input, select, textarea') ?? add).focus();
      };
      sync();
      if (focus) row.querySelector('input, select, textarea')?.focus();
    }

    for (const item of Array.isArray(value) ? value : []) insert(item);
    while (required && entries.size < minimum) insert(undefined);
    add.onclick = () => insert(undefined, true);
    return { get: () => entries.size || required || Array.isArray(value) ? [...list.children].map(row => entries.get(row).child.get()) : undefined };
  }

  return object(holder, schema, value, true, options.fixed).get;
}
