import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { listen, setupService } from './service-fixture.mjs';

const adapters = fileURLToPath(new URL('../', import.meta.url));
const cli = join(adapters, 'mcp', 'cli.mjs');
const discover = 'sth_personal_discover';
const invoke = 'sth_personal_invoke';
const receipt = 'sth_personal_receipt';
const python = process.env.STH_TEST_HERMES_PYTHON;
const workspaceOperations = [
  ['source', 'sources', 'source.create', 'source.read'],
  ['scene', 'scenes', 'scene.create', 'scene.read'],
  ['templates', 'templates', 'templates.create', 'templates.get'],
  ['jobs', 'jobs', 'jobs.create', 'jobs.read'],
];

function pair(origin, path, code) {
  return new Promise((resolvePair, reject) => {
    const child = spawn(process.execPath, [cli, 'pair', path], {
      env: { ...process.env, STH_PERSONAL_OPERATIONS_ORIGIN: origin }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolvePair({ status, stdout, stderr }));
    child.stdin.end(`${code}\n`);
  });
}

async function mcp(t, file, env) {
  const client = new Client({ name: 'sth-adapter-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'stdio', ...(file ? [file] : [])], env }));
  assert.equal(client.getServerVersion().name, 'sth-personal-mcp');
  return (name, args = {}) => client.callTool({ name, arguments: args });
}

function toolError(response, code) {
  assert.equal(response.isError, true);
  assert.equal(JSON.parse(response.content[0].text).error, code);
}

async function mcpOperation(call, operationId, stepId, input) {
  const response = await call(invoke, { operationId, stepId, input });
  assert.ok(response.structuredContent, response.content[0].text);
  assert.equal(response.structuredContent.replayed, false);
  return response.structuredContent.result;
}

test('SDK stdio pairs independently and round-trips real Sth writes, replay, receipts and revocation', { timeout: 30_000 }, async t => {
  const f = await setupService(t);
  const code = await f.code();
  const invalid = await pair(f.origin, join(f.directory, 'invalid-pair'), 'malformed');
  assert.equal(invalid.status, 1);
  assert.equal(f.calls.length, 0);
  const issued = await pair(f.origin, join(f.directory, 'mcp'), code);
  assert.equal(issued.status, 0, issued.stderr);
  const { file, connectionId, ...extra } = JSON.parse(issued.stdout);
  assert.deepEqual(extra, {});
  const { origin, token, ...stored } = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(stored, { connectionId });
  assert.equal(origin, f.origin);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!issued.stdout.includes(code) && !issued.stdout.includes(token) && !issued.stderr);

  const client = new Client({ name: 'sth-file-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'stdio', file],
    env: { STH_PERSONAL_OPERATIONS_ORIGIN: 'http://127.0.0.1:1' } }));
  assert.equal(client.getServerVersion().name, 'sth-personal-mcp');
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [discover, invoke, receipt]);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const index = (await call(discover)).structuredContent;
  const byId = new Map(index.operations.map(item => [item.id, item]));
  assert.equal(byId.get('diary.create').effect, 'write');
  assert.ok(index.operations.every(item => !item.inputSchema && !item.outputSchema));
  for (const [prefix, route, write, read] of workspaceOperations) {
    assert.ok(index.resourcePaths.includes(route));
    assert.equal(byId.get(write)?.effect, 'write');
    assert.equal(byId.get(read)?.effect, 'read');
    const details = (await call(discover, { prefix })).structuredContent.operations;
    assert.ok(details.some(item => item.id === write));
    assert.ok(details.some(item => item.id === read));
    assert.ok(details.every(item => item.id.startsWith(`${prefix}.`) && item.inputSchema && item.outputSchema));
  }
  const { operations } = (await call(discover, { operationId: 'diary.create' })).structuredContent;
  assert.equal(operations.length, 1);
  const descriptor = operations.find(item => item.id === 'diary.create');
  assert.equal(descriptor.interaction.localDateField, 'diaryDate');
  assert.equal(descriptor.inputSchema.properties.diaryDate.type, 'string');

  const lookup = { operationId: 'diary.create', stepId: 'delivery-1:diary' };
  const input = { title: 'MCP diary', body: 'A saved entry.', diaryDate: '2024-02-29' };
  toolError(await call(receipt, lookup), 'operation_receipt_not_found');
  const saved = (await call(invoke, { ...lookup, input })).structuredContent;
  assert.equal(saved.stepId, 'sth.mcp.v1:delivery-1:diary');
  assert.equal(saved.replayed, false);
  assert.equal(saved.result.href, `/diaries/${saved.result.noteId}`);
  assert.equal(saved.result.projectId, undefined);
  assert.equal(saved.result.body, input.body);
  assert.deepEqual(await f.invoke('diary.read', 'web-read', { noteId: saved.result.noteId }), saved.result);
  assert.deepEqual((await call(invoke, { ...lookup, input })).structuredContent, { ...saved, replayed: true });
  toolError(await call(invoke, { ...lookup, input: { ...input, body: 'Regenerated text' } }), 'operation_step_conflict');
  for (const args of [{ ...lookup, input, stepId: 'x'.repeat(502) }, { ...lookup, input, projectId: 'forced' }]) {
    toolError(await call(invoke, args), 'invalid_tool_call');
  }
  const source = await mcpOperation(call, 'source.create', 'save-source', {
    kind: 'setting', title: 'MCP source', body: 'An original source saved via stdio.',
  });
  assert.equal(source.href, `/sources/${source.sourceId}?revision=1`);
  const oldPin = { sourceId: source.sourceId, revision: source.revision };
  assert.deepEqual(await f.invoke('source.read', 'web-read-stdio-source', oldPin), source);
  const changed = await f.invoke('source.revise', 'web-update-source', {
    sourceId: source.sourceId, expectedRevision: source.revision, body: 'Edited on the web.',
  });
  assert.equal(changed.href, `/sources/${source.sourceId}?revision=2`);
  assert.deepEqual(await mcpOperation(call, 'source.read', 'read-source-old', oldPin), source);
  assert.deepEqual(await mcpOperation(call, 'source.read', 'read-source-new', { sourceId: source.sourceId }), changed);
  const env = { STH_PERSONAL_OPERATIONS_TOKEN: token, STH_PERSONAL_OPERATIONS_ORIGIN: origin };
  const restarted = await mcp(t, undefined, env);
  assert.deepEqual((await restarted(receipt, lookup)).structuredContent, { ...saved, replayed: true });
  const rejected = await pair(f.origin, join(f.directory, 'used-code'), code);
  assert.equal(rejected.status, 1);
  assert.ok(!rejected.stdout && !rejected.stderr.includes(code));
  await f.revoke(connectionId);
  toolError(await restarted(discover), 'connection_unauthorized');
  assert.equal(f.diaryCount(), 1);
  assert.ok(f.calls.every(call => call.method === 'POST' && call.bearer === (call.action !== 'claim')));
});

test('installed Hermes QQ and WeChat continue one source with the web and MCP stdio', {
  skip: !python && 'Set STH_TEST_HERMES_PYTHON to the installed Hermes interpreter', timeout: 90_000,
}, async t => {
  const f = await setupService(t);
  const { run } = await hermesProfile(f);
  const portal = 'https://portal.example.test';
  const sourceInput = { kind: 'setting', title: '北港渡船', body: '北港末班渡船是晚上十点。' };
  const qq = await run('workspace-qq', { code: await f.code(), portal, sourceInput });
  const { portalUrl, ...source } = qq.write.result;
  const { sourceId, revision } = source;
  const sourcePin = { sourceId, revision };
  assert.equal(portalUrl, `${portal}/sources/${sourceId}?revision=1`);
  assert.deepEqual(await f.invoke('source.read', 'read-qq-source', sourcePin), source);
  const currentSource = await f.invoke('source.revise', 'revise-qq-source', {
    sourceId, expectedRevision: revision, body: '北港末班渡船是晚上九点。',
  });

  const issued = await pair(f.origin, join(f.directory, 'workspace-mcp'), await f.code());
  assert.equal(issued.status, 0, issued.stderr);
  const call = await mcp(t, JSON.parse(issued.stdout).file);
  assert.deepEqual(await mcpOperation(call, 'source.read', 'read-qq-source', sourcePin), source);
  const sceneCreated = await mcpOperation(call, 'scene.create', 'save-scene', {
    title: '北港那一晚', place: '北港渡口', sources: [{ ...sourcePin, excerpt: '晚上十点' }],
  });
  const { sceneId } = sceneCreated;
  const { projectId } = await f.invoke('project.create', 'workspace-project', { title: '北港故事' });
  const chapter = await f.invoke('chapter.create', 'workspace-chapter', { projectId, title: '第一章' });
  await f.invoke('chapter.arrange', 'place-stdio-scene', {
    chapterId: chapter.chapterId, expectedRevision: chapter.revision, sceneIds: [sceneId],
  });
  const scene = await f.invoke('scene.read', 'read-stdio-scene', { sceneId, revision: sceneCreated.revision });
  assert.equal(scene.placement.projectId, projectId);
  assert.deepEqual(scene.sources, [{ ...sourcePin, excerpt: '晚上十点', href: source.href }]);

  const templateCreated = await mcpOperation(call, 'templates.create', 'save-template', {
    title: '北港场景模板', kind: 'short-story', fields: [{ key: 'body', label: '正文', type: 'text' }],
  });
  const template = await f.invoke('templates.get', 'read-stdio-template', {
    templateId: templateCreated.templateId, revision: templateCreated.revision,
  });
  assert.deepEqual(template.fields, templateCreated.fields);

  const composition = await f.invoke('composition.create', 'workspace-composition', {
    projectId, sceneId, sceneRevision: scene.revision, candidates: [{ title: '渡口远景', prompt: 'Ferry dock at night' }],
  });
  const choice = { compositionId: composition.compositionId, candidateId: composition.candidates[0].candidateId };
  await f.invoke('composition.select', 'workspace-select', { ...choice, expectedSelectionRevision: composition.selectionRevision });
  const job = await mcpOperation(call, 'jobs.create', 'queue-job', { projectId, title: '渡口插图', items: [choice] });
  assert.equal(job.items[0].scene.href, scene.href);
  assert.equal(job.items[0].status, 'queued');
  assert.deepEqual(await f.invoke('jobs.read', 'read-stdio-job', { jobId: job.jobId }), job);

  const newBody = '北港末班渡船是晚上八点。';
  const wechat = await run('workspace-wechat', { code: await f.code(), portal, source, currentSource, scene, template, job, newBody });
  assert.equal(wechat.writes.length, 1);
  const { portalUrl: revisedUrl, ...revised } = wechat.write.result;
  assert.equal(revisedUrl, `${portal}/sources/${sourceId}?revision=3`);
  assert.equal(revised.sourceId, sourceId);
  assert.deepEqual(await f.invoke('source.read', 'read-wechat-source', { sourceId, revision: 3 }), revised);
  assert.deepEqual(await mcpOperation(call, 'source.read', 'read-wechat-source', { sourceId }), revised);
  assert.deepEqual(await mcpOperation(call, 'source.read', 'preserve-qq-source', sourcePin), source);
  const restricted = wechat.restrictedSource;
  assert.deepEqual(await f.invoke('source.read', 'read-unlisted-source', { sourceId: restricted.sourceId }), restricted);
  assert.deepEqual((await f.connections()).map(connection => connection.clientName).sort(),
    ['Sth Hermes QQ', 'Sth Hermes WeChat', 'Sth MCP']);
  assert.equal(f.diaryCount(), 0);
});

test('MCP redacts echoed credentials and refuses redirected authenticated requests', { timeout: 20_000 }, async t => {
  const token = randomBytes(32).toString('base64url');
  let redirected = 0;
  const target = await listen(t, createServer((_req, res) => { redirected++; res.end('{}'); }));
  const origin = await listen(t, createServer((req, res) => {
    if (req.url.endsWith('/catalog')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ operations: [], echo: token }));
    } else if (req.url.endsWith('/receipt')) {
      res.writeHead(307, { Location: target }).end();
    } else {
      res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'fixture_error', message: token }));
    }
  }));
  const call = await mcp(t, undefined, { STH_PERSONAL_OPERATIONS_TOKEN: token, STH_PERSONAL_OPERATIONS_ORIGIN: origin });
  const catalog = await call(discover);
  assert.equal(catalog.structuredContent.echo, '[redacted]');
  assert.ok(!JSON.stringify(catalog).includes(token));
  const lookup = { operationId: 'diary.create', stepId: 'fixture' };
  const failed = await call(invoke, { ...lookup, input: {} });
  toolError(failed, 'fixture_error');
  assert.ok(!JSON.stringify(failed).includes(token));
  toolError(await call(receipt, lookup), 'sth_unavailable');
  assert.equal(redirected, 0);
});

async function hermesProfile(f) {
  const home = join(f.directory, 'profiles', 'sth');
  await mkdir(home, { recursive: true });
  await cp(join(adapters, 'hermes_plugin'), join(home, 'plugins', 'sth-personal-operations'), {
    recursive: true, filter: path => !path.includes('__pycache__'),
  });
  await writeFile(join(home, 'config.yaml'), [
    'plugins:', '  enabled:', '    - sth-personal-operations', 'platform_toolsets:', '  qqbot:',
    '    - sth-personal-operations', '  weixin:', '    - sth-personal-operations', '',
  ].join('\n'));
  const source = process.env.STH_TEST_HERMES_SOURCE || resolve(dirname(python), '..', '..');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|NUMBER_OF_PROCESSORS)$/i.test(name)));
  for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TEMP', 'TMP', 'TMPDIR']) {
    env[name] = home;
  }
  const runtime = { ...env, HERMES_HOME: home, HERMES_DISABLE_LAZY_INSTALLS: '1',
    PYTHONPATH: [source, join(source, 'workspace')].join(delimiter), HERMES_DISABLE_AUTO_UPDATE: '1' };
  const execute = promisify(execFile);
  const { stdout: gatewayHelp } = await execute(python, ['-B', '-X', 'utf8', '-m', 'hermes_cli.main', 'gateway', 'run', '--help'], {
    cwd: home, timeout: 25_000, env: runtime,
  });
  assert.match(gatewayHelp, /--no-supervise/);
  const script = join(adapters, 'tests', 'personal-hermes.py');
  return {
    home,
    async run(stage, fields = {}) {
      const { stdout } = await execute(python, ['-B', '-X', 'utf8', script], {
        cwd: home, timeout: 25_000, env: { ...runtime, QQ_ALLOWED_USERS: 'fixture-author,fixture-other',
          WEIXIN_ALLOWED_USERS: 'fixture-author', STH_PERSONAL_OPERATIONS_ORIGIN: f.origin,
          STH_PERSONAL_OPERATIONS_TIME_ZONE: 'UTC', STH_PERSONAL_FIXTURE: JSON.stringify({ stage, ...fields }) },
      });
      if (fields.code) assert.ok(!stdout.includes(fields.code));
      const outcome = stdout.match(/^PERSONAL_QA (.+)$/m);
      assert.ok(outcome, stdout);
      return JSON.parse(outcome[1]);
    },
  };
}

test('installed Hermes admits synthetic QQ and WeChat, persists pairing and dates, and replays saved steps', {
  skip: !python && 'Set STH_TEST_HERMES_PYTHON to the installed Hermes interpreter', timeout: 120_000,
}, async t => {
  const f = await setupService(t);
  const project = await f.invoke('project.create', 'new-project', { title: 'Fixture project' });
  await f.invoke('character.create', 'new-character', { name: '林岚', persona: '网页保存的人设', projectId: project.projectId });
  const { home, run } = await hermesProfile(f);
  const first = await run('first', { code: await f.code() });
  assert.equal(first.write.replayed, false);
  const { result: diary } = first.write;
  assert.equal(diary.projectId, project.projectId);
  assert.equal(diary.href, `/diaries/${diary.noteId}`);
  const storage = join(home, 'sth-personal-operations');
  const files = await readdir(storage);
  assert.equal(files.filter(file => file.endsWith('.binding')).length, 1);
  assert.equal(files.filter(file => file.endsWith('.date')).length, 1);
  assert.equal(f.calls.filter(call => call.action === 'claim').length, 1);
  const restart = await run('restart', { portal: 'https://portal.example.test' });
  assert.deepEqual(restart.write, { ...first.write, replayed: true, result: { ...diary, portalUrl: `https://portal.example.test${diary.href}` } });
  assert.equal(f.diaryCount(), 1);
  const webBody = '在网页修改过的正文。';
  await f.invoke('diary.revise', 'web-edit', { noteId: diary.noteId, title: diary.title, diaryDate: diary.diaryDate,
    body: webBody, expectedRevision: diary.revision });
  await run('wechat', { code: await f.code(), noteId: diary.noteId, webBody });
  const qq = (await f.connections()).find(item => item.clientName === 'Sth Hermes QQ');
  await f.revoke(qq.connectionId);
  await run('revoked');
  const multiple = await run('multiple', { code: await f.code() });
  assert.equal(multiple.writes.length, 2);
  assert.equal(f.diaryCount(), 3);
  assert.ok(f.calls.some(call => call.action === 'receipt' && call.status === 200));
  assert.ok(f.calls.every(call => call.method === 'POST' && call.bearer === (call.action !== 'claim')));
});
