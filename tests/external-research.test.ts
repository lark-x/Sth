import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Operations, operationsDDL } from '../src/core/index.ts';
import { libraryDDL, libraryOperations } from '../src/library/index.ts';
import { createAkashaProvider, createExternalOperations, createExternalProviders, createMediaWikiProvider,
  externalDDL, startExternalWorker, type ExternalJob, type ExternalProvider } from '../src/sources/external.ts';
import { sourceOperations, sourcesDDL } from '../src/sources/index.ts';
import type { ExternalDocument, ExternalSearchResult } from '../src/sources/external-contracts.ts';

type Archive = { provider: string; docId: string; sourceId: string; revision: number; href: string; projectIds: string[]; start?: number; end?: number };
type ReadPage = { documents: (ExternalDocument & { offset: number; nextOffset?: number; totalChars: number })[]; nextCursor?: string };
const title = '故宫原文';
const excerpt = '重复原句';
const wikiText = '甲'.repeat(23_999) + `𠮷\n\n== 历史 ==\n${excerpt}\n${excerpt}\n`;
const publicUrl = 'https://example.test/wiki/Palace';

function open(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000');
  db.exec(operationsDDL + libraryDDL + sourcesDDL + externalDDL);
  return db;
}

function operations(db: DatabaseSync, providers: ExternalProvider[], namespace = 'web') {
  const projectCreate = libraryOperations.find(operation => operation.id === 'project.create');
  const sourceRead = sourceOperations.find(operation => operation.id === 'source.read');
  assert(projectCreate && sourceRead);
  const core = new Operations(db, [projectCreate, sourceRead, ...createExternalOperations(providers)]);
  let step = 0;
  return <T = ExternalJob>(operationId: string, input: object = {}, stepId = `${++step}`) =>
    core.invoke(namespace, { operationId, input, stepId }).result as T;
}

function start(db: DatabaseSync, providers: ExternalProvider[]) {
  return startExternalWorker(db, { providers, pollIntervalMs: 5, requestTimeoutMs: 2000, leaseMs: 3000 });
}

async function until<T>(find: () => T | undefined): Promise<T> {
  for (let i = 0; i < 250; i++) {
    const value = find();
    if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error('Timed out waiting for the research worker.');
}

async function settled(run: ReturnType<typeof operations>, jobId: string) {
  return until(() => {
    const job = run('external.get', { jobId });
    return job.status === 'succeeded' || job.status === 'failed' ? job : undefined;
  });
}

async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const failures: unknown[] = [];
  const server = createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(error => {
      failures.push(error);
      res.destroy();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.deepEqual(failures, []);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function json(res: ServerResponse, body: object) {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

test('MediaWiki queues outside network, pages exact text, and archives chosen occurrences into the library', async t => {
  const db = open();
  const requests: URLSearchParams[] = [];
  const url = await fixture(t, (req, res) => {
    assert.equal(db.isTransaction, false);
    assert.equal(req.headers['user-agent'], 'Sth integration test');
    const params = new URL(req.url!, 'http://local').searchParams;
    requests.push(params);
    assert.equal(params.get('explaintext'), '1');
    const first = { pageid: 43, index: 1, title, fullurl: publicUrl, lastrevid: 123 };
    const second = { ...first, pageid: 44, index: 2, title: '第二个命中' };
    if (params.get('pageids')) {
      assert.equal(params.has('exintro'), false);
      assert.equal(params.get('exsectionformat'), 'wiki');
      return json(res, { query: { pages: [{ ...first, extract: wikiText }] } });
    }
    assert.equal(params.get('gsrsearch'), '故宫');
    assert.equal(params.get('exintro'), '1');
    if (params.has('gsroffset')) return json(res, { query: { pages: [second] } });
    return json(res, { continue: { gsroffset: 2 }, query: { pages: [second, { ...first, extract: '原文导言' }] } });
  });
  const providers = [createMediaWikiProvider({ apiUrl: `${url}/api.php`, provider: 'testwiki', userAgent: 'Sth integration test' })];
  const run = operations(db, providers);
  const search = run('external.search', { query: '故宫', limit: 2 }, 'enqueue');
  assert.equal(search.status, 'queued');
  assert.equal(run('external.search', { query: '故宫', limit: 2 }, 'enqueue').jobId, search.jobId);
  assert.equal(requests.length, 0);
  const worker = start(db, providers);
  t.after(async () => { await worker.stop(); db.close(); });

  const found = (await settled(run, search.jobId)).result as ExternalSearchResult;
  assert.deepEqual(found.items.map(item => item.docId), ['43', '44']);
  assert.equal(found.items[0].snippet, '原文导言');
  const nextSearch = run('external.search', { query: '故宫', cursor: found.nextCursor });
  assert.deepEqual(((await settled(run, nextSearch.jobId)).result as ExternalSearchResult).items.map(item => item.docId), ['44']);
  assert.equal(requests[1].get('gsroffset'), '2');
  const { jobId } = run('external.read', { provider: 'testwiki', docId: '43' });
  assert.throws(() => run('external.archive', { jobId, docId: '43' }), { code: 'external_read_required' });
  const [first] = ((await settled(run, jobId)).result as ReadPage).documents;
  const [second] = (run('external.get', { jobId, docId: '43', offset: first.nextOffset }).result as ReadPage).documents;
  assert.equal(first.nextOffset, 23999);
  assert.equal(second.body[0], wikiText.charAt(23999));
  assert.equal(first.body + second.body, wikiText);
  assert.equal(first.upstreamRevision, '123');
  assert.throws(() => run('external.get', { jobId, docId: '43', offset: 24000 }), { code: 'external_invalid_offset' });
  assert.throws(() => run('external.archive', { jobId, docId: '43', excerpt }), { code: 'external_excerpt_ambiguous' });
  assert.throws(() => run('external.archive', { jobId, docId: '43', excerpt: '伪造原文' }), { code: 'external_excerpt_mismatch' });
  const firstStart = wikiText.indexOf(excerpt);
  const secondStart = wikiText.lastIndexOf(excerpt);
  const range = (start: number) => ({ jobId, docId: '43', start, end: start + excerpt.length, excerpt });
  const saved = run<Archive>('external.archive', range(secondStart));
  assert.equal(saved.start, secondStart);
  assert.notEqual(run<Archive>('external.archive', range(firstStart)).sourceId, saved.sourceId);
  assert.deepEqual(run<Archive>('external.archive', range(secondStart)), saved);
  const savedText = run<{ body: string; origin: string }>('source.read', { sourceId: saved.sourceId, revision: saved.revision });
  assert.deepEqual([savedText.body, savedText.origin], [excerpt, `${publicUrl} · revision 123`]);
});

test('Akasha Streamable HTTP preserves neighboring chunks and shares archive identity with assistant import', async t => {
  const primary = { chunkId: 44, cite: '《角色故事》', excerpt: '\n【原文】  保留空白。\n' };
  const neighbor = { chunkId: 45, cite: '《角色故事》', excerpt: '后续上下文。' };
  const toolCalls: { name: string; arguments: object }[] = [];
  const url = await fixture(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-local');
    if (req.method === 'DELETE') {
      assert.equal(req.headers['mcp-session-id'], 'local-session');
      res.writeHead(204).end();
      return;
    }
    let text = '';
    for await (const part of req) text += part;
    const message = JSON.parse(text);
    if (message.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'local-session');
      return json(res, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26' } });
    }
    assert.equal(req.headers['mcp-session-id'], 'local-session');
    assert.equal(req.headers['mcp-protocol-version'], '2025-03-26');
    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    toolCalls.push(message.params);
    const result = message.params.name === 'searchAkasha' ? { results: [primary] }
      : message.params.arguments.offset !== undefined ? { results: [neighbor], pagination: {} }
      : { results: [primary, neighbor], pagination: { nextOffset: 3 } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keepalive\r\n\r\n');
    const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    res.write(`data: ${reply.slice(0, 18)}`);
    res.end(`${reply.slice(18)}\r\n\r\n`);
  });
  const db = open();
  const providers = [createAkashaProvider({ url, authorization: 'Bearer test-local' })];
  const run = operations(db, providers);
  const worker = start(db, providers);
  t.after(async () => { await worker.stop(); db.close(); });
  const found = await settled(run, run('external.search', { query: '温妮莎', limit: 2 }).jobId);
  assert.equal((found.result as ExternalSearchResult).items[0].docId, '44');
  const { jobId } = run('external.read', { provider: 'akasha', docId: '44' });
  const result = (await settled(run, jobId)).result as ReadPage;
  assert.deepEqual(result.documents.map(document => document.body), [primary.excerpt, neighbor.excerpt]);
  const continued = run('external.read', { provider: 'akasha', docId: '44', cursor: result.nextCursor });
  assert.deepEqual(((await settled(run, continued.jobId)).result as ReadPage).documents.map(document => document.docId), ['45']);
  assert.deepEqual(toolCalls.map(message => message.arguments), [
    { query: '温妮莎', topK: 2 }, { chunkId: 44, scope: 'source', limit: 3 }, { chunkId: 44, scope: 'source', limit: 3, offset: 3 },
  ]);
  const archive = run<Archive>('external.archive', { jobId, docId: '44' });
  const input = { provider: 'akasha', docId: '44', title: primary.cite, origin: primary.cite, body: primary.excerpt };
  const assistant = operations(db, [], 'assistant');
  assert.deepEqual(assistant<Archive>('external.import', input), archive);
  const { projectId } = run<{ projectId: string }>('project.create', { title: '蒙德故事' });
  const attached = assistant<Archive>('external.import', { ...input, projectIds: [projectId] });
  assert.equal(attached.sourceId, archive.sourceId);
  assert.equal(attached.revision, 2);
  assert.deepEqual(attached.projectIds, [projectId]);
  assert.deepEqual(assistant<Archive>('external.import', input), attached);
  const changed = assistant<Archive>('external.import', { ...input, body: '另一个版本的原文。' });
  assert.equal(changed.sourceId, archive.sourceId);
  assert.equal(changed.revision, 3);
  assert.deepEqual(assistant<Archive>('external.import', input), attached);
  assert.equal(run<{ body: string }>('source.read', { sourceId: archive.sourceId, revision: 1 }).body, primary.excerpt);
  assert.equal(toolCalls.length, 3);
});

test('socket failure survives database reopen and retry uses the original job while saved text stays readable offline', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sth-external-'));
  const path = join(directory, 'research.sqlite');
  let db = open(path);
  let worker: ReturnType<typeof start> | undefined;
  t.after(async () => { await worker?.stop(); db.close(); rmSync(directory, { recursive: true }); });
  let offline = true;
  const url = await fixture(t, (req, res) => {
    if (offline) { req.socket.destroy(); return; }
    json(res, { query: { pages: [{ pageid: 43, title, fullurl: publicUrl, extract: '断线重试成功的原文。' }] } });
  });
  const providers = [createMediaWikiProvider({ apiUrl: url, provider: 'testwiki' })];
  let run = operations(db, providers, 'before');
  const { jobId } = run('external.read', { provider: 'testwiki', docId: '43' });
  worker = start(db, providers);
  const failed = await settled(run, jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'external_provider_unreachable');
  assert.equal(failed.error?.retryable, true);
  assert.equal(failed.attempts, 1);
  await worker.stop();
  db.close();
  db = open(path);
  run = operations(db, providers, 'after');
  assert.deepEqual(run<{ items: ExternalJob[] }>('external.list').items, [failed]);
  assert.equal(run('external.retry', { jobId }).status, 'queued');
  assert.equal(run('external.retry', { jobId }).attempts, 1);
  offline = false;
  worker = start(db, providers);
  const success = await settled(run, jobId);
  assert.equal(success.status, 'succeeded');
  assert.equal(success.attempts, 2);
  await worker.stop();
  offline = true;
  const [cached] = (run('external.get', { jobId }).result as ReadPage).documents;
  const source = run<Archive>('external.archive', { jobId, docId: '43' });
  assert.equal(run<{ body: string }>('source.read', { sourceId: source.sourceId }).body, cached.body);
  assert.throws(() => run('external.retry', { jobId }), { code: 'external_job_not_retryable' });
});

test('an expired lease is reclaimed by a second connection and a late reply cannot overwrite the result', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sth-research-lease-'));
  const path = join(dir, 'research.sqlite');
  const db = open(path);
  const replacement = open(path);
  let resolveOldReply!: (result: ExternalSearchResult) => void;
  const oldReply = new Promise<ExternalSearchResult>(resolve => { resolveOldReply = resolve; });
  const hit = { provider: 'testwiki', docId: '1', title, origin: publicUrl };
  const first: ExternalProvider = {
    provider: 'testwiki', kind: 'mediawiki', label: 'Wiki',
    async search() { assert.equal(db.isTransaction, false); return oldReply; },
    async read() { throw new Error('Unexpected read'); },
  };
  const second: ExternalProvider = {
    ...first,
    async search() { assert.equal(replacement.isTransaction, false); return { items: [{ ...hit, title: '新结果' }] }; },
  };
  const run = operations(db, [first]);
  const firstWorker = start(db, [first]);
  let secondWorker: ReturnType<typeof start> | undefined;
  t.after(async () => {
    await firstWorker.stop(); await secondWorker?.stop();
    db.close(); replacement.close(); rmSync(dir, { recursive: true });
  });
  const { jobId } = run('external.search', { query: '故宫' });
  await until(() => run('external.get', { jobId }).status === 'running' ? true : undefined);
  replacement.prepare('UPDATE external_research_jobs SET lease_until = 0 WHERE job_id = ?').run(jobId);
  secondWorker = start(replacement, [second]);
  const saved = await settled(run, jobId);
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.attempts, 2);
  resolveOldReply({ items: [{ ...hit, title: '旧结果' }] });
  await delay(30);
  assert.deepEqual(run('external.get', { jobId }), saved);
});

test('worker shutdown requeues a running job and a stalled attempt produces a retryable timeout', async t => {
  const db = open();
  let calls = 0;
  const provider: ExternalProvider = {
    provider: 'testwiki', kind: 'mediawiki', label: 'Wiki',
    async search() {
      assert.equal(db.isTransaction, false);
      if (++calls <= 2) return new Promise(() => {});
      return { items: [] };
    },
    async read() { throw new Error('Unexpected read'); },
  };
  const run = operations(db, [provider]);
  const { jobId } = run('external.search', { query: '故宫' });
  let worker = start(db, [provider]);
  t.after(async () => { await worker.stop(); db.close(); });
  await until(() => calls === 1 ? true : undefined);
  await worker.stop();
  assert.equal(run('external.get', { jobId }).status, 'queued');
  worker = startExternalWorker(db, { providers: [provider], requestTimeoutMs: 30, leaseMs: 1000, pollIntervalMs: 5 });
  const timedOut = await settled(run, jobId);
  assert.equal(timedOut.attempts, 2);
  assert.deepEqual(timedOut.error, { code: 'external_timeout', message: 'The provider request timed out.', retryable: true });
  assert.equal(run('external.retry', { jobId }).status, 'queued');
  const succeeded = await settled(run, jobId);
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.attempts, 3);
});

test('provider configuration prefers Akasha and validates distinct wiki identities', () => {
  const providers = createExternalProviders({ STH_RESEARCH_AKASHA_URL: 'http://localhost/mcp' });
  assert.deepEqual(providers.map(item => item.provider), ['akasha', 'wikipedia-zh']);
  assert.deepEqual(createExternalProviders({ STH_RESEARCH_MEDIAWIKI_URL: 'off' }), []);
  assert.throws(() => createExternalProviders({ STH_RESEARCH_MEDIAWIKI_URL: 'http://localhost/wiki' }), /distinct/);
});
