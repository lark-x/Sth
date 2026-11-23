import { entity, listAll, revision } from './api.js';
import { readCharacter } from './diaries.js';
import { bindEditor, editor, getDraft } from './editor.js';
import { back, empty, esc, field, heading, icon, link, path, projectOptions, query, rowLink, rows } from './ui.js';

const projectList = signal => listAll('project.list', {}, signal);

export async function projectsPage(ctx) {
  const projects = await projectList(ctx.signal);
  ctx.show('项目', `${heading('项目', { actions: link('/projects/new', '新建项目', 'plus', 'primary') })}
    <div class="list-bar"><p class="count">${projects.length} 个项目</p></div>
    ${projects.length ? rows(projects, project => rowLink(query('/', { projectId: project.projectId }), project.title,
      '<p class="row-meta">查看项目日记</p>', `<span class="row-icon">${icon('folder')}</span>`)) : empty('folder', '还没有项目')}`);
}

export async function newProject(ctx) {
  const operation = 'project.create';
  const label = '创建项目';
  const schema = await ctx.fields(operation);
  const draft = getDraft(ctx.key, null, { title: '' });
  if (!ctx.show('新建项目', `${heading('新建项目', { trail: back('/projects', '项目') })}${editor(
    field('title', '项目名称', { value: draft.values.title, schema: schema.title }), { label, cancel: '/projects' },
  )}`)) return;
  bindEditor(ctx, draft, {
    operation, label, success: '项目已创建', result: result => entity(result, 'projectId'),
    input: current => ({ title: current.values.title.trim() }), href: () => '/projects',
  });
}

export async function charactersPage(ctx) {
  const projectId = ctx.url.searchParams.get('projectId') ?? '';
  const [projects, characters] = await Promise.all([
    projectList(ctx.signal), listAll('character.list', projectId ? { projectId } : {}, ctx.signal),
  ]);
  const titleOf = id => projects.find(project => project.projectId === id)?.title ?? (id ? '项目角色' : '独立角色');
  if (!ctx.show('角色', `${heading('角色', { actions: link(query('/characters/new', { projectId }), '新建角色', 'plus', 'primary') })}
    <div class="list-bar"><p class="count">${characters.length} 个角色</p>${projects.length ? `<div class="list-filter">${field(
      'projectFilter', '项目', { value: projectId, options: projectOptions(projects, '全部项目'), required: false },
    )}</div>` : ''}</div>
    ${characters.length ? rows(characters, character => rowLink(path('characters', character.characterId), character.name,
      `<p class="row-meta">${esc(titleOf(character.projectId))}</p>`, `<span class="row-icon">${icon('people')}</span>`)) : empty('people', '还没有角色')}`)) return;
  ctx.main.querySelector('#field-projectFilter')?.addEventListener('change', event => {
    ctx.go(query('/characters', { projectId: event.target.value }));
  });
}

export async function characterPage(ctx, characterId) {
  const [character, projects] = await Promise.all([
    readCharacter(characterId, ctx.signal), projectList(ctx.signal).catch(() => []),
  ]);
  const href = path('characters', characterId);
  const projectTitle = projects.find(project => project.projectId === character.projectId)?.title;
  const meta = `<p class="masthead-meta">${esc(projectTitle ?? (character.projectId ? '项目角色' : '独立角色'))}</p>`;
  if (ctx.url.searchParams.get('edit') === '1') {
    revision(character);
    return characterEditor(ctx, { character, cancel: href, trail: back(href, '返回角色'), meta });
  }
  const actions = link(query(href, { edit: '1' }), '编辑设定', 'pen', 'secondary') +
    link(query('/diaries/new', { characterId }), '写角色日记', 'diary', 'primary');
  ctx.show(character.name, `${heading(character.name, { trail: back(query('/characters', { projectId: character.projectId }), '角色'), meta, actions })}
    <article class="entry"><h2>角色设定</h2><div class="prose">${esc(character.persona)}</div></article>`);
}

export async function newCharacter(ctx) {
  const projects = await projectList(ctx.signal);
  const requested = ctx.url.searchParams.get('projectId') ?? '';
  const projectId = projects.some(project => project.projectId === requested) ? requested : '';
  const cancel = query('/characters', { projectId });
  return characterEditor(ctx, { projects, projectId, cancel, trail: back(cancel, '角色') });
}

const characterValues = character => ({ name: character.name, persona: character.persona });

async function characterEditor(ctx, { character, projects, projectId, cancel, trail, meta }) {
  const label = character ? '保存设定' : '创建角色';
  const title = character ? '编辑角色' : '新建角色';
  const operation = character ? 'character.revise' : 'character.create';
  const schema = await ctx.fields(operation);
  const draft = getDraft(ctx.key, character, character ? characterValues(character) : { name: '', projectId, persona: '' });
  const { values } = draft;
  const fields = field('name', '角色名称', { value: values.name, schema: schema.name }) +
    (character ? '' : field('projectId', '项目', { value: values.projectId, required: false, options: projectOptions(projects, '不归入项目') })) +
    field('persona', '角色设定', { value: values.persona, type: 'textarea', rows: 10, schema: schema.persona });
  if (!ctx.show(title, `${heading(title, { trail, meta })}${editor(fields, { label, cancel })}`)) return;
  bindEditor(ctx, draft, {
    label, operation, success: character ? '角色设定已保存' : '角色已创建', result: result => entity(result, 'characterId'),
    href: result => path('characters', result.characterId),
    input(current) {
      const { name, persona, projectId } = current.values;
      const input = { name: name.trim(), persona };
      if (character) return { ...input, characterId: character.characterId, expectedRevision: revision(current.record) };
      return projectId ? { ...input, projectId } : input;
    },
    latestValues: character ? characterValues : undefined,
    conflictText: '角色设定已有新版。请核对最新设定，再决定如何继续。',
    async readLatest(_, signal) {
      const latest = await readCharacter(character.characterId, signal);
      revision(latest);
      return latest;
    },
    preview: latest => `<details open><summary>最新版本 · 第 ${esc(latest.revision)} 版</summary>
      <p class="revision-title">${esc(latest.name)}</p><div class="revision-text">${esc(latest.persona)}</div></details>`,
  });
}
