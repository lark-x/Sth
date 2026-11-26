import assert from 'node:assert/strict';
import test from 'node:test';
import { openBrowser } from '../browser/harness.mjs';
import { modelSkip, openMagpie, openWorkspace, runChat } from './workspace.test.mjs';

// Opt in with STH_TEST_MAGPIE=1. This HTTP tool shim uses no Hermes profile.
test('configured Magpie discovers and saves one standalone diary for Web readback', {
  skip: modelSkip, timeout: 180_000,
}, async t => {
  const complete = await openMagpie(t);
  const workspace = await openWorkspace(t);
  const { origin, invoke: webInvoke } = workspace;
  const token = await workspace.pair();
  assert.deepEqual((await webInvoke('project.list', {})).items, []);
  assert.deepEqual((await webInvoke('diary.list', { limit: 2 })).items, []);
  t.diagnostic('Fresh Sth service paired with zero projects and zero diaries');

  const diaryDate = '2026-11-23';
  const title = 'The Quiet Bench';
  const { calls } = await runChat(t, workspace, complete, token,
    `Save exactly one personal diary for ${diaryDate} titled "${title}". ` +
    'Write two short first-person sentences about sitting in a quiet park after rain. The workspace has zero projects. ' +
    'Leave the diary unassigned, with no project or character. Confirm after the save tool reports success.',
    { writes: ['diary.create'], maxTurns: 8 });
  const { result: saved, input } = calls.find(call => call.id === 'diary.create');
  assert.equal(input.title, title);
  assert.equal(input.diaryDate, diaryDate);
  assert.equal(input.projectId, undefined);
  assert.equal(input.characterId, undefined);
  assert.ok(saved.body.trim());
  assert.equal(saved.projectId, undefined);
  assert.equal(saved.characterId, undefined);
  assert.equal(saved.href, `/diaries/${saved.noteId}`);
  assert.deepEqual((await webInvoke('project.list', {})).items, []);
  assert.deepEqual((await webInvoke('diary.list', { limit: 2 })).items, [saved]);
  assert.deepEqual(await webInvoke('diary.read', { noteId: saved.noteId }), saved);
  t.diagnostic('Web list and detail returned the same single diary with zero projects');

  const page = await openBrowser(t, origin, { width: 1000, height: 800 });
  await page.goto('/');
  const entry = page.locator(`a[href="${saved.href}"]`);
  await entry.waitFor();
  assert.equal(await entry.count(), 1);
  await entry.click();
  await page.getByRole('heading', { level: 1, name: saved.title, exact: true }).waitFor();
  await page.getByRole('article').getByText(saved.body, { exact: true }).waitFor();
  assert.equal(await page.getByRole('main').locator('time').getAttribute('datetime'), diaryDate);
  t.diagnostic('Chromium opened the diary from the Web list and rendered its title, date, and body');
});
