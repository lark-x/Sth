/**
 * Reusable isolated manuscript fixture. No existing workspace is opened.
 *
 * const workspace = await startManuscriptWorkspace({ ui: 'source' });
 * try {
 *   const fixture = await createManuscriptFixture(workspace.invoke);
 *   // workspace.origin serves the real application; fixture.links are relative.
 * } finally { await workspace.close(); }
 *
 * A caller supplying its own invoke must point it at its own isolated database.
 * CLI: node scripts/manuscript-fixture.mjs --out <directory> [--ui source|built|snapshot]
 * Serves until interrupted. --once seeds, verifies, writes JSON, then closes.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from '../tests/browser/harness.mjs';

export const root = resolve(import.meta.dirname, '..');
export const viewports = Object.freeze([
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'compact', width: 320, height: 640 },
]);

export function parseOptions(argv, allowed = []) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!allowed.includes(key)) throw new Error(`Unknown argument ${key}`);
    if (['--help', '--once', '--strict'].includes(key)) options[key.slice(2)] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key.slice(2)] = value;
    }
  }
  return options;
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function inspectManuscriptBuild(ui = 'source') {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'tests'].includes(entry.name)
        || /\.test\.[cm]?[jt]s$|\.md$/i.test(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk('src');
  await walk('web');
  await walk(ui === 'built' ? 'frontend/dist' : 'frontend');
  files.push('package.json', 'package-lock.json', 'vite.config.ts');
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file.replaceAll('\\', '/')).update('\0').update(await readFile(join(root, file))).update('\0');
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  return {
    ui, head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'),
    status: git('status', '--short').split(/\r?\n/).filter(Boolean),
    contentSha256: hash.digest('hex'), fileCount: files.length,
    node: process.version, measuredAt: new Date().toISOString(),
  };
}

async function inspectBundle(directory) {
  const files = [];
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${name}/`);
      else if (entry.isFile()) files.push(name);
    }
  }
  await walk(directory);
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(join(directory, file))).update('\0');
  return { sha256: hash.digest('hex'), fileCount: files.length };
}

export async function startManuscriptWorkspace({ ui = 'source' } = {}) {
  assert.ok(['source', 'built', 'snapshot'].includes(ui), 'ui must be source, built or snapshot');
  const cleanup = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors = [];
    for (const action of cleanup.reverse()) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Isolated workspace cleanup failed');
  };
  try {
    const snapshotSource = ui === 'snapshot' ? await inspectManuscriptBuild('source') : undefined;
    // The harness overrides inherited port, data directory, public origin and auth.
    // Clear provider credentials so this fixture cannot contact a generation worker.
    const dataDir = await mkdtemp(join(tmpdir(), 'sth-manuscript-data-'));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const environment = { STH_CONTAINER: '0', STH_DATA_DIR: dataDir };
    for (const key of Object.keys(process.env)) {
      if (/COMFY|PROVIDER|GENERATION|EXTERNAL|API_KEY/i.test(key)) environment[key] = '';
    }
    const apiOrigin = await startService({ after: action => cleanup.push(action) }, environment);
    const calls = [];
    const invoke = async (operationId, input = {}) => {
      if (closed) throw new Error('The isolated workspace has already closed');
      const stepId = `manuscript:${randomUUID()}`;
      const response = await fetch(`${apiOrigin}/api/web/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: apiOrigin },
        body: JSON.stringify({ operationId, input, stepId }), signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json();
      calls.push({ operationId, stepId, status: response.status });
      assert.equal(response.status, 200, `${operationId}: ${JSON.stringify(body)}`);
      assert.ok(body.result !== undefined, `${operationId} returned no result`);
      return body.result;
    };
    let origin = apiOrigin;
    let capturedBuild;
    let inspectServedBundle;
    if (ui === 'source') {
      const { createServer } = await import('vite');
      const cacheDir = await mkdtemp(join(tmpdir(), 'sth-manuscript-vite-'));
      cleanup.push(() => rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
      const vite = await createServer({
        configFile: join(root, 'vite.config.ts'), configLoader: 'runner', cacheDir, logLevel: 'error',
        server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false, open: false, proxy: {
          '/api': { target: apiOrigin, changeOrigin: true,
            configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', apiOrigin)); } },
        } },
      });
      cleanup.push(() => vite.close());
      await vite.listen();
      origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    }
    if (ui === 'snapshot') {
      const { build, preview } = await import('vite');
      const cacheDir = await mkdtemp(join(tmpdir(), 'sth-manuscript-build-'));
      cleanup.push(() => rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
      const outDir = join(cacheDir, 'dist');
      const configuration = { configFile: join(root, 'vite.config.ts'), configLoader: 'runner', cacheDir, logLevel: 'error', clearScreen: false };
      await build({ ...configuration, build: { outDir, emptyOutDir: true } });
      // The production server serves the retained domain pages from /assets.
      // Vite's publicDir is disabled, so preserve that same native static route.
      await cp(join(root, 'web/assets'), join(outDir, 'assets'), { recursive: true });
      const after = await inspectManuscriptBuild('source');
      assert.equal(after.contentSha256, snapshotSource.contentSha256, 'Application source changed during the isolated build. Retry after the edits finish.');
      capturedBuild = { ...snapshotSource, ui, bundle: await inspectBundle(outDir), compiledAt: new Date().toISOString() };
      inspectServedBundle = () => inspectBundle(outDir);
      const server = await preview({ ...configuration, build: { outDir }, preview: {
        host: '127.0.0.1', port: 0, strictPort: false, open: false, proxy: {
          '/api': { target: apiOrigin, changeOrigin: true,
            configure(proxy) { proxy.on('proxyReq', request => request.setHeader('Origin', apiOrigin)); } },
        },
      } });
      cleanup.push(() => server.close());
      origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    }
    return { origin, apiOrigin, dataDir, invoke, calls, close, isolated: true, ui, capturedBuild, inspectServedBundle };
  } catch (error) {
    await close().catch(cleanupError => { error.cleanupError = cleanupError.message; });
    throw error;
  }
}

const passage = (body, excerpt, last = false) => {
  const start = last ? body.lastIndexOf(excerpt) : body.indexOf(excerpt);
  assert.ok(start >= 0, `Excerpt missing from fixture: ${excerpt}`);
  return { excerpt, range: { start, end: start + excerpt.length } };
};
const pinHref = (kind, id, revision, range) => `/${kind}/${id}?${new URLSearchParams({
  revision: String(revision), ...(range ? { start: String(range.start), end: String(range.end) } : {}),
})}`;

export async function createManuscriptFixture(invoke) {
  assert.equal(typeof invoke, 'function', 'Supply an invoke function for an isolated workspace');
  const project = await invoke('project.create', { title: '第三声以后' });
  const projectId = project.projectId;
  const sourceBody = '北港值夜簿\n十一月二十六日，雨。第一声钟响，收起北岸的缆绳。\n第二声钟响，旅人停在栈桥尽头。\n第三声钟响，末班渡船离开北岸。\n第三声钟响，巡灯人仍在岸边等待。\n旧值夜簿没有写明她在等待谁。';
  const source = await invoke('source.create', {
    title: '北港值夜簿 · 雨夜抄本', kind: 'excerpt', body: sourceBody, projectIds: [projectId],
  });
  const sourcePin = { sourceId: source.sourceId, revision: 1, ...passage(sourceBody, '第三声钟响，末班渡船离开北岸。') };
  const alternatePin = { sourceId: source.sourceId, revision: 1, ...passage(sourceBody, '第三声钟响，巡灯人仍在岸边等待。') };
  const character = await invoke('character.create', {
    projectId, name: '林澈', persona: '北港巡灯人。每到雨夜都会把一封未拆的信收进衣袋。只知道自己看见与听见的事情。',
    entries: [{ label: '值夜习惯', blocks: [{ type: 'text', text: '听见第三声钟响时，先望向北岸。' }] }],
  });
  const chapters = [];
  for (const title of ['第一章 · 雨停以前', '第二章 · 第三声以后', '第三章 · 写给留在岸上的人']) {
    chapters.push(await invoke('chapter.create', { projectId, title }));
  }
  const decision = await invoke('decision.propose', {
    projectId, title: '主线选择', body: '林澈在第三声钟响后登船，信仍未拆开。', basis: { sources: [sourcePin] },
  });
  const confirmed = await invoke('decision.confirm', {
    decisionId: decision.decisionId, expectedRevision: decision.revision,
    proposalRevision: decision.revision, authorConfirmed: true, confirmedBy: '样例作者',
  });
  const question = await invoke('question.save', { projectId, title: '寄信人是谁', body: '暂不揭晓寄信人的身份。' });
  const scene = await invoke('scene.create', { title: '栈桥尽头 · 等待第三声钟响的那个雨夜',
    time: '十一月二十六日深夜', place: '北港，北岸栈桥',
    characters: [{ characterId: character.characterId, revision: 1 }], sources: [sourcePin],
  });
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
  const oldBody = paragraphs.join('\n\n');
  const target = passage(oldBody, paragraphs[5]);
  const first = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1,
    title: '林澈的讲法 · 第三声以后那封仍未拆开的长信', body: oldBody });
  const sceneV2 = await invoke('scene.revise', { sceneId: scene.sceneId, expectedRevision: 1, sources: [alternatePin] });
  const second = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: sceneV2.revision,
    title: '船长的讲法', body: oldBody.replace(paragraphs[5], '第三声钟响以后，船长看见她把船票递了过来。') });
  const third = await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: sceneV2.revision,
    title: '岸上人的讲法', body: oldBody.replace(paragraphs[5], '第三声钟响以后，岸上的人只看见一盏灯慢慢远去。') });
  const adopted = await invoke('scene.adopt', { sceneId: scene.sceneId, expectedRevision: sceneV2.revision,
    draftId: first.draftId, draftRevision: 1 });
  const newBody = oldBody.replace(paragraphs[5], '第三声钟响以后，她把船票放在掌心，向亮着灯的渡船走去。');
  const revised = await invoke('draft.revise', { draftId: first.draftId, expectedRevision: 1, body: newBody });
  const prelude = await invoke('scene.create', { title: '巡灯人出门之前', sources: [sourcePin],
    characters: [{ characterId: character.characterId, revision: 1 }] });
  const preludeDraft = await invoke('draft.create', { sceneId: prelude.sceneId, sceneRevision: 1,
    title: '点灯', body: '林澈从抽屉里取出钥匙。雨声敲在窗沿，她把信装进了衣袋。' });
  await invoke('scene.adopt', { sceneId: prelude.sceneId, expectedRevision: 1, draftId: preludeDraft.draftId, draftRevision: 1 });
  const unadopted = await invoke('scene.create', { title: '未编定的清晨 · 三种结尾尚未选稿', sources: [sourcePin] });
  const endings = [];
  for (const [title, body] of [['天亮', '她在对岸等到天亮。'], ['回信', '她借了一支笔，给岸上的人回信。'], ['留白', '信放在桌上，这一页先停在这里。']]) {
    endings.push(await invoke('draft.create', { sceneId: unadopted.sceneId, sceneRevision: 1, title, body }));
  }
  const bare = await invoke('scene.create', { title: '没有引用的独白 · 一个足够长以检查窄屏换行的标题' });
  const bareDraft = await invoke('draft.create', { sceneId: bare.sceneId, sceneRevision: 1,
    title: '只留一句话', body: '今天没有查阅资料，只想把窗外的雨记下来。' });
  for (const [index, sceneIds] of [[0, [prelude.sceneId]], [1, [scene.sceneId]], [2, [unadopted.sceneId, bare.sceneId]]]) {
    chapters[index] = await invoke('chapter.arrange', { chapterId: chapters[index].chapterId, expectedRevision: 1, sceneIds });
  }
  const branch = await invoke('scene.branch', { sceneId: scene.sceneId, revision: adopted.revision,
    draft: { draftId: third.draftId, revision: 1 }, title: 'IF · 她留在岸上', branchName: 'IF · 没有登上的渡船',
    divergence: '第三声钟响时，她把船票交还给船长，留在北岸。' });
  const branchDraft = await invoke('draft.create', { sceneId: branch.sceneId, sceneRevision: 1,
    title: '岸上路线', body: '渡船离开了。林澈把票放回窗口，沿着来时的灯影往回走。' });
  await invoke('scene.adopt', { sceneId: branch.sceneId, expectedRevision: 1, draftId: branchDraft.draftId, draftRevision: 1 });
  const branchDecision = await invoke('decision.propose', { projectId, branchId: branch.sceneId,
    title: 'IF 的选择', body: '只在这条 IF 里留在北岸，主线仍然登船。', basis: { sources: [alternatePin] } });
  const diary = await invoke('diary.create', { projectId, title: '雨夜巡灯手记', diaryDate: '2026-11-26',
    characterId: character.characterId, expectedCharacterRevision: 1, sourcePins: [sourcePin],
    body: '第三声钟响过后，我走到北岸。雨把信封打湿了一角，我把它藏回衣袋。\n\n明天再来点灯的时候，想把今天没说完的话写下来。' });
  const diaryV2 = await invoke('diary.revise', { noteId: diary.noteId, expectedRevision: 1, title: diary.title, diaryDate: diary.diaryDate,
    body: `${diary.body}\n\n后来补记，北岸的灯一直亮到天明。` });
  const personalDiary = await invoke('diary.create', { title: '窗边的一句话', diaryDate: '2026-11-27', body: '雨停的时候，先记下一句话。' });
  const generations = [];
  for (const [draft, pin] of [[first, sourcePin], [second, alternatePin]]) {
    const prepared = await invoke('generations.prepare', { projectId, title: `本次依据 · ${draft.title}`, templateId: 'short-story',
      brief: '根据固定版本的值夜簿与人物设定修订这个场景，保留未拆信的悬念。',
      manuscript: { sceneId: draft.sceneId, sceneRevision: draft.sceneRevision },
      authorContext: { projectId, branchId: null, contextRevision: question.contextRevision },
      references: [{ kind: 'source', id: pin.sourceId, revision: pin.revision, excerpt: pin.excerpt, range: pin.range },
        { kind: 'character', id: character.characterId, revision: 1 }, { kind: 'draft', id: draft.draftId, revision: 1 }],
    });
    const parts = draft.body.split('\n\n');
    const generation = await invoke('generations.save', { generationId: prepared.generationId,
      output: { opening: parts[0], development: parts.slice(1, -1).join('\n\n'), ending: parts.at(-1) } });
    await invoke('generations.evidence.attach', { generationId: generation.generationId,
      draftId: draft.draftId, draftRevision: 1, authorConfirmed: true,
      passages: [{ ...passage(draft.body, parts[5]).range, referenceIndex: 0 }],
    });
    generations.push(generation);
  }
  const sourceV2 = await invoke('source.revise', { sourceId: source.sourceId, expectedRevision: 1,
    body: `${sourceBody}\n后附校订，末班渡船改为第二声钟响后离港。这条校订尚未用于旧稿。` });
  const characterV2 = await invoke('character.revise', { characterId: character.characterId, expectedRevision: 1,
    persona: `${character.persona}\n后续设定补记，她在对岸学会修船。` });
  const links = {
    home: '/', library: '/workspace?tab=projects', project: `/projects/${projectId}`,
    scene: `/scenes/${scene.sceneId}`, oldDraft: pinHref('drafts', first.draftId, 1),
    oldPassage: pinHref('drafts', first.draftId, 1, target.range),
    latestDraft: `/drafts/${first.draftId}`, newDraft: pinHref('drafts', first.draftId, revised.revision),
    compare: `/scenes/${scene.sceneId}?action=compare&left=${first.draftId}@1&right=${second.draftId}@1`,
    versions: `/scenes/${scene.sceneId}?action=compare&left=${first.draftId}@1&right=${first.draftId}@2`,
    source: pinHref('sources', source.sourceId, 1, sourcePin.range), character: pinHref('characters', character.characterId, 1),
    diary: `/diaries/${diary.noteId}`, oldDiary: pinHref('diaries', diary.noteId, 1),
    bare: `/drafts/${bareDraft.draftId}`, unadopted: `/scenes/${unadopted.sceneId}`,
    branch: `/scenes/${branch.sceneId}`, branchBook: `/branches/${branch.sceneId}`,
    authorContext: `/author-context?projectId=${projectId}`,
    prompt: `/generations/${generations[0].generationId}/prompt`,
  };
  // These reads verify the immutable old text, selected version and IF isolation.
  const currentScene = await invoke('scene.read', { sceneId: scene.sceneId });
  assert.equal(currentScene.adopted.revision, 1);
  assert.equal(currentScene.adopted.body, oldBody);
  assert.equal((await invoke('draft.read', { draftId: first.draftId, revision: 1 })).body, oldBody);
  assert.equal((await invoke('draft.read', { draftId: first.draftId })).body, newBody);
  assert.equal((await invoke('draft.list', { sceneId: scene.sceneId })).items.length, 3);
  assert.equal((await invoke('scene.read', { sceneId: unadopted.sceneId })).adopted, undefined);
  for (const [index, draft] of [first, second].entries()) {
    const evidence = await invoke('generations.evidence.list', { sceneId: draft.sceneId,
      sceneRevision: draft.sceneRevision, draftId: draft.draftId, draftRevision: 1 });
    assert.equal(evidence.items[0].generation.generationId, generations[index].generationId);
    assert.equal(evidence.items[0].relation, 'author-confirmed');
  }
  assert.deepEqual((await invoke('generations.evidence.list', { sceneId: revised.sceneId,
    sceneRevision: revised.sceneRevision, draftId: revised.draftId, draftRevision: revised.revision })).items, []);
  const ifContext = await invoke('story.context', { projectId, branchId: branch.sceneId });
  assert.equal(ifContext.confirmedDecisions.items.length, 0);
  assert.equal(ifContext.pendingDecisions.items[0].decisionId, branchDecision.decisionId);
  // Reserve mutable selection exercises before any screenshots. Each viewport
  // gets its own scene, while the principal manuscript remains unchanged.
  const practiceProject = await invoke('project.create', { title: '网页选稿练习' });
  const practiceChapter = await invoke('chapter.create', { projectId: practiceProject.projectId, title: '待选的六幕' });
  const practices = {};
  for (const key of ['chromium-desktop', 'chromium-tablet', 'chromium-phone', 'chromium-compact', 'webkit-phone', 'webkit-compact']) {
    const scene = await invoke('scene.create', { title: `选稿练习 · ${key}` });
    const drafts = [];
    for (const [title, body] of [['近景', '她把信放在灯下。'], ['远景', '北岸的灯在雨里亮着。'], ['留白', '这一页，留给天亮以后。']]) {
      drafts.push(await invoke('draft.create', { sceneId: scene.sceneId, sceneRevision: 1, title, body }));
    }
    practices[key] = { scene, drafts, chapterId: practiceChapter.chapterId, projectId: practiceProject.projectId };
  }
  await invoke('chapter.arrange', { chapterId: practiceChapter.chapterId, expectedRevision: 1,
    sceneIds: Object.values(practices).map(practice => practice.scene.sceneId) });
  return {
    schemaVersion: 1, provenance: 'synthetic isolated sample, persisted through real /api/web/invoke operations',
    project, chapters, scene: currentScene, drafts: [first, second, third], revised, target,
    bodies: { old: oldBody, latest: newBody }, prelude, unadopted, endings, bare, bareDraft,
    branch, branchDraft, diary: diaryV2, oldDiary: diary, personalDiary,
    character, characterV2, source, sourceV2, sourcePin, alternatePin,
    confirmed, question, branchDecision, generations, practices, links,
    contentSha256: createHash('sha256').update(oldBody).update(newBody).update(sourceBody).digest('hex'),
    generationRelationship: 'Synthetic author confirmation attaches a saved structured result to each exact first revision through generations.evidence.attach. Revised drafts do not inherit it. No external model is executed.',
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2), ['--out', '--ui', '--once', '--help']);
  if (options.help) {
    console.log('node scripts/manuscript-fixture.mjs --out <directory> [--ui source|built|snapshot] [--once]');
    return;
  }
  assert.ok(options.out, '--out is required');
  const output = resolve(options.out);
  const workspace = await startManuscriptWorkspace({ ui: options.ui });
  try {
    const fixture = await createManuscriptFixture(workspace.invoke);
    await writeJson(join(output, 'fixture.json'), { ...fixture, origin: workspace.origin,
      serviceActiveAfterCommand: !options.once, build: workspace.capturedBuild ?? await inspectManuscriptBuild(workspace.ui) });
    console.log(JSON.stringify({ origin: workspace.origin, fixture: join(output, 'fixture.json'),
      project: workspace.origin + fixture.links.project, serviceActive: !options.once }, null, 2));
    if (!options.once) await new Promise(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally { await workspace.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
