import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';

// Called by accept-research.py host-continuity after a real Hermes diary write.
const [origin, directory, noteId] = process.argv.slice(2);
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.match(noteId, /^[0-9a-f-]{36}$/);
const root = resolve(import.meta.dirname, '..');
const adapter = join(root, 'adapters/mcp/cli.mjs');
const api = async (path, input) => {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, path);
  return response.json();
};

const first = (await api('/api/web/invoke', { operationId: 'diary.read', input: { noteId }, stepId: randomUUID() })).result;
assert.equal(first.revision, 1);
const revised = `我把最后一班船的到站时间记在票背面。${randomUUID().slice(0, 8)}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(origin + first.href);
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  const body = page.getByRole('textbox', { name: '正文', exact: true });
  assert.equal(await body.inputValue(), first.body);
  await body.fill(revised);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('article').getByText(revised, { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('article').getByText(revised, { exact: true }).waitFor();
  await page.screenshot({ path: join(directory, 'mobile-revision.png') });
} finally {
  await browser.close();
}

const { code } = await api('/api/web/connections/code', {});
const paired = spawnSync(process.execPath, [adapter, 'pair', join(directory, 'codex-binding')], {
  input: `${code}\n`, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, STH_PERSONAL_OPERATIONS_ORIGIN: origin },
});
assert.equal(paired.status, 0, 'Codex pairing failed');
const file = join(directory, 'codex-binding/personal-connection.json');
const { connectionId } = JSON.parse(await readFile(file, 'utf8'));
try {
  const cwd = join(directory, 'codex-workspace');
  await mkdir(cwd);
  // On Windows the npm installation uses a .cmd shim. Run the same CLI without a shell.
  const shim = process.platform === 'win32' && process.env.PATH.split(delimiter)
    .map(path => join(path, 'node_modules/@openai/codex/bin/codex.js')).find(existsSync);
  const command = process.env.STH_ACCEPT_CODEX_BIN || (shim ? process.execPath : 'codex');
  const args = shim && !process.env.STH_ACCEPT_CODEX_BIN ? [shim] : [];
  const last = join(directory, 'codex-reply.txt');
  args.push('exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-C', cwd, '-c', `mcp_servers.sth.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.sth.args=${JSON.stringify([adapter, 'stdio', file])}`,
    '-c', 'mcp_servers.sth.tools.sth_personal_discover.approval_mode="approve"',
    '-c', 'mcp_servers.sth.tools.sth_personal_invoke.approval_mode="approve"', '--json', '-o', last, '-');
  const prompt = `通过 sth MCP 工具读我的日记 ${noteId}。分别按版本读取第 1 版，并省略版本字段读取最新版本。`
    + '按顺序逐字输出两版的正文和版本号。只使用 Sth 工具读取。';
  const child = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true,
    timeout: 210_000, input: prompt, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(join(directory, 'codex-events.jsonl'), child.stdout ?? '', { mode: 0o600 });
  await writeFile(join(directory, 'codex-stderr.log'), child.stderr ?? '', { mode: 0o600 });
  assert.equal(child.status, 0, `Codex exited ${child.status ?? child.error?.code}. See private evidence directory.`);
  const reply = await readFile(last, 'utf8');
  assert.ok(reply.includes(first.body) && reply.includes(revised), 'Codex must return both unseen bodies verbatim');
  const db = new DatabaseSync(join(directory, 'sth-data/sth.sqlite'), { readOnly: true });
  try {
    const receipts = db.prepare(`SELECT step_id, result_json, operation_id FROM operation_receipts
      WHERE namespace = ?`).all(`connection:${connectionId}`);
    assert.ok(receipts.every(row => row.operation_id === 'diary.read'), 'This Codex task requested only diary reads');
    const reads = receipts.map(row => ({ stepId: row.step_id, diary: JSON.parse(row.result_json) }));
    for (const [revision, body] of [[1, first.body], [2, revised]]) {
      assert.ok(reads.some(r => r.diary.noteId === noteId && r.diary.revision === revision && r.diary.body === body));
    }
    const events = child.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const inputs = events.map(event => event.item).filter(item => item?.type === 'mcp_tool_call'
      && item.status === 'completed' && item.server === 'sth' && item.tool === 'sth_personal_invoke'
      && item.arguments?.operationId === 'diary.read').map(item => item.arguments.input);
    assert.ok(inputs.some(input => input.noteId === noteId && input.revision === 1));
    assert.ok(inputs.some(input => input.noteId === noteId && !Object.hasOwn(input, 'revision')));
    await writeFile(join(directory, 'continuity.json'), JSON.stringify({ noteId, connectionId, mobileWidth: 390,
      readSteps: reads.map(r => ({ stepId: r.stepId, revision: r.diary.revision })) }, null, 2));
  } finally {
    db.close();
  }
} finally {
  try { await api(`/api/web/connections/${connectionId}/revoke`, {}); }
  finally { await unlink(file); }
}
