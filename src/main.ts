import { openDatabase } from './database.ts';
import { createApp } from './server.ts';
import { createMediaProviderFromEnv, startJobsWorker } from './jobs/index.ts';
import { startGenerationWorker } from './generation/index.ts';
import { startExternalWorker } from './sources/external.ts';

const port = Number(process.env.STH_PORT || 9321);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid STH_PORT');
const db = openDatabase();
let media: ReturnType<typeof createMediaProviderFromEnv>;
let invalidMediaConfig = false;
try { media = createMediaProviderFromEnv(); }
catch {
  invalidMediaConfig = true;
  console.error('Sth media configuration is invalid. Check the ComfyUI URL, workflow file and node IDs.');
}
const server = createApp(db, { publicOrigin: process.env.STH_PUBLIC_ORIGIN, webPassword: process.env.STH_WEB_PASSWORD,
  mediaProvider: media, invalidMediaConfig });
const workers = [startGenerationWorker(db), startExternalWorker(db)];
if (media) workers.push(startJobsWorker(db, { provider: media }));
server.once('close', async () => {
  try { await Promise.all(workers.map(worker => worker.stop())); }
  finally { db.close(); }
});
const host = process.env.STH_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(`Sth ready at http://127.0.0.1:${address.port}`);
});
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
