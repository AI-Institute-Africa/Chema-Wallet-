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
import { CONTRIBUTION_TOPICS } from '@chema/contributions';
import { NOTIFICATION_TOPIC } from '@chema/channels';
import { WALLET_TOPICS } from '@chema/wallet';
import { z } from 'zod';
import { buildContributions } from './contributions';
import { buildPayments } from './payments';

const log = createLogger(process.env['LOG_LEVEL'] ?? 'info');
const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
if (!databaseUrl || !redisUrl) {
  log.error('DATABASE_URL and REDIS_URL are required');
  process.exit(2);
}

const db = createPgClient(databaseUrl, 4, (err) => log.warn({ err }, 'idle database connection lost'));
const blobs = new LocalFsBlobStore(process.env['CHEMA_BLOB_DIR'] ?? '.data/blobs');
const secrets = loadSecrets();
const core = createCoreServices({ db, secrets, otp: new MockOtpProvider(), blobs, scanner: new MockMalwareScanner() });
const queue = new BullMqJobQueue(redisUrl);
const relay = new OutboxRelay(db, queue);

const payments = await buildPayments(core);
const contributions = buildContributions(core, payments.service, {
  secrets,
  publicBaseUrl: process.env['CHEMA_PUBLIC_BASE_URL'] ?? 'http://localhost:3000',
});

const DocPayload = z.object({ documentId: z.uuid() });
const EventPayload = z.object({ eventRowId: z.uuid() });
const ReceiptPayload = z.object({ receiptId: z.uuid() });
const PaymentFinalPayload = z.object({ paymentId: z.uuid() }).loose();
const NotificationPayload = z.object({ notificationId: z.uuid() });
const PurgePayload = z.object({ documentId: z.uuid(), storageRef: z.string() });
const WalletEventPayload = z.object({ walletId: z.uuid() }).loose();

// Wallet lifecycle events (docs/05). Family/staff notification channels are
// D16 + P08/P09; until then each event is acknowledged and logged (ids only).
// A delivery failure never touches wallet state.
const walletHandlers = Object.fromEntries(
  [...WALLET_TOPICS, ...CONTRIBUTION_TOPICS].map((topic) => [
    topic,
    async (payload: unknown) => {
      const { walletId } = WalletEventPayload.parse(payload);
      log.info({ topic, walletId }, 'wallet/contribution event (logged; notifications go through notification.send)');
    },
  ]),
);

const outboxWorker = createOutboxWorker(redisUrl, {
  ...walletHandlers,
  'document.scan': async (payload) => {
    const { documentId } = DocPayload.parse(payload);
    await core.bus.execute(core.documents.applyScan, { documentId }, { actor: SYSTEM_ACTOR });
  },
  'document.purge': async (payload) => {
    const { storageRef } = PurgePayload.parse(payload);
    await blobs.delete(storageRef);
  },
  // Provider callback stored by the API: process it (idempotent).
  'payment.event': async (payload) => {
    const { eventRowId } = EventPayload.parse(payload);
    await payments.service.processEvent(eventRowId);
  },
  // Rows written before P05 used this topic; contribution.settle now owns receipts.
  'receipt.notify': async (payload) => {
    const { receiptId } = ReceiptPayload.parse(payload);
    log.info({ receiptId }, 'legacy receipt.notify ignored');
  },
  // Final payment state ⇒ contribution settle: receipt issue, tribute, family notice, target (idempotent).
  'payment.succeeded': async (payload) => {
    await contributions.service.settle(PaymentFinalPayload.parse(payload).paymentId);
  },
  'payment.failed': async (payload) => {
    await contributions.service.settle(PaymentFinalPayload.parse(payload).paymentId);
  },
  // One delivery attempt; failures are recorded on the notification and retried by notifyLoop.
  [NOTIFICATION_TOPIC]: async (payload) => {
    const n = await contributions.notifications.deliver(NotificationPayload.parse(payload).notificationId);
    log.info({ notificationId: n.id, status: n.status, attempts: n.attempts }, 'notification');
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

/** Status queries for open payments (backoff is per payment, see POLL). */
async function pollLoop(): Promise<void> {
  while (!stopping) {
    try {
      const { polled } = await payments.service.pollDue();
      if (polled) log.info({ polled }, 'payment status poll');
    } catch (err) {
      log.error({ err }, 'payment poll error');
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

/** Notification retries (backoff per notification, see NOTIFY_RETRY). */
async function notifyLoop(): Promise<void> {
  while (!stopping) {
    try {
      const { attempted } = await contributions.notifications.deliverDue();
      if (attempted) log.info({ attempted }, 'notification retries');
    } catch (err) {
      log.error({ err }, 'notification retry error');
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

/** Daily reconciliation of yesterday, every rail; re-running a day is idempotent. */
async function reconLoop(): Promise<void> {
  while (!stopping) {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    for (const rail of payments.rails.rails()) {
      try {
        const s = await payments.service.runRecon(SYSTEM_ACTOR, rail, day);
        log.info({ rail, day, ...s }, 'reconciliation run');
      } catch (err) {
        log.error({ err, rail, day }, 'reconciliation error');
      }
    }
    await new Promise((r) => setTimeout(r, 6 * 3_600_000));
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
void pollLoop();
void notifyLoop();
void reconLoop();
