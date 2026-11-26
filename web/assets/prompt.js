import { read } from './api.js';
import { assetPreview, blockLabels, readCharacter, resourceHref, resourceKinds } from './character-blocks.js';
import { back, button, esc, field, heading, path, query } from './ui.js';
import { anchor, facts, outputPreview, section } from './workspace-view.js';
import { internalHref, version } from './workspace-model.js';

const states = {
  provided: '已提供给当前对话', prepared: '已准备', sent: '已发送', unknown: '发送状态未知',
};
const origins = {
  fixed: '固定说明', request: '写作请求', brief: '创作要求', template: '内容模板',
  requirements: '写作要求', input: '输入变量', reference: '参考资料',
};
const referenceLabel = kind => Object.hasOwn(resourceKinds, kind) ? resourceKinds[kind][1] : { event: '事件', narrative: '讲述', branch: 'IF 分支' }[kind] ?? '参考资料';

export function characterSelections(ctx, { kind, reference, revision }) {
  const region = document.createElement('fieldset');
  region.className = 'workspace-fieldset';
  region.hidden = true;
  let token = 0;
  let choices = [];
  const key = () => `${kind.value}/${reference.value}/${revision.value}`;
  let loadedKey;

  async function update() {
    const current = ++token;
    const requested = key();
    const number = revision.valueAsNumber;
    choices = [];
    loadedKey = undefined;
    region.hidden = kind.value !== 'character' || !reference.value || !Number.isSafeInteger(number) || number < 1;
    if (region.hidden) return;
    region.innerHTML = '<legend>角色资料</legend><p role="status">正在读取角色版本…</p>';
    try {
      const card = await readCharacter(reference.value, ctx.signal, number);
      if (!ctx.active() || token !== current || key() !== requested) return;
      const entries = card.entries ?? [];
      choices = entries.flatMap(({ entryId, label, blocks }) => blocks.map((block, blockIndex) => ({ entryId, label, block, blockIndex })));
      loadedKey = requested;
      region.innerHTML = `<legend>角色资料</legend><label class="character-pick"><input type="checkbox" name="include-description" checked><span>附上角色描述</span></label>
        ${choices.map(({ label, block, blockIndex }, index) => `<label class="character-pick">
          <input type="checkbox" name="character-block" value="${index}"><span>${esc(label || '未命名条目')} · ${esc(blockLabels[block.type])} ${blockIndex + 1}
          ${block.type === 'text' ? `<span class="muted"> · ${esc([...block.text].slice(0, 80).join(''))}${[...block.text].length > 80 ? '…' : ''}</span>` : ''}</span></label>`).join('')}`;
    } catch {
      if (!ctx.active() || token !== current || key() !== requested) return;
      region.innerHTML = '<legend>角色资料</legend><p role="status">无法读取可选条目。</p><button class="button quiet" type="button">重新读取</button>';
      region.querySelector('button').onclick = update;
    }
  }

  for (const node of [kind, reference]) node.addEventListener('change', update);
  revision.addEventListener('change', update);
  void update();
  return { region, get() {
    const selected = key() === loadedKey ? [...region.querySelectorAll('input[name="character-block"]:checked')].map(input => {
      const { entryId, blockIndex } = choices[Number(input.value)];
      return { entryId, blockIndex };
    }) : [];
    const description = region.querySelector('[name="include-description"]');
    return { ...(key() === loadedKey && description && !description.checked ? { includeDescription: false } : {}),
      ...(selected.length ? { selections: selected } : {}) };
  } };
}

function originView(item) {
  const { kind, referenceKind, id, revision, entryLabel, blockIndex, blockType, path: sourcePath, start, end, target } = item;
  const definition = { template: 'templates', requirements: 'writing-requirements' }[kind];
  const href = kind === 'reference' ? resourceHref(referenceKind, id, revision)
    : definition && id ? query(path(definition, id), { revision }) : '';
  const label = kind === 'reference' ? referenceLabel(referenceKind) : origins[kind];
  const name = [label, version(revision), entryLabel, blockIndex === undefined ? '' : `${blockLabels[blockType] ?? '内容'} ${blockIndex + 1}`].filter(Boolean).join(' · ');
  const range = Number.isInteger(start) && Number.isInteger(end) ? ` · UTF-16 [${start}, ${end})` : '';
  let targetHref = target && (resourceHref(target.kind, target.id, target.revision, target.range) || internalHref(target.href));
  if (targetHref && target.characterId) {
    const url = new URL(targetHref, location.origin);
    url.searchParams.set('characterId', target.characterId);
    targetHref = `${url.pathname}${url.search}${url.hash}`;
  }
  return `${anchor(href, name)}${targetHref ? ` · ${anchor(targetHref, `打开${referenceLabel(target.kind)} · ${version(target.revision)}`)}` : ''}
    <p class="row-meta"><code>${esc(sourcePath || '/')}</code>${esc(range)}</p>`;
}

function messageView(messages, included) {
  return messages.map(({ role, parts }, messageIndex) => `<article class="prompt-message">
    <h3>${role === 'system' ? '系统消息' : '用户消息'} ${messageIndex + 1}</h3>
    <ol class="workspace-notes">${parts.map((part, partIndex) => {
      const key = `${messageIndex}:${partIndex}`;
      if (part.type === 'text') {
        const sources = (included.get(key) ?? []).filter(item => item.kind === 'reference');
        return `<li class="prompt-part"><div class="prose prompt-text" data-part="${key}" tabindex="-1"></div>${sources.length ? `<details><summary>文字来源</summary>
          <ul class="workspace-notes">${sources.map(item => `<li>${originView(item)}</li>`).join('')}</ul></details>` : ''}</li>`;
      }
      const sources = included.get(key);
      const preview = assetPreview(part.type, part.asset.assetId, blockLabels[part.type]) +
        `<p class="row-meta">${esc(part.asset.contentType)} · ${esc(part.asset.byteLength)} B · SHA-256 <code>${esc(part.asset.sha256)}</code></p>`;
      return `<li class="prompt-part">${preview}${sources?.length ? `<details><summary>内容来源</summary>
        <ul class="workspace-notes">${sources.map(source => `<li>${originView(source)}</li>`).join('')}</ul></details>` : ''}</li>`;
    }).join('')}</ol></article>`).join('');
}

function lookupForm(href) {
  return `<search class="prompt-lookup"><form id="prompt-search" class="workspace-filter" action="${esc(href)}/prompt">
    ${field('phrase', '查找消息文字', { type: 'search', required: false })}
    ${button('prompt-find', '查找', null, 'primary', 'submit')}
    ${button('prompt-prev', '上一处', 'back', 'secondary')}${button('prompt-next', '下一处', 'next', 'secondary')}
  </form><p id="prompt-match-count" role="status"></p><div id="prompt-match" hidden>
    <p id="prompt-match-excerpt" class="prompt-excerpt"></p><div id="prompt-origin"></div>
    ${button('prompt-jump', '定位到消息', null, 'quiet')}
  </div></search>`;
}

function occurrences(part, term) {
  const matches = [];
  // The stored payload may contain JSON escapes that change the length of a quoted phrase.
  const encoded = JSON.stringify(term).slice(1, -1);
  for (const needle of new Set([encoded, term])) {
    for (let start = part.text.indexOf(needle); start !== -1; start = part.text.indexOf(needle, start + needle.length)) {
      matches.push({ part, start, end: start + needle.length });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  return matches.filter((match, index) => !index || match.start >= matches[index - 1].end);
}

function bindLookup(ctx, messages, included) {
  const form = ctx.main.querySelector('#prompt-search');
  const input = form.elements.namedItem('phrase');
  const previous = form.querySelector('#prompt-prev');
  const next = form.querySelector('#prompt-next');
  const count = ctx.main.querySelector('#prompt-match-count');
  const result = ctx.main.querySelector('#prompt-match');
  const excerpt = result.querySelector('#prompt-match-excerpt');
  const origin = result.querySelector('#prompt-origin');
  const highlight = globalThis.CSS?.highlights;
  const parts = [...ctx.main.querySelectorAll('.prompt-text')].map(node => {
    const [message, index] = node.dataset.part.split(':').map(Number);
    const { text } = messages[message].parts[index];
    const textNode = document.createTextNode(text);
    node.append(textNode);
    const spans = (included.get(node.dataset.part) ?? [])
      .filter(span => Number.isInteger(span.start) && Number.isInteger(span.end))
      .sort((a, b) => (a.end - a.start) - (b.end - b.start));
    return { node, textNode, text, spans };
  });
  let matches = [];
  let index = -1;
  let currentPart;
  let range;

  function clearHighlight() {
    highlight?.delete('prompt-match');
    if (!highlight && currentPart) currentPart.node.replaceChildren(currentPart.textNode);
    currentPart = undefined;
    range = undefined;
  }
  ctx.signal.addEventListener('abort', clearHighlight, { once: true });

  function show() {
    clearHighlight();
    previous.disabled = index <= 0;
    next.disabled = index === -1 || index >= matches.length - 1;
    result.hidden = index === -1;
    if (result.hidden) return;
    const { part, start, end } = matches[index];
    currentPart = part;
    const mark = document.createElement('mark');
    mark.textContent = part.text.slice(start, end);
    const left = Math.max(0, start - 45);
    const right = Math.min(part.text.length, end + 45);
    excerpt.replaceChildren(`${left > 0 ? '…' : ''}${part.text.slice(left, start)}`, mark,
      `${part.text.slice(end, right)}${right < part.text.length ? '…' : ''}`);

    range = new Range();
    if (highlight) {
      range.setStart(part.textNode, start);
      range.setEnd(part.textNode, end);
      highlight.set('prompt-match', new Highlight(range));
    } else {
      const inlineMark = mark.cloneNode(true);
      part.node.replaceChildren(part.text.slice(0, start), inlineMark, part.text.slice(end));
      range.selectNodeContents(inlineMark);
    }
    const source = part.spans.find(span => span.start <= start && span.end >= end);
    count.textContent = `第 ${index + 1} 处，共 ${matches.length} 处`;
    origin.innerHTML = source ? originView(source) : '<p class="muted">这段文字没有保存来源。</p>';
  }

  form.onsubmit = event => {
    event.preventDefault();
    const term = input.value.trim();
    matches = term ? parts.flatMap(part => occurrences(part, term)) : [];
    index = matches.length ? 0 : -1;
    count.textContent = term && !matches.length ? '没有匹配的文字。' : '';
    show();
  };
  input.oninput = () => {
    matches = [];
    index = -1;
    count.textContent = '';
    show();
  };
  previous.onclick = () => { index--; show(); if (previous.disabled) next.focus(); };
  next.onclick = () => { index++; show(); if (next.disabled) previous.focus(); };
  result.querySelector('#prompt-jump').onclick = () => {
    currentPart.node.focus({ preventScroll: true });
    window.scrollBy(0, range.getBoundingClientRect().top - window.innerHeight / 3);
  };
  show();
}

export async function promptPage(ctx, generationId) {
  const { status, historical, messages, provenance, parameters } = await read('generations.prompt', { generationId }, ctx.signal);
  const href = path('generations', generationId);
  const included = new Map();
  for (const item of provenance) {
    if (item.disposition !== 'included') continue;
    const key = `${item.messageIndex}:${item.partIndex}`;
    if (!included.has(key)) included.set(key, []);
    included.get(key).push(item);
  }
  const plan = parameters.plan;
  if (!ctx.show('提示词组成', `${heading('提示词组成', { trail: back(href, '生成记录'),
    actions: button('prompt-refresh', '刷新状态', 'refresh', 'secondary'),
    meta: `<p class="masthead-meta">${esc(states[status] ?? status)}${historical ? ' · 历史记录' : ''}</p>` })}
    ${historical && !provenance.length ? '<p class="form-note">这条历史记录缺少内容来源。</p>' : ''}
    ${lookupForm(href)}
    ${section('已纳入的消息', messageView(messages, included) || '<p class="muted">没有可查看的消息。</p>')}
    ${section('请求参数', facts([['planId', plan && anchor(query(path('generation-plans', plan.planId), { revision: plan.revision }), `${plan.title} · ${version(plan.revision)}`)]]) +
      (parameters.requestOptions ? outputPreview(parameters.requestOptions) : '<p class="muted">没有保存请求参数。</p>'))}`)) return;
  ctx.main.querySelector('#prompt-refresh').onclick = ctx.refresh;
  bindLookup(ctx, messages, included);
}
