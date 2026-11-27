'use strict';

// The sample stays in memory and works from file:// without a server or network.
const paragraphs = [
  '雨下到后半夜，栈桥的木板已经看不出原来的颜色。林澈沿着灯影走过去，把巡灯的钥匙握在手里。远处有人合上窗，声音被风带得很轻。',
  '第一声钟响时，她还站在街角。卖热汤的老人把最后一只碗收进柜子，问她今晚是不是又要送人。她摇头，走得比平日更慢。',
  '第二声钟响时，船上的灯亮了一排。她从衣袋里摸出信，封口仍是干的。收信人的名字写在背面，只有两个字，像一道迟迟没有回答的问题。',
  '岸边的候船室空了。墙上留着去年贴的航时表，纸角卷起，露出下面更旧的一张。她记得有人说过，所有离开都应该有一个明确的时刻。',
  '她在栈桥尽头停下来。脚下的水倒映着灯，亮光碎开，又慢慢合拢。船长没有催促，只把扶手上的雨擦去，给最后一个旅人留出位置。',
  '第三声钟响以后，她终于松开了攥住船票的手。',
  '她登上渡船，把那封信重新放回衣袋。北岸没有人追来，巡灯人的影子却在雨里停了很久。船驶过浮标时，城里的最后一盏窗灯熄灭了。',
  '多年以后，她想起的仍是那块湿木板和扶手上的水。关于那封信，她只记得自己没有在船上拆开，也没有再回头去数岸上的灯。',
];
const fullTitle = '林澈的讲法 · 第三声以后那封仍未拆开的长信';
const persona = '北港巡灯人。每到雨夜都会把一封未拆的信收进衣袋。只知道自己看见与听见的事情。';
const sourceLines = ['北港值夜簿', '十一月二十六日，雨。第一声钟响，收起北岸的缆绳。', '第二声钟响，旅人停在栈桥尽头。', '第三声钟响，末班渡船离开北岸。', '第三声钟响，巡灯人仍在岸边等待。', '旧值夜簿没有写明她在等待谁。'];
const chapters = { ch1: '第一章 · 雨停以前', ch2: '第二章 · 第三声以后', ch3: '第三章 · 写给留在岸上的人' };
const scenes = [
  { id: 'prelude', chapter: 'ch1', title: '巡灯人出门之前', short: '巡灯人出门之前', excerpt: '林澈从抽屉里取出钥匙。雨声敲在窗沿，她把信装进了衣袋。', meta: '采用稿 · 点灯', draftTitle: '点灯', body: '林澈从抽屉里取出钥匙。雨声敲在窗沿，她把信装进了衣袋。' },
  { id: 'main', chapter: 'ch2', title: '栈桥尽头 · 等待第三声钟响的那个雨夜', short: '栈桥尽头', excerpt: paragraphs[0], meta: '采用稿 · 林澈的讲法 · 修订 1', draftTitle: fullTitle },
  { id: 'ending', chapter: 'ch3', title: '未编定的清晨 · 三种结尾尚未选稿', short: '未编定的清晨', excerpt: '信放在桌上，这一页先停在这里。', meta: '候选稿 · 留白 · 尚未采用', draftTitle: '留白', body: '信放在桌上，这一页先停在这里。' },
  { id: 'bare', chapter: 'ch3', title: '没有引用的独白 · 一个足够长以检查窄屏换行的标题', short: '没有引用的独白', excerpt: '今天没有查阅资料，只想把窗外的雨记下来。', meta: '候选稿 · 只留一句话', draftTitle: '只留一句话', body: '今天没有查阅资料，只想把窗外的雨记下来。' },
  { id: 'if', chapter: 'if', title: 'IF · 她留在岸上', short: 'IF · 她留在岸上', excerpt: '渡船离开了。林澈把票放回窗口，沿着来时的灯影往回走。', meta: 'IF 采用稿 · 岸上路线', draftTitle: '岸上路线', body: '渡船离开了。林澈把票放回窗口，沿着来时的灯影往回走。' },
  { id: 'diary', chapter: 'diaries', title: '雨夜巡灯手记', short: '雨夜巡灯手记', excerpt: '第三声钟响过后，我走到北岸。雨把信封打湿了一角，我把它藏回衣袋。', meta: '日记 · 修订 2 · 11 月 26 日', draftTitle: '雨夜巡灯手记', body: '第三声钟响过后，我走到北岸。雨把信封打湿了一角，我把它藏回衣袋。\n\n明天再来点灯的时候，想把今天没说完的话写下来。\n\n后来补记，北岸的灯一直亮到天明。' },
  { id: 'personal', chapter: 'diaries', title: '窗边的一句话', short: '窗边的一句话', excerpt: '雨停的时候，先记下一句话。', meta: '日记 · 修订 1 · 11 月 27 日', draftTitle: '窗边的一句话', body: '雨停的时候，先记下一句话。' },
];
const icons = {
  home: '<path d="m3 10 9-7 9 7v10H7V10m3 10v-6h4v6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4V4Zm16 0h-3a3 3 0 0 0-3 3m0 14a4 4 0 0 1 4-2h2V4"/>',
  diary: '<rect x="5" y="3" width="15" height="18" rx="1.5"/><path d="M9 3v18M3 7h4m-4 5h4m-4 5h4m5-10h5"/>',
  file: '<path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6m-6 4h6"/>',
  folder: '<path d="M3 6h7l2 3h9v11H3V6Z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',
  source: '<path d="M10 6H4v15h13v-6M9 3h11v11H9V3Zm3 4h5m-5 3h4"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m0-5h5a7 7 0 0 0 7-5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9 4v16m-3-11h0m0 4h0"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  compose: '<path d="M13 4H4v16h16v-9M15 3l6 6m-10 6 2-6 6-6 4 4-6 6-6 2Z"/>',
  edit: '<path d="m5 15-1 5 5-1L20 8l-4-4L5 15Zm8-8 4 4"/>',
  evidence: '<path d="M5 3h14v18H5V3Zm4 5h6m-6 4h6m-6 4h3"/>',
  more: '<circle cx="5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="19" cy="12" r=".8"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  sort: '<path d="M5 6h14M5 12h10M5 18h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M12 4v16"/>',
  target: '<circle cx="12" cy="12" r="6"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/>',
  history: '<path d="M3 5v5h5m-5 0a9 9 0 1 1 2 8M12 7v5l4 2"/>',
};
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`;
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); }); }
const state = {
  page: 'home', scope: 'all', scene: 'main', draft: 'lin', revision: 1, target: false,
  adopted: { draft: 'lin', revision: 1 }, editing: false, conflict: false, comparison: false,
  compareSide: 'left', search: '', reverse: false, scroll: 0, notes: [], edits: new Map(),
};
let toastTimer;
let evidenceReturn;
let pendingEvidenceRange = null;
let libraryReturn = 'home';
let detailReturn = null;
let hashChanging = false;
const scene = () => scenes.find(item => item.id === state.scene) || scenes[1];
const draftTitle = () => state.scene === 'main' ? ({ lin: fullTitle, captain: '船长的讲法', shore: '岸上人的讲法' }[state.draft]) : scene().draftTitle;
const shortDraftTitle = () => state.scene === 'main' ? ({ lin: '林澈的讲法', captain: '船长的讲法', shore: '岸上人的讲法' }[state.draft]) : scene().draftTitle;
const editKey = () => `${state.scene}/${state.draft}/${state.revision}`;
function bodyParts() {
  if (state.edits.has(editKey())) return state.edits.get(editKey()).split('\n\n');
  if (state.scene !== 'main') return scene().body.split('\n\n');
  const text = [...paragraphs];
  if (state.draft === 'captain') text[5] = '第三声钟响以后，船长看见她把船票递了过来。';
  else if (state.draft === 'shore') text[5] = '第三声钟响以后，岸上的人只看见一盏灯慢慢远去。';
  else if (state.revision >= 2) text[5] = '第三声钟响以后，她把船票放在掌心，向亮着灯的渡船走去。';
  return text;
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}
function navRow(label, action, value, iconName, current, extra = '') {
  return `<button class="nav-row ${extra}" data-action="${action}" data-value="${value}" ${current ? 'aria-current="page"' : ''}>${icon(iconName)}<span>${label}</span></button>`;
}
function renderNav() {
  const isHome = state.page === 'home';
  $('#library-nav').innerHTML = [
    navRow('首页', 'home', '', 'home', isHome),
    navRow('最近写过', 'scope', 'all', 'clock', !isHome && state.scope === 'all'),
    navRow('日记', 'scope', 'diaries', 'diary', !isHome && state.scope === 'diaries'),
    '<div class="nav-divider"></div>',
    navRow('第三声以后', 'scope', 'book', 'book', !isHome && state.scope === 'book', 'nav-project'),
    ...Object.entries(chapters).map(([key, title]) => navRow(`${title.split(' · ')[0]}<small>${title.split(' · ')[1]}</small>`, 'scope', key, 'file', !isHome && state.scope === key, 'nav-chapter')),
    navRow('未编入章节', 'scope', 'unfiled', 'folder', state.scope === 'unfiled', 'nav-child'),
    navRow('角色', 'scope', 'characters', 'user', state.scope === 'characters', 'nav-child'),
    navRow('原文与资料', 'scope', 'sources', 'source', state.scope === 'sources', 'nav-child'),
    '<div class="nav-divider"></div>',
    navRow('IF · 没有登上的渡船', 'scope', 'if', 'branch', state.scope === 'if'),
  ].join('');
}
function itemsInScope() {
  if (state.scope === 'characters') return [{ id: 'character', title: '林澈', excerpt: persona, meta: '角色 · 修订 2 · 第三声以后' }];
  if (state.scope === 'sources') return [{ id: 'source', title: '北港值夜簿 · 雨夜抄本', excerpt: '第三声钟响，末班渡船离开北岸。', meta: '原文 · 修订 2 · 旧稿使用修订 1' }];
  if (state.scope === 'unfiled') return scenes.filter(item => item.id.startsWith('new-'));
  const filtered = scenes.filter(item => state.scope === 'all' || (state.scope === 'book' ? !['diaries', 'if'].includes(item.chapter) : item.chapter === state.scope));
  return state.reverse ? filtered.reverse() : filtered;
}
function renderSheets() {
  const labels = { all: '最近写过', book: '第三声以后', diaries: '日记', characters: '角色', sources: '原文与资料', unfiled: '未编入章节', if: 'IF · 没有登上的渡船', ...chapters };
  $('#list-title').textContent = labels[state.scope];
  const list = itemsInScope().filter(item => `${item.title}${item.excerpt}`.includes(state.search));
  $('#list-count').textContent = String(list.length);
  const object = { characters: '角色', sources: '资料', diaries: '日记' }[state.scope] || '文稿';
  const sorting = { characters: '按名称排序', sources: '按标题排序', diaries: '按日期排序', all: '按最近编辑' }[state.scope] || '按章节顺序';
  $('#search-label').textContent = `搜索${object}`;
  $('#search-input-label').textContent = `搜索${object}的标题与内容`;
  $('#sheet-search').placeholder = object === '角色' ? '姓名或角色资料' : object === '资料' ? '标题或原文' : '标题或正文';
  $('[data-action="sort"]').setAttribute('aria-label', `切换${object}排序`);
  $('.sheets').setAttribute('aria-label', `${object}列表`);
  $('#sort-label').textContent = `${sorting}${state.reverse ? ' · 倒序' : ''}`;
  let lastChapter;
  $('#sheet-list').innerHTML = list.map(item => {
    const group = ['all', 'book'].includes(state.scope) && item.chapter !== lastChapter ? `<p class="sheet-group">${chapters[item.chapter] || (item.chapter === 'diaries' ? '日记' : 'IF · 没有登上的渡船')}</p>` : '';
    lastChapter = item.chapter;
    const selected = item.id === state.scene || state.page === item.id;
    const meta = item.id === 'main' ? `采用稿 · ${{ lin: '林澈的讲法', captain: '船长的讲法', shore: '岸上人的讲法' }[state.adopted.draft]} · 修订 ${state.adopted.revision}` : item.meta;
    return `${group}<button class="sheet" data-action="open" data-value="${item.id}" ${selected ? 'aria-current="true"' : ''}><span class="sheet-title">${escapeHtml(item.title)}</span><span class="sheet-excerpt">${escapeHtml(item.excerpt)}</span><span class="sheet-meta">${escapeHtml(meta)}${['main', 'ending'].includes(item.id) ? '<span>3 份讲法</span>' : ''}</span></button>`;
  }).join('') || '<p class="sheet-group">这里还没有文稿。可以从下方开始写一份样例。</p>';
}
function savePosition() {
  if (state.page === 'read') {
    state.scroll = $('.reading-scroll')?.scrollTop || 0;
    const edit = $('#edit-area');
    if (edit) state.edits.set(editKey(), edit.value);
  }
}
function setHash(value) {
  hashChanging = true;
  history.replaceState(null, '', `#${value}`);
  hashChanging = false;
}
function render() {
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
  $('#app').dataset.page = state.page;
  renderNav();
  renderSheets();
  if (state.page === 'home') renderHome();
  else if (state.page === 'character' || state.page === 'source') renderDetail();
  else renderReader();
  hydrateIcons();
}
function renderHome() {
  $('#main').innerHTML = `<header class="home-header"><button class="icon-button tablet-down" data-action="library" aria-label="打开书库">${icon('sidebar')}</button><h1>首页</h1><time datetime="2026-11-28">11 月 28 日，星期六</time></header>
    <div class="home-scroll"><div class="home-content"><h2>从一句话开始。</h2>
      <form id="quick-form" class="quick-note"><label for="quick-text">速记</label><textarea id="quick-text" placeholder="此刻，有什么想记下来的？" rows="2"></textarea><div class="quick-note-footer"><span>存到日记 · 仅作交互样例</span><button id="quick-save" class="primary-button" type="submit" disabled>暂存样例</button></div></form>
      <section class="home-section"><div class="section-heading"><h2>最近编辑</h2><button data-action="scope" data-value="all">全部文稿</button></div>
        ${state.notes.map((note, index) => `<button class="recent-row" data-action="open" data-value="note-${index}"><span><h3>速记 · 此页样例</h3><p>${escapeHtml(note)}</p><small>日记 · 刚刚 · 刷新后还原</small></span>${icon('chevron')}</button>`).join('')}
        <button class="recent-row" data-action="continue"><span><h3>栈桥尽头</h3><p>第三声钟响以后，她终于松开了攥住船票的手。</p><small>第三声以后 / 第二章 · 林澈的讲法<br>修订 1 · 本章采用 · 继续上次读到的段落</small></span>${icon('chevron')}</button>
        <button class="recent-row" data-action="open" data-value="personal"><span><h3>窗边的一句话</h3><p>雨停的时候，先记下一句话。</p><small>日记 · 11 月 27 日</small></span>${icon('chevron')}</button>
      </section>
      <section class="home-section"><div class="section-heading"><h2>作品</h2><button data-action="library">打开书库</button></div><button class="home-project" data-action="scope" data-value="book">${icon('book')}<span><strong>第三声以后</strong><small>3 章 · 4 幕 · 1 条 IF</small></span></button></section>
      <p class="home-note">当前为可点击设计样稿，内容为样例。<button data-action="about">查看说明</button></p>
    </div></div>`;
  $('#quick-text').addEventListener('input', event => { $('#quick-save').disabled = !event.target.value.trim(); });
  $('#quick-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = $('#quick-text').value.trim();
    if (!text) return;
    const submit = $('#quick-save');
    submit.disabled = true;
    submit.textContent = '正在暂存…';
    setTimeout(() => {
      state.notes.unshift(text);
      renderHome();
      $('#quick-text').focus();
      toast('已暂存此页样例，刷新页面后还原。');
    }, 350);
  });
}
function isAdopted() {
  if (state.scene === 'main') return state.adopted.draft === state.draft && state.adopted.revision === state.revision;
  return ['prelude', 'if'].includes(state.scene);
}
function toolbar() {
  const status = isAdopted() ? `<span class="adopted">${icon('check')}${state.scene === 'if' ? 'IF 采用' : '本章采用'}</span>` : state.scene === 'diary' || state.scene === 'personal' ? '<span>日记</span>' : '<span>候选稿 · 尚未采用</span>';
  const revision = state.scene === 'diary' ? 2 : state.revision;
  return `<header class="toolbar"><button class="icon-button" data-action="back-list" aria-label="返回文稿列表">${icon('sidebar')}</button>
    <div class="toolbar-identity"><button id="draft-switch" class="draft-switch" data-action="versions" aria-haspopup="true" aria-expanded="false" aria-controls="version-menu"><span>${escapeHtml(draftTitle())}</span>${icon('down')}</button><div class="identity-meta"><span>修订 ${revision}</span>${status}${state.scene === 'main' && state.draft === 'lin' && state.revision === 1 ? '<span>另有修订 2</span>' : ''}</div></div>
    <div class="toolbar-actions">${state.editing ? '<button class="toolbar-action save-action" data-action="save-edit">暂存样例</button>' : `<button class="toolbar-action" data-action="edit" aria-label="编辑正文">${icon('edit')}<span class="action-label">编辑</span></button>`}<button id="evidence-button" class="toolbar-action" data-action="evidence" aria-label="打开本次依据" aria-expanded="false" aria-controls="evidence">${icon('evidence')}<span class="action-label">依据</span></button><button id="more-button" class="icon-button" data-action="more" aria-label="更多阅读操作" aria-haspopup="true" aria-expanded="false" aria-controls="more-menu">${icon('more')}</button></div>
  </header>`;
}
function proseHtml(parts, mark = true) {
  return parts.map((text, index) => `<p${index === 5 ? ' id="target-paragraph"' : ''}>${index === 5 && mark ? `<mark class="target-sentence">${escapeHtml(text)}</mark>` : escapeHtml(text)}</p>`).join('');
}
function renderReader() {
  const current = scene();
  const chapter = chapters[current.chapter] || (current.chapter === 'if' ? 'IF · 没有登上的渡船' : current.chapter === 'diaries' ? '日记' : '未编入章节');
  const old = state.scene === 'main' && state.draft === 'lin' && state.revision === 1;
  let content;
  if (state.comparison) {
    content = `<div class="version-notice"><span>同段比稿 · 第三声钟响后的选择</span><button data-action="compare-close">返回全文</button></div><h1>栈桥尽头</h1><div class="compare-tabs"><button data-action="compare-side" data-value="left" aria-pressed="${state.compareSide === 'left'}">林澈的讲法</button><button data-action="compare-side" data-value="right" aria-pressed="${state.compareSide === 'right'}">船长的讲法</button></div><div class="compare-grid"><section data-active="${state.compareSide === 'left'}"><h2>林澈的讲法 · 修订 1 · ${state.adopted.draft === 'lin' && state.adopted.revision === 1 ? '本章采用' : '候选稿'}</h2><div class="prose">${proseHtml(paragraphs.slice(4, 7), false)}</div></section><section data-active="${state.compareSide === 'right'}"><h2>船长的讲法 · 修订 1</h2><div class="prose">${proseHtml([paragraphs[4], '第三声钟响以后，船长看见她把船票递了过来。', paragraphs[6]], false)}</div><button class="secondary-button" data-action="adopt-captain">在样例中采用此稿</button></section></div>`;
  } else {
    content = `<div class="doc-path"><button data-action="scope" data-value="${current.chapter === 'diaries' ? 'diaries' : 'book'}">${current.chapter === 'diaries' ? '日记' : '第三声以后'}</button><span>/</span><button data-action="scope" data-value="${current.chapter}">${escapeHtml(chapter.split(' · ')[0])}</button></div>
      ${state.scene === 'if' ? '<div class="version-notice"><span>IF · 第三声钟响时，她留在北岸。</span><button data-action="continue">回到主线</button></div>' : ''}
      <h1>${escapeHtml(current.title)}</h1>
      ${state.editing ? `<p class="edit-caption">${old ? '编辑历史稿会新建一份样例修订。' : '正在编辑当前样例。'}内容暂存于本页，刷新后还原。</p>${state.conflict ? '<div class="conflict" role="alert"><p>保存冲突样例。另一处已经产生新修订，你写下的内容仍保留在下方。</p><button class="secondary-button" data-action="resolve-conflict">保留草稿并新建样例修订</button></div>' : ''}<textarea id="edit-area" class="edit-area" aria-label="正文样例编辑">${escapeHtml(bodyParts().join('\n\n'))}</textarea>` : `<article class="prose" aria-label="文稿正文">${proseHtml(bodyParts())}</article>`}
      <footer class="reading-footer"><span>${bodyParts().join('').length} 字 · ${shortDraftTitle()} · 修订 ${state.revision}</span><button data-action="about">交互样例</button></footer>`;
  }
  $('#main').innerHTML = `${toolbar()}<div class="reading-scroll"><div class="manuscript ${state.target ? 'target-reading' : ''}">${content}</div></div>`;
  if (state.editing) $('#edit-area').addEventListener('input', event => { state.edits.set(editKey(), event.target.value); });
}
function scopeTo(value) {
  savePosition();
  const previousScope = state.scope;
  state.scope = value;
  state.search = '';
  $('#sheet-search').value = '';
  if (value === 'characters' || value === 'sources') {
    detailReturn = { scene: state.scene, draft: state.draft, revision: state.revision, scroll: state.scroll, scope: previousScope };
    state.page = matchMedia('(width < 640px)').matches ? 'sheets' : value === 'characters' ? 'character' : 'source';
  } else {
    const first = itemsInScope()[0];
    if (first && first.id !== state.scene) { state.scene = first.id; state.draft = 'lin'; state.revision = 1; state.scroll = 0; }
    state.page = matchMedia('(width < 640px)').matches ? 'sheets' : 'read';
  }
  state.target = false;
  state.comparison = false;
  state.editing = false;
  setHash(`library/${value}`);
  render();
}
function openScene(id, target = false) {
  savePosition();
  if (['character', 'source'].includes(id)) {
    if (!detailReturn) detailReturn = { scene: state.scene, draft: state.draft, revision: state.revision, scroll: state.scroll, scope: 'book' };
    state.page = id;
  } else {
    const previous = state.scene;
    state.scene = id;
    state.page = 'read';
    state.target = target;
    if (id !== previous || target) { state.draft = 'lin'; state.revision = 1; state.scroll = 0; state.editing = false; state.comparison = false; }
  }
  setHash(target ? 'read' : id);
  render();
  requestAnimationFrame(() => {
    if (target) jumpToTarget();
    else $('.reading-scroll').scrollTop = state.scroll;
    $('#main').focus({ preventScroll: true });
  });
}
function jumpToTarget() {
  const target = $('#target-paragraph');
  const scroller = $('.reading-scroll');
  if (target && scroller) {
    const context = target.previousElementSibling || target;
    const relativeTop = context.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, relativeTop - 24);
    state.scroll = scroller.scrollTop;
  }
}
function renderDetail() {
  const character = state.page === 'character';
  const title = character ? '林澈' : '北港值夜簿 · 雨夜抄本';
  $('#main').innerHTML = `<header class="toolbar"><button class="icon-button" data-action="back-list" aria-label="返回列表">${icon('back')}</button><div class="toolbar-identity"><div class="draft-switch">${character ? '角色' : '原文与资料'}</div><div class="identity-meta">第三声以后 · 修订 2</div></div><button class="toolbar-action return-action" data-action="return-reader">${icon('file')}<span>返回原稿</span></button></header>
    <div class="reading-scroll"><div class="detail-page"><h1>${title}</h1><p class="detail-subtitle">第三声以后 · ${character ? '角色资料' : '引用材料'} · 当前修订 2</p>
    ${character ? `<div class="prose"><p>${persona}</p></div><h2>值夜习惯</h2><div class="prose"><p>听见第三声钟响时，先望向北岸。</p></div><h2>后来补记</h2><div class="prose"><p>她在对岸学会修船。</p></div><div class="detail-divider"></div><p class="detail-subtitle">“林澈的讲法 · 修订 1”使用角色修订 1。后来补记尚未用于这份旧稿。</p>` : `<div class="prose">${sourceLines.map(line => `<p class="source-line">${escapeHtml(line)}</p>`).join('')}</div><h2>修订 2 的后附校订</h2><div class="prose"><p>末班渡船改为第二声钟响后离港。这条校订尚未用于旧稿。</p></div>`}
    </div></div>`;
}
function versionMenu() {
  const current = state.scene === 'main';
  const revisions = new Set(state.draft === 'lin' ? [2, 1] : [1]);
  state.edits.forEach((_, key) => { const [id, draft, revision] = key.split('/'); if (id === state.scene && draft === state.draft) revisions.add(Number(revision)); });
  const revisionOptions = [...revisions].sort((left, right) => right - left);
  $('#version-menu').innerHTML = current ? `<h2>这幕的三份讲法</h2>${[['lin', fullTitle], ['captain', '船长的讲法'], ['shore', '岸上人的讲法']].map(([key, title]) => `<button data-action="draft" data-value="${key}" ${state.draft === key ? 'aria-current="true"' : ''}>${icon(state.draft === key ? 'check' : 'file')}<span>${title}<small>${key === state.adopted.draft ? `章节采用修订 ${state.adopted.revision}` : '候选稿'}${key === 'lin' ? ' · 共 2 次修订' : ' · 修订 1'}</small></span></button>`).join('')}<div class="menu-divider"></div><h2>${shortDraftTitle()}的修订</h2>${revisionOptions.map(revision => `<button data-action="revision" data-value="${revision}" ${state.revision === revision ? 'aria-current="true"' : ''}>${icon(revision === state.revision ? 'check' : 'history')}<span>修订 ${revision}<small>${revision >= 3 ? '此页暂存的样例修订' : revision === 1 && state.adopted.draft === state.draft && state.adopted.revision === 1 ? '本章采用 · 固定版本' : revision === 2 ? '最新候选 · 改写登船动作' : '固定版本'}</small></span></button>`).join('')}<div class="menu-divider"></div><button data-action="adopt" ${isAdopted() ? 'disabled' : ''}>${icon('check')}<span>${isAdopted() ? '此版已被本章采用' : '在样例中采用当前版本'}</span></button>` : `<h2>${escapeHtml(draftTitle())}</h2><button data-action="dismiss-menu">${icon('check')}<span>修订 ${state.scene === 'diary' ? 2 : 1}<small>${escapeHtml(scene().meta)}</small></span></button>`;
}
function showMenu(menuId, trigger) {
  document.querySelectorAll('.menu:popover-open').forEach(menu => menu.hidePopover());
  const menu = $(`#${menuId}`);
  const rect = trigger.getBoundingClientRect();
  menu.style.insetInlineStart = `${Math.max(12, Math.min(rect.left, innerWidth - Math.min(340, innerWidth - 24) - 12))}px`;
  menu.style.insetBlockStart = `${rect.bottom + 8}px`;
  menu.style.maxBlockSize = `${innerHeight - rect.bottom - 20}px`;
  trigger.setAttribute('aria-expanded', 'true');
  menu.showPopover();
}
function closeMenus() { document.querySelectorAll('.menu:popover-open').forEach(menu => menu.hidePopover()); }
function evidenceMain() {
  const linked = state.scene === 'main' && ['lin', 'captain'].includes(state.draft) && state.revision === 1;
  $('#evidence-title').textContent = '本次依据';
  $('#evidence-subtitle').textContent = `${shortDraftTitle()} · 修订 ${state.revision}`;
  if (!linked) {
    $('#evidence-content').innerHTML = `<div class="empty-evidence"><h3>这一版还没有确认的依据</h3><p>${state.revision >= 2 ? '新修订未关联旧稿的依据。可以回看修订 1 当时使用的原文。' : '这份稿件目前没有已确认的来源记录。'}</p>${state.scene === 'main' && state.revision >= 2 ? '<button class="secondary-button" data-action="evidence-old">查看修订 1 的依据</button>' : ''}<p class="source-meta">没有关联依据时，正文仍可照常阅读。</p></div>`;
    return;
  }
  const quote = state.draft === 'lin' ? sourceLines[3] : sourceLines[4];
  $('#evidence-content').innerHTML = `<section class="evidence-section"><h3>这段引用的原文</h3><blockquote>“${quote}”</blockquote><button class="source-link" data-action="evidence-source">北港值夜簿 · 雨夜抄本 ${icon('chevron')}</button><span class="source-meta">原文修订 1 · 作者已确认关联</span></section>
    <section class="evidence-section"><h3>人物</h3><p>${persona}</p><button class="source-link" data-action="evidence-character">林澈 · 角色修订 1 ${icon('chevron')}</button></section>
    <section class="evidence-section"><h3>当时确认的决定</h3><p>林澈在第三声钟响后登船，信仍未拆开。</p><span class="source-meta">主线选择 · 作者已确认</span></section>
    <section class="evidence-section"><h3>留给下一次讨论</h3><p>寄信人是谁</p><span class="source-meta">暂不揭晓寄信人的身份。</span><details><summary>查看本次写作要求</summary><p>根据固定版本的值夜簿与人物设定修订这个场景，保留未拆信的悬念。</p></details></section>`;
}
function openEvidence(trigger) {
  const selection = window.getSelection();
  evidenceReturn = { trigger, scroll: $('.reading-scroll').scrollTop, range: pendingEvidenceRange || (selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null) };
  pendingEvidenceRange = null;
  evidenceMain();
  $('#app').classList.add('with-evidence');
  if (matchMedia('(width < 640px)').matches) $('#evidence').showModal();
  else $('#evidence').show();
  trigger.setAttribute('aria-expanded', 'true');
  $('#evidence').scrollTop = 0;
  $('#evidence [data-action="evidence-close"]').focus({ preventScroll: true });
}
function restoreEvidence() {
  if ($('#evidence').open) return;
  $('#app').classList.remove('with-evidence');
  $('#evidence-button')?.setAttribute('aria-expanded', 'false');
  if (evidenceReturn) {
    $('.reading-scroll').scrollTop = evidenceReturn.scroll;
    evidenceReturn.trigger?.focus({ preventScroll: true });
    if (evidenceReturn.range?.startContainer.isConnected) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(evidenceReturn.range);
    }
  }
}
function evidenceDetail(kind) {
  const character = kind === 'character';
  $('#evidence-title').textContent = character ? '人物原条目' : '原文';
  $('#evidence-subtitle').textContent = '固定修订 1 · 本稿使用的版本';
  $('#evidence-content').innerHTML = `<button class="evidence-back" data-action="evidence-back">${icon('back')}返回本次依据</button><div class="evidence-full"><h3>${character ? '林澈' : '北港值夜簿 · 雨夜抄本'}</h3>${character ? `<p>${persona}</p><p>值夜习惯<br>听见第三声钟响时，先望向北岸。</p>` : sourceLines.map((line, index) => `<p>${index === (state.draft === 'lin' ? 3 : 4) ? `<mark class="target-sentence">${line}</mark>` : line}</p>`).join('')}<p class="muted">此处展示当时的修订 1。当前资料库已有后续修订。</p></div>`;
  $('#evidence').scrollTop = 0;
}
function changeVersion(draft, revision) {
  savePosition();
  const keepScroll = state.scroll;
  state.draft = draft;
  state.revision = revision;
  state.target = false;
  state.comparison = false;
  closeMenus();
  render();
  $('.reading-scroll').scrollTop = keepScroll;
}
function returnReader() {
  if (detailReturn) Object.assign(state, detailReturn);
  detailReturn = null;
  state.page = 'read';
  render();
  $('.reading-scroll').scrollTop = state.scroll;
  $('#main').focus({ preventScroll: true });
  setHash('read');
}
document.addEventListener('pointerdown', event => {
  if (event.target.closest('[data-action="evidence"]')) {
    const selection = window.getSelection();
    pendingEvidenceRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, value } = button.dataset;
  const actions = {
    home() { savePosition(); state.page = 'home'; state.scope = 'all'; closeMenus(); setHash('home'); render(); },
    library() { savePosition(); libraryReturn = state.page; state.page = 'library'; render(); },
    'library-close'() { state.page = libraryReturn; render(); $('.reading-scroll')?.scrollTo(0, state.scroll); },
    scope() { scopeTo(value); },
    continue() { state.scope = 'ch2'; openScene('main', true); },
    open() {
      if (value.startsWith('note-') && !scenes.some(item => item.id === value)) scenes.push({ id: value, chapter: 'diaries', short: '速记 · 此页样例', title: '速记 · 此页样例', draftTitle: '速记 · 此页样例', body: state.notes[Number(value.split('-')[1])], excerpt: state.notes[Number(value.split('-')[1])], meta: '日记 · 当前页面样例' });
      openScene(value);
    },
    'back-list'() { savePosition(); state.page = matchMedia('(width < 640px)').matches ? 'sheets' : 'library'; libraryReturn = 'read'; render(); },
    search() { $('#search-row').hidden = !$('#search-row').hidden; button.setAttribute('aria-expanded', String(!$('#search-row').hidden)); if (!$('#search-row').hidden) $('#sheet-search').focus(); },
    sort() { state.reverse = !state.reverse; renderSheets(); },
    versions() { versionMenu(); showMenu('version-menu', button); },
    more() { showMenu('more-menu', button); },
    'dismiss-menu'() { closeMenus(); },
    draft() { changeVersion(value, 1); },
    revision() { changeVersion(state.draft, Number(value)); },
    latest() { changeVersion('lin', 2); },
    adopt() { savePosition(); state.adopted = { draft: state.draft, revision: state.revision }; closeMenus(); render(); $('.reading-scroll').scrollTop = state.scroll; toast('已更改此页样例的章节采用版本，刷新后还原。'); },
    evidence() { openEvidence(button); },
    'evidence-close'() { $('#evidence').close(); },
    'evidence-source'() { evidenceDetail('source'); },
    'evidence-character'() { evidenceDetail('character'); },
    'evidence-back'() { evidenceMain(); $('#evidence').scrollTop = 0; },
    'evidence-old'() { $('#evidence').close(); changeVersion(state.draft, 1); openEvidence($('#evidence-button')); },
    target() { closeMenus(); state.comparison = false; if (!$('#target-paragraph')) render(); jumpToTarget(); },
    edit() { savePosition(); state.editing = true; state.comparison = false; render(); $('#edit-area').focus({ preventScroll: true }); },
    'save-edit'() {
      state.edits.set(editKey(), $('#edit-area').value);
      if (state.conflict) { render(); $('.reading-scroll').scrollTop = 0; return; }
      const text = $('#edit-area').value;
      state.revision = Math.max(state.revision + 1, 3);
      state.edits.set(editKey(), text);
      state.editing = false;
      render();
      toast(`已暂存样例修订 ${state.revision}，刷新后还原。`);
    },
    'conflict-demo'() { closeMenus(); state.editing = true; state.conflict = true; render(); toast('已进入保存冲突样例，可编辑后暂存或保留草稿。'); },
    'resolve-conflict'() { state.conflict = false; actions['save-edit'](); },
    compare() { savePosition(); closeMenus(); if (state.scene !== 'main') { state.scene = 'main'; state.draft = 'lin'; state.revision = 1; } state.comparison = true; state.editing = false; render(); },
    'compare-close'() { state.comparison = false; render(); $('.reading-scroll').scrollTop = state.scroll; },
    'compare-side'() { state.compareSide = value; render(); },
    'adopt-captain'() { state.adopted = { draft: 'captain', revision: 1 }; state.draft = 'captain'; state.revision = 1; state.comparison = false; render(); toast('此页样例已采用船长的讲法，刷新后还原。'); },
    'return-reader'() { returnReader(); },
    'new-scene'() {
      const id = `new-${scenes.length}`;
      const chapter = chapters[state.scope] ? state.scope : 'unfiled';
      scenes.push({ id, chapter, short: '未命名文稿', title: '未命名文稿', excerpt: '从这里开始写。', meta: '当前页面样例 · 尚未采用', draftTitle: '未命名文稿', body: '' });
      openScene(id); state.editing = true; render(); $('#edit-area').focus();
    },
    about() { closeMenus(); $('#about').showModal(); },
    'about-close'() { $('#about').close(); },
  };
  actions[action]?.();
});
$('#sheet-search').addEventListener('input', event => { state.search = event.target.value; renderSheets(); });
$('#evidence').addEventListener('close', restoreEvidence);
$('#version-menu').addEventListener('toggle', event => { $('#draft-switch')?.setAttribute('aria-expanded', String(event.newState === 'open')); });
$('#more-menu').addEventListener('toggle', event => { $('#more-button')?.setAttribute('aria-expanded', String(event.newState === 'open')); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#evidence').open && !$('#evidence').matches(':modal')) $('#evidence').close();
});
matchMedia('(width < 640px)').addEventListener('change', event => {
  if ($('#evidence').open) {
    $('#evidence').close();
    if (event.matches) $('#evidence').showModal(); else $('#evidence').show();
    $('#app').classList.add('with-evidence');
  }
});
function routeFromHash() {
  const hash = location.hash.slice(1);
  if (hash === 'read' || hash === 'workspace') {
    Object.assign(state, {
      page: 'read', scene: 'main', draft: 'lin', revision: 1,
      scope: hash === 'read' ? 'ch2' : 'book', target: hash === 'read',
      editing: false, comparison: false, scroll: 0,
    });
    render();
    if (state.target) requestAnimationFrame(jumpToTarget);
  }
  else if (hash.startsWith('library/')) scopeTo(hash.slice(8));
  else if (['character', 'source'].includes(hash)) { state.page = hash; state.scope = hash === 'character' ? 'characters' : 'sources'; render(); }
  else if (scenes.some(item => item.id === hash)) openScene(hash);
  else { state.page = 'home'; render(); }
}
window.addEventListener('hashchange', () => { if (!hashChanging) routeFromHash(); });
routeFromHash();
