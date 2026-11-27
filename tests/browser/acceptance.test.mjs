import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFitsViewport, openBrowser, screenshot, startService } from './harness.mjs';
import { clientName, pairPersonalClient } from './personal-api.mjs';

const desktop = { width: 1280, height: 900 };
const narrow = { width: 390, height: 844 };
const timeout = 60_000;

const firstDiary = {
  title: '雨停后的第一篇',
  body: '我把窗台擦干，听见街上的水声。\n今天开始写日记。',
  diaryDate: '2026-11-21',
};
const revisedDiary = {
  title: '雨停后的第二稿',
  body: '天色慢慢亮了。\n我重新写下窗外的水声。',
  diaryDate: '2026-11-22',
};
const characterDiary = {
  title: '巡夜后的记录',
  body: '我沿着石阶走到港口，数清了每一盏还亮着的灯。',
  diaryDate: '2026-11-23',
};

function heading(page, name) {
  return page.getByRole('heading', { level: 1, name, exact: true });
}

async function openNavigation(page) {
  if (page.viewportSize().width >= 640) return page;
  await page.getByRole('button', { name: '打开资料库导航', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '资料库', exact: true });
  await dialog.waitFor();
  return dialog;
}

async function nav(page, name) {
  const navigation = await openNavigation(page);
  await navigation.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true }).click();
}

async function settings(page) {
  const navigation = await openNavigation(page);
  await navigation.getByRole('navigation', { name: /^(?:应用设置|工作区工具)$/ }).getByRole('link', { name: '设置', exact: true }).click();
}

async function showLibrary(page) {
  if (page.viewportSize().width >= 640) return;
  const frame = page.locator('.manuscript-frame');
  if (await frame.getAttribute('data-pane') === 'editor') {
    await page.getByRole('button', { name: '返回文稿列表', exact: true }).click();
  }
  if (await frame.getAttribute('data-pane') === 'sheets') {
    await page.getByRole('button', { name: '资料库', exact: true }).click();
  }
}

async function home(page) {
  if (await page.locator('.manuscript-frame').count()) {
    await showLibrary(page);
  } else if (page.viewportSize().width < 640) {
    await nav(page, '首页');
    return;
  }
  await page.getByRole('link', { name: 'Sth 首页', exact: true }).click();
}

async function openProjects(page) {
  await home(page);
  await nav(page, '创作');
  await showLibrary(page);
}

function row(page, title) {
  return page.getByRole('link').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

function projectField(page) {
  return page.getByRole('combobox', { name: '项目', exact: true });
}

async function launch(t, viewport) {
  const origin = await startService(t);
  const page = await openBrowser(t, origin, viewport);
  const response = await page.goto('/');
  assert.equal(response.status(), 200);
  await page.getByRole('link', { name: '写日记', exact: true }).waitFor();
  return { page, origin };
}

async function pairThroughUi(page, origin) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await settings(page);
  const pairing = page.getByRole('region', { name: '配对码' });
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/web/connections/code' &&
      response.request().method() === 'POST'),
    pairing.getByRole('button', { name: '生成配对码', exact: true }).click(),
  ]);
  assert.equal(response.status(), 200);
  assert.deepEqual(response.request().postDataJSON(), {});
  const { code } = await response.json();
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  await pairing.getByText(`sth personal connect ${code}`, { exact: true }).waitFor();
  await pairing.getByRole('button', { name: '复制命令', exact: true }).click();
  await pairing.getByText('配对命令已复制。', { exact: true }).waitFor();
  const command = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(command, `sth personal connect ${code}`);
  const api = await pairPersonalClient(origin, command.split(' ').at(-1));
  await nav(page, '日记');
  return api;
}

async function fillDiary(page, diary) {
  await page.getByRole('textbox', { name: '标题', exact: true }).fill(diary.title);
  await page.getByLabel('日期').fill(diary.diaryDate);
  await page.getByRole('textbox', { name: '正文', exact: true }).fill(diary.body);
}

async function expectDiaryPage(page, diary) {
  await page.waitForURL(/\/diaries\/[0-9a-f-]{36}$/i);
  await heading(page, diary.title).waitFor();
  await page.getByRole('article').getByText(diary.body, { exact: true }).waitFor();
  const href = new URL(page.url()).pathname;
  assert.equal(await page.getByRole('main').locator('time').getAttribute('datetime'), diary.diaryDate);
  return { href, noteId: href.split('/').at(-1) };
}

async function createPersonalDiary(page) {
  const entry = await page.locator('.manuscript-frame').count()
    ? page.locator('.manuscript-sheets footer').getByRole('link', { name: '写日记', exact: true })
    : page.getByRole('link', { name: '写日记', exact: true });
  await entry.click();
  await heading(page, '写日记').waitFor();
  await page.locator('summary').filter({ hasText: /^写作上下文/ }).click();
  assert.equal(await projectField(page).inputValue(), '');
  assert.equal(await page.getByRole('combobox', { name: '叙述者', exact: true }).inputValue(), '');
  await fillDiary(page, firstDiary);
  await page.getByRole('button', { name: '保存日记', exact: true }).click();
  return expectDiaryPage(page, firstDiary);
}

async function editDiary(page) {
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await heading(page, '编辑日记').waitFor();
}

async function createScopedDiary(page, api, viewport) {
  const title = '灯塔计划';
  const name = '林澈';
  const persona = '负责夜间巡逻，习惯把观察写进手记。';

  await openProjects(page);
  await page.getByText('还没有作品。', { exact: false }).waitFor();
  await page.getByRole('link', { name: '新建作品', exact: true }).first().click();
  await page.getByRole('textbox', { name: '作品名称（必填）', exact: true }).fill(title);
  await page.getByRole('button', { name: '创建作品', exact: true }).click();
  await page.waitForURL(/\/projects\/(?!new)[^/]+$/);
  await page.locator('.library-sheet-scroll[aria-busy="false"]').waitFor();
  assert.deepEqual(await page.locator('.manuscript-sheets').getByRole('alert').allTextContents(), [], 'a newly created work opens without a library error');
  await page.locator('.manuscript-sheets').getByRole('heading', { name: title, exact: true }).waitFor();
  const { items: projects } = await api.invoke('project.list', {});
  assert.equal(projects.length, 1);
  const [{ projectId }] = projects;
  assert.deepEqual(projects, [{ projectId, title }]);

  await home(page);
  await nav(page, '角色');
  await page.getByRole('link', { name: '新建角色', exact: true }).click();
  await page.getByRole('textbox', { name: '角色名称', exact: true }).fill(name);
  await projectField(page).selectOption({ label: title });
  await page.getByRole('textbox', { name: '角色设定', exact: true }).fill(persona);
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await heading(page, name).waitFor();
  const characterId = new URL(page.url()).pathname.split('/').at(-1);
  const character = await api.invoke('character.read', { characterId });
  assert.deepEqual(character, { characterId, name, authorName: name, persona, description: persona, entries: [], projectId,
    revision: 1, href: `/characters/${characterId}` });

  await page.getByRole('region', { name: '角色详情', exact: true }).locator('summary').filter({ hasText: /^更多$/ }).click();
  await page.getByRole('link', { name: '写角色日记', exact: true }).click();
  await heading(page, '写日记').waitFor();
  await page.locator('summary').filter({ hasText: /^写作上下文/ }).click();
  assert.equal(await projectField(page).inputValue(), projectId);
  assert.equal(await page.getByRole('combobox', { name: '叙述者', exact: true }).inputValue(), characterId);
  await assertFitsViewport(page);
  await screenshot(page, viewport, 'character-editor');
  await fillDiary(page, characterDiary);
  await page.getByRole('button', { name: '保存日记', exact: true }).click();
  const identity = await expectDiaryPage(page, characterDiary);
  const expected = {
    ...characterDiary, ...identity, projectId, revision: 1,
    character: { characterId, name, revision: 1 },
  };
  assert.deepEqual(await api.invoke('diary.read', { noteId: identity.noteId }), expected);
  assert.deepEqual(await api.invoke('diary.list', { projectId }), { items: [expected] });
  await page.getByText(`${name} · ${title}`, { exact: false }).waitFor();
  await assertFitsViewport(page);
  await screenshot(page, viewport, 'character-diary');

  await page.goto(`/projects/${projectId}?view=overview`);
  await page.getByRole('article', { name: title, exact: true }).getByRole('navigation', { name: '作品内容' }).getByRole('link', { name: '日记', exact: true }).click();
  await row(page, characterDiary.title).waitFor();
  assert.equal(await projectField(page).inputValue(), projectId);
  assert.equal(await row(page, revisedDiary.title).count(), 0, 'project view excludes the personal diary');
}

for (const [name, viewport] of [['desktop', desktop], ['narrow', narrow]]) {
  test(`${name}: zero-project onboarding, personal diary edit, and project character diary`, { timeout }, async (t) => {
    const { page, origin } = await launch(t, viewport);
    const navigation = await openNavigation(page);
    assert.deepEqual(await navigation.getByRole('navigation', { name: '主导航' }).getByRole('link').allTextContents(),
      viewport.width < 640 ? ['首页', '日记', '创作', '角色', '资料', '任务'] : ['日记', '创作', '角色', '资料', '任务']);
    if (viewport.width < 640) {
      assert.deepEqual(await navigation.getByRole('navigation', { name: '应用设置' }).getByRole('link').allTextContents(), ['设置']);
      await navigation.getByRole('button', { name: '关闭', exact: true }).click();
      await navigation.waitFor({ state: 'hidden' });
    }
    await page.getByText('日记本还是空的', { exact: true }).waitFor();
    const api = await pairPersonalClient(origin);
    assert.deepEqual(await api.invoke('project.list', {}), { items: [] });
    assert.deepEqual(await api.invoke('diary.list', {}), { items: [] });
    const { operations } = await api.catalog();
    assert.equal(operations.find(({ id }) => id === 'diary.read')?.effect, 'read');
    await assertFitsViewport(page);
    await screenshot(page, name, 'onboarding');

    const identity = await createPersonalDiary(page);
    const { noteId } = identity;
    assert.deepEqual(await api.invoke('diary.read', { noteId }), { ...firstDiary, ...identity, revision: 1 });

    await editDiary(page);
    assert.equal(await page.getByRole('textbox', { name: '正文', exact: true }).inputValue(), firstDiary.body);
    await assertFitsViewport(page);
    await fillDiary(page, revisedDiary);
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    assert.deepEqual(await expectDiaryPage(page, revisedDiary), identity);
    assert.deepEqual(await api.invoke('diary.read', { noteId }), { ...revisedDiary, ...identity, revision: 2 });
    assert.deepEqual(await api.invoke('project.list', {}), { items: [] });

    await page.reload();
    assert.deepEqual(await expectDiaryPage(page, revisedDiary), identity);
    await assertFitsViewport(page);
    await screenshot(page, name, 'personal-diary');
    await createScopedDiary(page, api, name);
  });
}

test('the diary homepage links to a personal diary written through the connected API', { timeout }, async t => {
  const origin = await startService(t);
  const api = await pairPersonalClient(origin);
  assert.deepEqual(await api.invoke('project.list', {}), { items: [] });
  const saved = await api.invoke('diary.create', firstDiary);
  const page = await openBrowser(t, origin, narrow);
  assert.equal((await page.goto('/')).status(), 200);
  const entry = page.locator(`#diary-list a[href="${saved.href}"]`);
  await entry.click();
  assert.deepEqual(await expectDiaryPage(page, firstDiary), { href: saved.href, noteId: saved.noteId });
  await page.reload();
  await expectDiaryPage(page, firstDiary);
});

test('desktop: pairing command, stale diary edit recovery, and connection revocation', { timeout }, async (t) => {
  const { page, origin } = await launch(t, desktop);
  const api = await pairThroughUi(page, origin);
  const identity = await createPersonalDiary(page);
  const { noteId } = identity;
  await editDiary(page);

  const localBody = '这是我在浏览器里补写的段落。';
  const bodyField = page.getByRole('textbox', { name: '正文', exact: true });
  await bodyField.fill(localBody);
  const remote = await api.invoke('diary.revise', { ...revisedDiary, noteId, expectedRevision: 1 });
  assert.deepEqual(remote, { ...revisedDiary, ...identity, revision: 2 });

  const save = page.getByRole('button', { name: '保存修改', exact: true });
  const [conflictResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/web/invoke' &&
      response.request().method() === 'POST' && response.request().postDataJSON()?.operationId === 'diary.revise'),
    save.click(),
  ]);
  assert.equal(conflictResponse.status(), 409);
  assert.equal((await conflictResponse.json()).code, 'diary_revision_conflict');
  const conflict = page.getByRole('region', { name: '版本冲突' });
  await conflict.getByRole('alert').getByText('这篇日记已有新版。', { exact: false }).waitFor();
  await conflict.getByText(revisedDiary.body, { exact: true }).waitFor();
  assert.equal(await bodyField.inputValue(), localBody);
  assert.ok(await save.isDisabled(), 'save is disabled until the user resolves the conflict');
  assert.deepEqual(await api.invoke('diary.read', { noteId }), remote);
  await screenshot(page, 'desktop', 'revision-conflict');

  await conflict.getByRole('button', { name: '保留我的修改并采用新版', exact: true }).click();
  assert.equal(await bodyField.inputValue(), localBody);
  assert.equal(await page.getByRole('textbox', { name: '标题', exact: true }).inputValue(), revisedDiary.title);
  assert.equal(await page.getByLabel('日期').inputValue(), revisedDiary.diaryDate);
  await save.click();
  const merged = { ...revisedDiary, body: localBody };
  assert.deepEqual(await expectDiaryPage(page, merged), identity);
  assert.deepEqual(await api.invoke('diary.read', { noteId }), { ...merged, ...identity, revision: 3 });

  await settings(page);
  await page.getByRole('button', { name: `撤销连接 ${clientName}`, exact: true }).click();
  await page.getByRole('dialog', { name: '撤销连接' }).getByRole('button', { name: '撤销连接', exact: true }).click();
  await page.getByText('已撤销', { exact: true }).waitFor();
  const unauthorized = { status: 401, code: 'invalid_connection' };
  await api.catalog(unauthorized);
  await api.invoke('diary.read', { noteId }, unauthorized);
});
