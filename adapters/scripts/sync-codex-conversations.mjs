#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MAX_SOURCE_BODY = 100_000;
const CHUNK_SOURCE_BODY = 82_000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const HISTORY_DATABASE_PREFIX = 'thread_history_';
const THREAD_DATABASE_PREFIX = 'state_';

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function options() {
  const { values } = parseArgs({
    options: {
      binding: { type: 'string' },
      cwd: { type: 'string' },
      'project-title': { type: 'string', default: 'MyGame' },
      state: { type: 'string' },
      log: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const cwd = resolve(required(values.cwd, '--cwd'));
  const projectTitle = required(values['project-title'], '--project-title');
  const base = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SthCodexSync');
  const slug = projectTitle.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  return {
    binding: resolve(required(values.binding, '--binding')),
    cwd,
    projectTitle,
    state: resolve(values.state || join(base, `${slug}.json`)),
    log: resolve(values.log || join(base, `${slug}.log`)),
    dryRun: values['dry-run'],
  };
}

function normalizeCwd(value) {
  return value.replaceAll('/', '\\').toLocaleLowerCase('en-US');
}

function cwdVariants(value) {
  const normalized = normalizeCwd(value);
  return [...new Set([normalized, `\\\\?\\${normalized.replace(/^\\\\\?\\/, '')}`])];
}

function isoFromSeconds(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

function localTimestamp(seconds) {
  if (!Number.isFinite(seconds)) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000));
}

function compactTitle(value, length) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  return [...compact].slice(0, length).join('');
}

function threadModel(thread) {
  if (!thread.model) return '未知';
  return thread.effort ? `${thread.model} · ${thread.effort}` : thread.model;
}

function originMetadata(source) {
  if (!source) return {};
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function userMessageText(item) {
  if (!Array.isArray(item.content)) return '';
  return item.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
}

async function latestDatabase(codexHome, prefix, table) {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\\.sqlite$`);
  const candidates = (await readdir(codexHome))
    .map(name => ({ name, version: Number(name.match(pattern)?.[1]) }))
    .filter(item => Number.isSafeInteger(item.version))
    .sort((left, right) => right.version - left.version);
  for (const candidate of candidates) {
    const path = join(codexHome, candidate.name);
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
      db.close();
      if (exists) return path;
    } catch {
      // A newer database may be mid-migration. Try the next complete version.
    }
  }
  throw new Error(`Could not find a local Codex ${prefix}N.sqlite database containing ${table}.`);
}

async function readThreads(codexHome, cwd) {
  const threadPath = await latestDatabase(codexHome, THREAD_DATABASE_PREFIX, 'threads');
  const historyPath = await latestDatabase(codexHome, HISTORY_DATABASE_PREFIX, 'thread_items');
  const threadsDb = new DatabaseSync(threadPath, { readOnly: true });
  const historyDb = new DatabaseSync(historyPath, { readOnly: true });
  try {
    const variants = cwdVariants(cwd);
    const threads = threadsDb.prepare(`
      SELECT id, title, created_at, updated_at, source, model, reasoning_effort, cwd
      FROM threads
      WHERE lower(replace(cwd, '/', '\\')) IN (?, ?)
      ORDER BY created_at, id
    `).all(variants[0], variants[1]);
    return threads.map(thread => {
      const rows = historyDb.prepare(`
        SELECT item_type, item_json
        FROM thread_items
        WHERE thread_id = ?
        ORDER BY rollout_ordinal
      `).all(thread.id);
      const messages = [];
      const activity = {};
      for (const row of rows) {
        let item;
        try {
          item = JSON.parse(row.item_json);
        } catch {
          continue;
        }
        if (row.item_type === 'userMessage') {
          const text = userMessageText(item);
          if (text) messages.push({ role: '用户', phase: 'message', text });
        } else if (row.item_type === 'agentMessage') {
          const text = typeof item.text === 'string' ? item.text.trim() : '';
          if (text) {
            messages.push({
              role: 'Codex',
              phase: item.phase === 'commentary' ? '过程说明' : '答复',
              text,
            });
          }
        } else if (row.item_type !== 'reasoning') {
          activity[row.item_type] = (activity[row.item_type] || 0) + 1;
        }
      }
      return {
        ...thread,
        origin: originMetadata(thread.source),
        messages,
        activity,
      };
    });
  } finally {
    historyDb.close();
    threadsDb.close();
  }
}

function sourceBaseTitle(projectTitle, thread) {
  const when = localTimestamp(thread.created_at).replaceAll('/', '-');
  const heading = compactTitle(thread.title || thread.messages[0]?.text || '无可见消息', 150);
  return compactTitle(
    `${projectTitle} · Codex CLI · ${when} · ${thread.id.slice(0, 8)} · ${heading}`,
    270,
  );
}

function transcriptHeader(projectTitle, thread, part, totalParts) {
  const parent = thread.origin?.thread_spawn?.parent_thread_id || thread.origin?.subagent?.thread_spawn?.parent_thread_id;
  return [
    `# ${projectTitle} · Codex CLI 会话${totalParts > 1 ? ` · 第 ${part} / ${totalParts} 部分` : ''}`,
    '',
    `- 会话 ID: ${thread.id}`,
    `- 标题: ${compactTitle(thread.title || '（无标题）', 300)}`,
    `- 创建时间: ${isoFromSeconds(thread.created_at) || '未知'}`,
    `- 最后更新: ${isoFromSeconds(thread.updated_at) || '未知'}`,
    `- 模型: ${threadModel(thread)}`,
    `- 工作目录: ${thread.cwd}`,
    `- 来源类型: ${typeof thread.source === 'string' && thread.source.startsWith('{') ? '子智能体' : thread.source || '未知'}`,
    ...(parent ? [`- 父会话 ID: ${parent}`] : []),
    `- 可见消息: ${thread.messages.length}`,
    '',
    '## 对话',
    '',
  ].join('\n');
}

function splitOversizedText(text, limit) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.6) cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function transcriptSections(thread) {
  if (thread.messages.length === 0) {
    return ['> 这个会话目前没有可见的用户或 Codex 文本消息。\n\n'];
  }
  const sections = [];
  for (const message of thread.messages) {
    const label = message.role === 'Codex' ? `Codex · ${message.phase}` : message.role;
    for (const [index, text] of splitOversizedText(message.text, CHUNK_SOURCE_BODY - 500).entries()) {
      const continuation = index === 0 ? '' : `（续 ${index + 1}）`;
      sections.push(`### ${label}${continuation}\n\n${text}\n\n`);
    }
  }
  return sections;
}

function transcriptParts(projectTitle, thread) {
  const sections = transcriptSections(thread);
  const packed = [];
  let current = '';
  for (const section of sections) {
    if (current && current.length + section.length > CHUNK_SOURCE_BODY) {
      packed.push(current);
      current = '';
    }
    current += section;
  }
  if (current) packed.push(current);
  const totalParts = Math.max(1, packed.length);
  const activity = Object.entries(thread.activity)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `- ${kind}: ${count}`)
    .join('\n') || '- 无';
  return packed.map((sectionsText, index) => {
    const body = [
      transcriptHeader(projectTitle, thread, index + 1, totalParts),
      sectionsText,
      '## 工具活动摘要',
      '',
      activity,
      '',
      '> 本存档收录 Codex 界面中的用户与助手消息，以及工具类型计数。隐藏推理、工具参数、命令正文和命令输出不写入正文。',
    ].join('\n');
    if (body.length > MAX_SOURCE_BODY) throw new Error(`Transcript chunk ${thread.id}/${index + 1} is too large.`);
    return {
      title: compactTitle(
        `${sourceBaseTitle(projectTitle, thread)}${totalParts > 1 ? ` · 第 ${index + 1} / ${totalParts} 部分` : ''}`,
        300,
      ),
      body,
      origin: `Codex CLI local history · thread=${thread.id} · cwd=${thread.cwd}`,
    };
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceDigest(input) {
  return digest(JSON.stringify({
    kind: input.kind,
    title: input.title,
    body: input.body,
    origin: input.origin,
    projectIds: input.projectIds,
  }));
}

function compactSource(value) {
  if (!value?.sourceId) return value;
  return {
    sourceId: value.sourceId,
    revision: value.revision,
    href: value.href,
    hash: value.hash,
  };
}

function stableStepPart(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Could not read sync state ${path}: ${error.message}`);
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return async () => {
      await handle.close();
      await unlink(path).catch(() => {});
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await stat(path).catch(() => undefined);
    if (!info || Date.now() - info.mtimeMs < LOCK_STALE_MS) {
      throw new Error(`Another sync is still running (${path}).`);
    }
    await unlink(path);
    return acquireLock(path);
  }
}

async function appendLog(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function createMcp(binding) {
  const cli = resolve(import.meta.dirname, '..', 'mcp', 'cli.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'stdio', binding],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'sth-codex-conversation-sync', version: '1.0.0' });
  return { client, transport };
}

async function callTool(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue });
  if (result.isError) {
    const text = Array.isArray(result.content)
      ? result.content.map(item => item.type === 'text' ? item.text : '').join('\n')
      : 'MCP tool failed.';
    throw new Error(text);
  }
  if (!result.structuredContent) throw new Error(`${name} returned no structured content.`);
  return result.structuredContent;
}

async function invoke(client, operationId, stepId, input) {
  const envelope = await callTool(client, 'sth_personal_invoke', { operationId, stepId, input });
  return envelope.result;
}

async function listProjects(client, runId) {
  const items = [];
  for (let offset = 0; ; offset += 50) {
    const page = await invoke(client, 'project.list', `${runId}-project-list-${offset}`, { limit: 50, offset });
    items.push(...page.items);
    if (page.items.length < 50) return items;
  }
}

async function resolveProject(client, state, optionsValue, runId) {
  const projects = await listProjects(client, runId);
  let project = projects.find(item => item.title === optionsValue.projectTitle);
  if (!project) {
    if (optionsValue.dryRun) return undefined;
    project = await invoke(
      client,
      'project.create',
      `mygame-${stableStepPart(optionsValue.projectTitle)}-project-create-v1`,
      { title: optionsValue.projectTitle },
    );
  }
  if (state.projectId && state.projectId !== project.projectId) {
    throw new Error(`State belongs to project ${state.projectId}, but ${optionsValue.projectTitle} is ${project.projectId}.`);
  }
  state.projectId = project.projectId;
  return project;
}

async function latestSource(client, sourceId, runId) {
  try {
    return await invoke(client, 'source.read', `${runId}-source-read-${sourceId.slice(0, 20)}`, { sourceId });
  } catch {
    return undefined;
  }
}

async function upsertSource(client, state, key, input, optionsValue, runId) {
  const contentHash = sourceDigest(input);
  const previous = state.sources[key];
  if (previous?.hash === contentHash) return { result: previous, status: 'unchanged' };
  if (optionsValue.dryRun) {
    return {
      result: { sourceId: previous?.sourceId, revision: previous?.revision, href: previous?.href },
      status: previous ? 'update' : 'create',
    };
  }
  if (!previous) {
    const result = await invoke(
      client,
      'source.create',
      `codex-sync-${stableStepPart(key)}-create-${contentHash.slice(0, 20)}`,
      input,
    );
    state.sources[key] = compactSource({ ...result, hash: contentHash });
    return { result, status: 'create' };
  }
  let result;
  try {
    result = await invoke(
      client,
      'source.revise',
      `codex-sync-${stableStepPart(key)}-revise-${contentHash.slice(0, 20)}`,
      { sourceId: previous.sourceId, expectedRevision: previous.revision, ...input },
    );
  } catch (error) {
    const current = await latestSource(client, previous.sourceId, runId);
    if (!current) throw error;
    const currentDigest = sourceDigest({
      kind: current.kind,
      title: current.title,
      body: current.body,
      origin: current.origin,
      projectIds: current.projectIds,
    });
    if (currentDigest === contentHash) {
      result = current;
    } else {
      result = await invoke(
        client,
        'source.revise',
        `codex-sync-${stableStepPart(key)}-revise-from-${current.revision}-${contentHash.slice(0, 20)}`,
        { sourceId: previous.sourceId, expectedRevision: current.revision, ...input },
      );
    }
  }
  state.sources[key] = compactSource({ ...result, hash: contentHash });
  return { result, status: 'update' };
}

function indexBody(state, threads, projectTitle) {
  const rows = Object.values(state.threads)
    .map(item => {
      const first = item.parts?.[0];
      return {
        id: item.threadId,
        title: compactTitle(item.displayTitle || item.threadId, 100),
        model: item.model || '未知',
        updated: item.updatedAt || '未知',
        messages: item.messageCount || 0,
        href: first?.href || '',
      };
    })
    .sort((left, right) => String(right.updated).localeCompare(String(left.updated)));
  const lines = [
    `# ${projectTitle} · Codex CLI 会话索引`,
    '',
    `- 同步目录: ${state.cwd}`,
    `- 会话数量: ${threads.length}`,
    `- 最后检测到内容变化: ${state.lastChangeAt || '尚未记录'}`,
    '',
    '| 会话 | 模型 | 最后更新 | 可见消息 | 存档 |',
    '| --- | --- | --- | ---: | --- |',
  ];
  for (const row of rows) {
    const label = row.title.replaceAll('|', '\\|');
    lines.push(`| ${label} | ${row.model.replaceAll('|', '\\|')} | ${row.updated} | ${row.messages} | ${row.href ? `[打开](${row.href})` : '已安排'} |`);
  }
  lines.push('', '此索引和分会话正文由本机 Codex 对话数据库经 Sth MCP 增量同步。');
  let body = lines.join('\n');
  while (body.length > MAX_SOURCE_BODY - 2_000 && rows.length > 0) {
    rows.pop();
    body = body.replace(/\|[^\n]*\n(?=此索引)/, '');
  }
  if (body.length > MAX_SOURCE_BODY) body = body.slice(0, MAX_SOURCE_BODY);
  return body;
}

async function sync(optionsValue) {
  const startedAt = new Date();
  const runId = `mygame-codex-${startedAt.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const state = await readJson(optionsValue.state, {
    version: 1,
    projectTitle: optionsValue.projectTitle,
    cwd: optionsValue.cwd,
    sources: {},
    threads: {},
  });
  if (state.projectTitle !== optionsValue.projectTitle || normalizeCwd(state.cwd) !== normalizeCwd(optionsValue.cwd)) {
    throw new Error('The state file belongs to another project directory.');
  }
  for (const [key, value] of Object.entries(state.sources)) {
    state.sources[key] = compactSource(value);
  }
  state.index = compactSource(state.index);
  const threads = await readThreads(codexHome, optionsValue.cwd);
  const { client, transport } = createMcp(optionsValue.binding);
  await client.connect(transport);
  try {
    const project = await resolveProject(client, state, optionsValue, runId);
    const counts = { create: 0, update: 0, unchanged: 0 };
    const threadChanges = [];
    for (const thread of threads) {
      const parts = transcriptParts(optionsValue.projectTitle, thread);
      const previous = state.threads[thread.id] || { parts: [] };
      const nextParts = [];
      let changed = false;
      for (const [index, part] of parts.entries()) {
        const input = {
          kind: 'excerpt',
          title: part.title,
          body: part.body,
          origin: part.origin,
          projectIds: state.projectId ? [state.projectId] : [],
        };
        const key = `${thread.id}:part-${index + 1}`;
        const result = await upsertSource(client, state, key, input, optionsValue, runId);
        counts[result.status]++;
        if (result.status !== 'unchanged') changed = true;
        nextParts.push({
          sourceId: result.result.sourceId,
          revision: result.result.revision,
          href: result.result.href,
          hash: sourceDigest(input),
        });
      }
      const oldPartKeys = (previous.parts || []).map((_, index) => `${thread.id}:part-${index + 1}`);
      const newPartKeys = new Set(parts.map((_, index) => `${thread.id}:part-${index + 1}`));
      for (const oldKey of oldPartKeys) {
        if (!newPartKeys.has(oldKey)) changed = true;
      }
      state.threads[thread.id] = {
        threadId: thread.id,
        displayTitle: compactTitle(thread.title || thread.messages[0]?.text || '无可见消息', 150),
        model: threadModel(thread),
        updatedAt: isoFromSeconds(thread.updated_at),
        messageCount: thread.messages.length,
        parts: nextParts,
      };
      if (changed) threadChanges.push(thread.id);
    }
    if (threadChanges.length > 0) state.lastChangeAt = startedAt.toISOString();
    if (project) {
      const body = indexBody(state, threads, optionsValue.projectTitle);
      const input = {
        kind: 'setting',
        title: `${optionsValue.projectTitle} · Codex CLI 会话索引`,
        body,
        origin: `Codex CLI local history index · cwd=${optionsValue.cwd}`,
        projectIds: [state.projectId],
      };
      const result = await upsertSource(client, state, '__index__', input, optionsValue, runId);
      counts[result.status]++;
      state.index = compactSource({
        sourceId: result.result.sourceId,
        revision: result.result.revision,
        href: result.result.href,
        hash: sourceDigest(input),
      });
    }
    state.syncCount = (state.syncCount || 0) + 1;
    state.lastRunAt = new Date().toISOString();
    state.lastSummary = {
      threads: threads.length,
      changedThreads: threadChanges.length,
      ...counts,
    };
    if (!optionsValue.dryRun) await writeJsonAtomic(optionsValue.state, state);
    return {
      status: optionsValue.dryRun ? 'dry-run' : 'ok',
      projectId: state.projectId,
      threads: threads.length,
      changedThreads: threadChanges.length,
      operations: counts,
      indexSourceId: state.index?.sourceId,
      lastChangeAt: state.lastChangeAt,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const parsed = options();
  const release = await acquireLock(`${parsed.state}.lock`);
  try {
    const result = await sync(parsed);
    await appendLog(parsed.log, { at: new Date().toISOString(), ...result });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await release();
  }
}

main().catch(async error => {
  let parsed;
  try {
    parsed = options();
    await appendLog(parsed.log, { at: new Date().toISOString(), status: 'error', error: error.message });
  } catch {
    // Argument errors still reach stderr below.
  }
  process.stderr.write(`Codex conversation sync failed: ${error.message}\n`);
  process.exitCode = 1;
});
