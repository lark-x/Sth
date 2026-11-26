import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createMediaProviderFromEnv, getMediaProviderStatus, readMediaBinary, readMediaMetadata, startJobsWorker } from '../src/jobs/index.ts';
import { fixture, waitFor, type Job } from './jobs-fixture.ts';

test('generates one PNG through the opted-in ComfyUI provider and restores its bytes from SQLite backup', {
  skip: process.env.STH_TEST_COMFY !== '1', timeout: 240_000,
}, async t => {
  const provider = createMediaProviderFromEnv();
  assert.ok(provider, 'configure the isolated test provider');
  assert.equal((await getMediaProviderStatus(provider)).status, 'ready');
  const { db, directory, file, invoke, projectId, makeCompositions, select, readJob } = fixture(t);
  const [example] = makeCompositions([
    'Wide establishing shot, a quiet northern harbor at dusk, a brass lantern at the end of a blue dock, distant ferry, hand-painted storybook illustration, warm light and indigo water',
  ]);
  select(example.selection);
  const { jobId } = invoke<Job>('jobs.create', { projectId, title: 'Live ComfyUI verification', items: [example.selection] });
  const worker = startJobsWorker(db, { provider, pollIntervalMs: 750 });
  try {
    const job = await waitFor(() => readJob(jobId), job => ['succeeded', 'failed', 'unknown'].includes(job.items[0].status), 210_000);
    const item = job.items[0];
    assert.equal(item.status, 'succeeded', item.attempt?.message);
    assert.ok(item.mediaId && item.attempt?.providerJobId);
    const metadata = invoke<ReturnType<typeof readMediaMetadata>>('media.read', { mediaId: item.mediaId });
    const binary = readMediaBinary(db, item.mediaId);
    assert.equal(metadata.scene.sceneId, example.input.sceneId);
    assert.equal(metadata.scene.revision, example.input.sceneRevision);
    assert.equal(metadata.projectId, projectId);
    assert.equal(metadata.contentType, 'image/png');
    assert.equal(metadata.byteLength, binary.byteLength);
    assert.ok(metadata.width > 0 && metadata.height > 0);
    assert.equal(createHash('sha256').update(binary.bytes).digest('hex'), metadata.sha256);
    assert.equal(Buffer.from(binary.bytes.subarray(0, 8)).toString('hex'), '89504e470d0a1a0a');
    const snapshot = join(directory, 'backup.sqlite');
    // The worker can open write transactions on db while SQLite copies the snapshot.
    using source = new DatabaseSync(file, { readOnly: true });
    const backupPages = await backup(source, snapshot, { rate: -1 });
    using restored = new DatabaseSync(snapshot, { readOnly: true });
    assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(restored.prepare('PRAGMA page_count').get()?.page_count, backupPages);
    assert.deepEqual(readMediaMetadata(restored, item.mediaId), metadata);
    assert.deepEqual(readMediaBinary(restored, item.mediaId), binary);
    t.diagnostic(JSON.stringify({ jobId, sceneId: metadata.scene.sceneId, sceneRevision: metadata.scene.revision,
      mediaId: item.mediaId, providerJobId: item.attempt.providerJobId, width: metadata.width, height: metadata.height,
      bytes: binary.byteLength, sha256: metadata.sha256, backupPages }));
  } finally {
    await worker.stop();
  }
});
