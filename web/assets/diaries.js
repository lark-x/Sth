import { ApiError, entity, errorText, listAll, pager, read, revision } from './api.js';
import { bindEditor, editor, getDraft } from './editor.js';
import { back, button, empty, esc, field, heading, link, optionMarkup, path, projectOptions, query, rowLink, rows, time, today } from './ui.js';

const readDiary = async (noteId, signal) => entity(await read('diary.read', { noteId }, signal), 'noteId');
export const readCharacter = async (characterId, signal) => entity(await read('character.read', { characterId }, signal), 'characterId');
const projectList = signal => listAll('project.list', {}, signal);

function titleForProject(projects, projectId) {
  return projects.find(project => project.projectId === projectId)?.title ?? '项目日记';
}

function diaryMeta(diary, projects) {
  const hasCharacter = diary.character?.name || diary.characterName || diary.characterId;
  const kind = hasCharacter ? diary.character?.name || diary.characterName || '角色日记' : '个人日记';
  return [kind, diary.projectId && titleForProject(projects, diary.projectId)].filter(Boolean).map(esc).join(' · ');
}

function excerpt(body) {
  const text = (body ?? '').trim().replace(/\s+/g, ' ');
  return text ? `<p class="excerpt">${esc(text.length > 150 ? `${text.slice(0, 150)}…` : text)}</p>` : '';
}

export async function diaryIndex(ctx) {
  const requested = ctx.url.searchParams.get('projectId') ?? '';
  const next = await pager('diary.list', requested ? { projectId: requested } : {}, ctx.signal);
  const [projects, first] = await Promise.all([
    projectList(ctx.signal), next(),
  ]);
  const notes = new Map(first.records.map(diary => [diary.noteId, diary]));
  const projectId = projects.some(project => project.projectId === requested) ? requested : '';
  const newPath = query('/diaries/new', { projectId });
  const contents = () => notes.size ? diaryGroups([...notes.values()], projects) :
    empty('diary', projectId ? '这个项目还没有日记' : '日记本还是空的');
  if (!ctx.show('我的日记', `${heading('我的日记', {
    meta: `<p class="masthead-meta">${time(today())}</p>`, actions: link(newPath, '写日记', 'pen', 'primary'),
  })}<div class="list-bar"><p class="count" id="diary-count" role="status">${first.more ? '已加载 ' : ''}${notes.size} 篇日记</p>
    ${projects.length ? `<div class="list-filter">${field('projectFilter', '项目', { value: projectId, options: projectOptions(projects, '全部项目'), required: false })}</div>` : ''}</div>
    <div id="diary-list">${contents()}</div><div class="load-more"${first.more ? '' : ' hidden'}>
      ${button('more-diaries', '加载更多', null, 'secondary')}<span role="status" id="more-status"></span></div>`)) return;
  ctx.main.querySelector('#field-projectFilter')?.addEventListener('change', event => {
    ctx.go(query('/', { projectId: event.target.value }));
  });
  const more = ctx.main.querySelector('#more-diaries');
  const status = ctx.main.querySelector('#more-status');
  more.onclick = async () => {
    more.disabled = true;
    status.textContent = '正在读取…';
    try {
      const page = await next();
      if (!ctx.active()) return;
      for (const diary of page.records) notes.set(diary.noteId, diary);
      ctx.main.querySelector('#diary-list').innerHTML = contents();
      ctx.main.querySelector('#diary-count').textContent = `${page.more ? '已加载 ' : ''}${notes.size} 篇日记`;
      status.textContent = page.more ? '' : '已显示全部日记。';
      if (!page.more) more.hidden = true;
      const firstNew = page.records[0];
      if (firstNew) ctx.main.querySelector(`#diary-list a[href="${CSS.escape(path('diaries', firstNew.noteId))}"]`)?.focus();
      else if (!page.more) ctx.main.querySelector('h1').focus({ preventScroll: true });
    } catch (error) {
      if (ctx.active()) status.textContent = errorText(error);
    } finally {
      more.disabled = false;
    }
  };
}

function diaryGroups(notes, projects) {
  const groups = new Map();
  for (const diary of notes.toSorted((a, b) => b.diaryDate.localeCompare(a.diaryDate) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))) {
    const month = diary.diaryDate.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(diary);
  }
  return [...groups].map(([month, diaries]) => {
    const [year, number] = month.split('-');
    return `<section class="month"><h2>${esc(year)} 年 ${esc(Number(number))} 月</h2>${rows(diaries, diary => rowLink(
      path('diaries', diary.noteId), diary.title,
      `${excerpt(diary.body)}<p class="row-meta">${diaryMeta(diary, projects)}</p>`,
      `<time class="day" datetime="${esc(diary.diaryDate)}" aria-label="${esc(diary.diaryDate)}">${esc(diary.diaryDate.slice(8))}<span>日</span></time>`,
    ))}</section>`;
  }).join('');

}

export async function diaryPage(ctx, noteId) {
  const [diary, projects] = await Promise.all([
    readDiary(noteId, ctx.signal), projectList(ctx.signal).catch(() => []),
  ]);
  const href = path('diaries', noteId);
  const trail = back(query('/', { projectId: diary.projectId }), '日记');
  const meta = `<p class="masthead-meta">${time(diary.diaryDate)}<span aria-hidden="true"> · </span>${diaryMeta(diary, projects)}</p>`;
  if (ctx.url.searchParams.get('edit') === '1') {
    revision(diary);
    return diaryEditor(ctx, { diary, trail: back(href, '返回日记'), cancel: href, meta });
  }
  ctx.show(diary.title, `${heading(diary.title, {
    trail, meta, actions: link(query(href, { edit: '1' }), '编辑', 'pen', 'secondary'),
  })}<article class="entry"><div class="prose">${esc(diary.body)}</div></article>`);
}

export async function newDiary(ctx) {
  const requestedCharacter = ctx.url.searchParams.get('characterId');
  const requestedProject = ctx.url.searchParams.get('projectId');
  const [projects, characters, character] = await Promise.all([
    projectList(ctx.signal), listAll('character.list', {}, ctx.signal),
    requestedCharacter && readCharacter(requestedCharacter, ctx.signal),
  ]);
  const projectId = character?.projectId ?? requestedProject ?? '';
  const cancel = character ? path('characters', character.characterId) : query('/', { projectId });
  return diaryEditor(ctx, { projects, characters, character, projectId, cancel, trail: back(cancel, character ? '角色' : '日记') });
}

const diaryValues = diary => ({ title: diary.title, diaryDate: diary.diaryDate, body: diary.body });

async function diaryEditor(ctx, { diary, projects, characters, character, projectId, cancel, trail, meta }) {
  const label = diary ? '保存修改' : '保存日记';
  const title = diary ? '编辑日记' : '写日记';
  const operation = diary ? 'diary.revise' : 'diary.create';
  const schema = await ctx.fields(operation);
  const draft = getDraft(ctx.key, diary, diary ? diaryValues(diary) : {
    title: '', diaryDate: today(), projectId, characterId: character?.characterId ?? '', body: '',
  }, character);
  const { values } = draft;
  const choices = characters && new Map(characters.map(item => [item.characterId, item]));
  if (character) choices.set(character.characterId, character);
  const characterOptions = id => [['', '作为个人日记'], ...[...choices.values()]
    .filter(item => !item.projectId || item.projectId === id)
    .map(item => [item.characterId, item.name])];
  const scopeFields = diary ? '' : `<div class="scope-fields">
    ${field('projectId', '项目', { value: values.projectId, required: false, options: projectOptions(projects, '不归入项目') })}
    ${field('characterId', '叙述者', { value: values.characterId, required: false, options: characterOptions(values.projectId) })}
    </div>`;
  if (!ctx.show(title, `${heading(title, { trail, meta })}${editor(
    field('title', '标题', { value: values.title, schema: schema.title }) +
    field('diaryDate', '日期', { value: values.diaryDate, type: 'date' }) + scopeFields +
    field('body', '正文', { value: values.body, type: 'textarea', rows: 12, schema: schema.body }),
    { label, cancel },
  )}`)) return;

  let characterLoad;
  const projectSelect = ctx.main.querySelector('#field-projectId');
  const characterSelect = ctx.main.querySelector('#field-characterId');
  function loadCharacter() {
    const selected = characterSelect.value;
    draft.character = undefined;
    characterLoad = selected ? readCharacter(selected, ctx.signal).catch(() => undefined) : undefined;
  }
  projectSelect?.addEventListener('change', () => {
    characterSelect.innerHTML = optionMarkup(characterOptions(projectSelect.value), '');
    loadCharacter();
    characterSelect.dispatchEvent(new Event('input', { bubbles: true }));
  });
  characterSelect?.addEventListener('change', loadCharacter);
  if (characterSelect?.value && draft.character?.characterId !== characterSelect.value) loadCharacter();

  bindEditor(ctx, draft, {
    label, operation, success: diary ? '已保存修改' : '日记已保存', result: result => entity(result, 'noteId'),
    href: result => path('diaries', result.noteId),
    async input(current) {
      const { title, diaryDate, body, projectId, characterId } = current.values;
      const input = { title: title.trim(), diaryDate, body };
      if (diary) return { ...input, noteId: diary.noteId, expectedRevision: revision(current.record) };
      if (projectId) input.projectId = projectId;
      if (characterId) {
        const snapshot = current.character ?? await characterLoad ?? await readCharacter(characterId);
        if (snapshot.characterId !== characterId || (snapshot.projectId && snapshot.projectId !== projectId)) {
          throw new ApiError(409, 'character_project_mismatch');
        }
        current.character = snapshot;
        input.characterId = characterId;
        input.expectedCharacterRevision = revision(snapshot);
      }
      return input;
    },
    latestValues: diary ? diaryValues : undefined,
    conflictText: diary ? '这篇日记已有新版。请核对最新内容，再决定如何继续。' : '写作期间角色设定已更新。请核对新版设定后再保存日记。',
    async readLatest(current, signal) {
      const latest = diary ? await readDiary(diary.noteId, signal) : await readCharacter(current.values.characterId, signal);
      revision(latest);
      return latest;
    },
    preview: latest => `<details open><summary>最新版本 · 第 ${esc(latest.revision)} 版</summary>
      <p class="revision-title">${esc(diary ? latest.title : latest.name)} ${diary ? time(latest.diaryDate) : ''}</p>
      <div class="revision-text">${esc(diary ? latest.body : latest.persona)}</div></details>`,
  });
}
