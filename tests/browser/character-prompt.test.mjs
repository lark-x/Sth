import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { assertFitsViewport, openBrowser, startService } from './harness.mjs';

const narrow = { width: 390, height: 844 };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ4sAAAAASUVORK5CYII=', 'base64');

function wav() {
  const samples = 8000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(samples, 24);
  buffer.writeUInt32LE(samples * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}

const title = (page, name) => page.getByRole('heading', { level: 1, name, exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const link = (page, name) => page.getByRole('link', { name, exact: true });
const currentPath = page => new URL(page.url()).pathname;
const idAt = page => currentPath(page).split('/').at(-1);
const timeout = 45_000;

async function launch(t, viewport = narrow) {
  const origin = await startService(t);
  const page = await openBrowser(t, origin, viewport);
  async function invoke(operationId, input) {
    const response = await page.request.post('/api/web/invoke', { data: { operationId, stepId: `test:${randomUUID()}`, input } });
    const payload = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(payload));
    return payload.result;
  }
  return { page, invoke };
}

test('character cards upload real media, preserve order and revisions, and link scene and diary evidence', { timeout }, async t => {
  const { page, invoke } = await launch(t);
  const scene = await invoke('scene.create', { title: '夜航' });
  assert.equal((await page.goto('/characters')).status(), 200);
  await link(page, '新建角色').click();
  await button(page, '添加条目').click();
  await page.getByLabel('条目名称').fill('港口记录');
  await button(page, '添加图片').click();
  await page.getByLabel('图片文件').setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: png });
  await page.getByText('已上传 portrait.png', { exact: true }).waitFor();
  await button(page, '添加音频').click();
  const clip = wav();
  await page.getByLabel('音频文件').setInputFiles({ name: 'voice.wav', mimeType: 'audio/x-wav', buffer: clip });
  await page.getByText('已上传 voice.wav', { exact: true }).waitFor();
  await assertFitsViewport(page);
  await button(page, '创建角色').click();
  await title(page, '未命名角色').waitFor();
  const characterId = idAt(page);
  const characterPath = currentPath(page);
  const first = await invoke('character.read', { characterId, revision: 1 });
  assert.equal(first.authorName, undefined);
  assert.equal(first.persona, '');
  assert.deepEqual(first.entries[0].blocks.map(block => block.type), ['image', 'audio']);
  const image = page.getByRole('img', { name: '港口记录' });
  await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('main img')?.naturalWidth === 1);
  const audio = page.locator('audio');
  assert.equal(await audio.getAttribute('src'), `/api/web/assets/${first.entries[0].blocks[1].assetId}/content`);
  const bytes = await page.request.get(await audio.getAttribute('src'));
  assert.equal(bytes.headers()['content-type'], 'audio/wav');
  assert.deepEqual(await bytes.body(), clip);
  await audio.scrollIntoViewIfNeeded();
  await audio.evaluate(async player => { await player.play(); });
  assert.equal(await audio.evaluate(player => player.duration), 1);

  await link(page, '写角色日记').click();
  await title(page, '写日记').waitFor();
  await page.getByLabel('标题').fill('晚班日记');
  await page.getByLabel('正文').fill('我登上末班渡轮。');
  await button(page, '保存日记').click();
  await title(page, '晚班日记').waitFor();
  const diaryPath = currentPath(page);
  await button(page, '依据与修订').click();
  await link(page, '查看角色证据 · 第 1 版').click();
  await title(page, '未命名角色').waitFor();
  assert.match(page.url(), /\?revision=1$/);
  await link(page, '查看当前版本').click();
  await link(page, '编辑设定').click();
  await page.getByLabel('角色名称').fill('渡船领航员');
  await page.getByLabel('角色设定').fill('只上夜班。');
  await button(page, '添加文本').click();
  await page.getByLabel('文本内容').fill('熟悉潮汐。');
  await button(page, '添加资料链接').click();
  await page.getByLabel('资料类型').selectOption('scene');
  await page.getByLabel('资料记录').selectOption(scene.sceneId);
  assert.equal(await page.getByLabel('资料版本').inputValue(), '1');
  await button(page.locator('.character-block').nth(3), '上移内容').click();
  await button(page, '添加条目').click();
  await page.getByLabel('条目名称').nth(1).fill('临时条目');
  await button(page.locator('.character-entry').nth(1), '移除条目').click();
  await button(page, '添加条目').click();
  await page.getByLabel('条目名称').nth(1).fill('私下记录');
  await button(page.locator('.character-entry').nth(1), '添加文本').click();
  await page.getByLabel('文本内容').nth(1).fill('收集旧船票。');
  await button(page.locator('.character-entry').nth(1), '上移条目').click();
  await button(page.locator('.character-block').filter({ has: page.getByLabel('音频文件') }), '移除内容').click();
  await button(page, '保存设定').click();
  await title(page, '渡船领航员').waitFor();
  const latest = await invoke('character.read', { characterId });
  assert.equal(latest.revision, 2);
  assert.deepEqual(latest.entries.map(entry => entry.label), ['私下记录', '港口记录']);
  assert.equal(latest.entries[1].entryId, first.entries[0].entryId);
  assert.deepEqual(latest.entries[1].blocks.map(block => block.type), ['image', 'reference', 'text']);
  await link(page, '场景 · 第 1 版').click();
  await title(page, '夜航').waitFor();
  await page.locator('summary').filter({ hasText: /^场景上下文与角色证据$/ }).click();
  await link(page, '渡船领航员 · 第 2 版 · 港口记录').click();
  await title(page, '渡船领航员').waitFor();
  assert.match(page.url(), /\?revision=2$/);
  await page.goto(diaryPath);
  await button(page, '依据与修订').click();
  await link(page, '查看角色证据 · 第 1 版').click();
  await title(page, '未命名角色').waitFor();
  assert.equal(currentPath(page), characterPath);
  await page.locator('audio[controls]').waitFor();
  await assertFitsViewport(page);
});

test('prompt inspector opens directly and keeps selected evidence at its original revision', { timeout }, async t => {
  const { page, invoke } = await launch(t, { width: 1280, height: 900 });
  const phrase = '旧航图「A」"\\B';
  const asset = await invoke('asset.import', { contentType: 'image/png', data: png.toString('base64') });
  const character = await invoke('character.create', { name: '岚', persona: '偏爱夜航。', entries: [{ label: '船舱线索', blocks: [
    { type: 'text', text: `只在港口使用${phrase}。` }, { type: 'image', assetId: asset.assetId }, { type: 'text', text: '未选中的私密片段。' },
  ] }, { label: '私密条目标题', blocks: [{ type: 'text', text: '私密条目内容。' }] }] });

  async function prepare(name, select = false) {
    await page.goto('/generations');
    await link(page, '准备写作').click();
    await page.getByLabel('标题').fill(name);
    await page.getByLabel('创作要求').fill(`写一段关于${phrase}的归航。`);
    await page.getByLabel(/^内容模板(?: \*)?$/).selectOption('diary');
    await button(page, '添加参考资料').click();
    await page.getByLabel(/^类型(?: \*)?$/).selectOption('character');
    await page.getByLabel('记录编号').selectOption(character.characterId);
    const text = page.getByRole('checkbox', { name: /船舱线索 · 文本 1/ });
    await text.waitFor();
    assert.equal(await text.isChecked(), false);
    if (select) {
      await page.getByLabel('附上角色描述').uncheck();
      await text.check();
      await page.getByRole('checkbox', { name: /船舱线索 · 图片 2/ }).check();
    }
    await button(page, '准备写作').click();
    await title(page, name).waitFor();
    return idAt(page);
  }

  const coreId = await prepare('角色核心');
  const core = await invoke('generations.get', { generationId: coreId });
  assert.equal(core.composition.references[0].selections, undefined);
  assert.equal(core.composition.references[0].content.entries, undefined);

  const generationId = await prepare('归航片段', true);
  const entryId = character.entries[0].entryId;
  const stored = await invoke('generations.get', { generationId });
  assert.deepEqual(stored.composition.references[0].selections, [{ entryId, blockIndex: 0 }, { entryId, blockIndex: 1 }]);
  const prompt = await invoke('generations.prompt', { generationId });
  assert.doesNotMatch(JSON.stringify(prompt.messages), /偏爱夜航/);
  assert.equal(prompt.href, `/generations/${generationId}/prompt`);
  const span = suffix => prompt.provenance.find(item => item.disposition === 'included' && item.path.endsWith(suffix));
  const offsets = source => `UTF-16 [${source.start}, ${source.end})`;
  await invoke('character.revise', { characterId: character.characterId, expectedRevision: 1, persona: '改去白天。', entries: [] });
  await link(page, '提示词组成').click();
  await title(page, '提示词组成').waitFor();
  assert.equal(currentPath(page), `/generations/${generationId}/prompt`);
  await page.getByText('已提供给当前对话', { exact: true }).waitFor();
  await page.getByText(/只在港口使用旧航图/).waitFor();
  assert.equal(await page.getByText(/改去白天|未选中的私密片段|私密条目标题|私密条目内容/).count(), 0);
  const image = page.getByRole('img', { name: '图片' });
  assert.equal(await image.getAttribute('src'), asset.href);
  await page.getByText(createHash('sha256').update(png).digest('hex'), { exact: true }).waitFor();
  await page.getByLabel('查找消息文字').fill(phrase);
  await button(page, '查找').click();
  await page.getByText('第 1 处，共 2 处', { exact: true }).waitFor();
  const origin = page.locator('#prompt-origin');
  assert.match(await origin.innerText(), /创作要求/);
  assert.ok((await origin.innerText()).includes(offsets(span('/brief'))));
  await button(page, '下一处').click();
  await page.getByText('第 2 处，共 2 处', { exact: true }).waitFor();
  const noteSpan = span('/blocks/0/text');
  assert.ok((await origin.innerText()).includes(offsets(noteSpan)));
  assert.equal(await page.locator('#prompt-match-excerpt mark').textContent(), JSON.stringify(phrase).slice(1, -1));
  const pinnedCard = link(origin, '角色 · 第 1 版 · 船舱线索 · 文本 1');
  assert.equal(await pinnedCard.getAttribute('href'), `/characters/${character.characterId}?revision=1`);
  await button(page, '定位到消息').click();
  assert.equal(await page.locator('.prompt-text:focus').count(), 1);
  await pinnedCard.click();
  await title(page, '岚').waitFor();
  assert.match(page.url(), /\?revision=1$/);
  await page.getByText(`只在港口使用${phrase}。`, { exact: true }).waitFor();
  await page.setViewportSize(narrow);
  assert.equal((await page.goto(`/generations/${generationId}/prompt`)).status(), 200);
  await title(page, '提示词组成').waitFor();
  await assertFitsViewport(page);
  const imagePart = page.locator('.prompt-part').filter({ has: image });
  await imagePart.getByText('内容来源', { exact: true }).click();
  await link(imagePart, '角色 · 第 1 版 · 船舱线索 · 图片 2').click();
  await title(page, '岚').waitFor();
  assert.match(page.url(), /\?revision=1$/);
});
