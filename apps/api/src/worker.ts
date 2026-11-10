// Outbox worker: relays committed outbox_event rows to BullMQ and consumes them.
// Handlers must be idempotent (delivery is at-least-once).
import {
  createCoreServices,
  LocalFsBlobStore,
  loadSecrets,
  MockMalwareScanner,
  MockOtpProvider,
  OutboxRelay,
  SYSTEM_ACTOR,
} from '@chema/core';
import { BullMqJobQueue, createOutboxWorker } from '@chema/core/bullmq';
import { createLogger, createPgClient } from '@chema/shared';
import { z } from 'zod';

const log = createLogger(process.env['LOG_LEVEL'] ?? 'info');
const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
if (!databaseUrl || !redisUrl) {
  log.error('DATABASE_URL and REDIS_URL are required');
  process.exit(2);
}

const db = createPgClient(databaseUrl, 4, (err) => log.warn({ err }, 'idle database connection lost'));
const blobs = new LocalFsBlobStore(process.env['CHEMA_BLOB_DIR'] ?? '.data/blobs');
const core = createCoreServices({ db, secrets: loadSecrets(), otp: new MockOtpProvider(), blobs, scanner: new MockMalwareScanner() });
const queue = new BullMqJobQueue(redisUrl);
const relay = new OutboxRelay(db, queue);

const DocPayload = z.object({ documentId: z.uuid() });
const PurgePayload = z.object({ documentId: z.uuid(), storageRef: z.string() });

const outboxWorker = createOutboxWorker(redisUrl, {
  'document.scan': async (payload) => {
    const { documentId } = DocPayload.parse(payload);
    await core.bus.execute(core.documents.applyScan, { documentId }, { actor: SYSTEM_ACTOR });
  },
  'document.purge': async (payload) => {
    const { storageRef } = PurgePayload.parse(payload);
    await blobs.delete(storageRef);
  },
});
outboxWorker.worker.on('failed', (job, err) => log.warn({ jobId: job?.id, topic: job?.name, err }, 'outbox job failed'));

let stopping = false;
async function relayLoop(): Promise<void> {
  while (!stopping) {
    try {
      const { dispatched, failed } = await relay.runOnce();
      if (dispatched || failed) log.info({ dispatched, failed }, 'outbox relay');
      if (dispatched === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      log.error({ err }, 'outbox relay error');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'worker shutting down');
  stopping = true;
  await outboxWorker.close();
  await queue.close();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info('outbox worker started');
void relayLoop();
