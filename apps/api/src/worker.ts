// Outbox worker: relays committed outbox_event rows to BullMQ and consumes them.
// Handlers must be idempotent (delivery is at-least-once).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  anchorHead,
  createCoreServices,
  FileAnchorSink,
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
import { CLAIM_TOPICS, FIDELITY_EVENT_TOPIC } from '@chema/fidelity';
import { PAYOUT_EVENT_TOPIC } from '@chema/payments';
import { PAYOUT_TOPICS } from '@chema/payouts';
import { MockSender } from '@chema/channels';
import { WA_INBOUND_TOPIC } from '@chema/whatsapp';
import { walletCommands } from '@chema/wallet';
import { z } from 'zod';
import { buildContributions } from './contributions';
import { buildClaims } from './fidelity';
import { buildPayments } from './payments';
import { buildPayouts } from './payouts';
import { buildWhatsApp, chooseWhatsAppProviders } from './whatsapp';

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
const publicBaseUrl = process.env['CHEMA_PUBLIC_BASE_URL'] ?? 'http://localhost:3000';
// WhatsApp notifications go out through the chosen provider (simulator in dev, D16).
const waProviders = await chooseWhatsAppProviders(core, process.env);
for (const w of waProviders.warnings) log.warn(w);
const contributions = buildContributions(core, payments.service, {
  secrets,
  publicBaseUrl,
  senders: [new MockSender('SMS'), new MockSender('EMAIL'), ...(waProviders.sender ? [waProviders.sender] : [])],
});

const claims = buildClaims(core, secrets);
const payouts = buildPayouts(core, payments.rails, secrets);
const whatsapp = buildWhatsApp(core, {
  secrets,
  providers: waProviders.providers,
  contributions: contributions.service,
  wallets: walletCommands({ flags: core.flags, publicBaseUrl }),
  payouts,
  claims: claims.service,
  publicBaseUrl,
  portalUrl: process.env['CHEMA_PORTAL_URL'] ?? 'http://localhost:3001',
});
const InboundPayload = z.object({ inboundId: z.uuid() });

const DocPayload = z.object({ documentId: z.uuid() });
const EventPayload = z.object({ eventRowId: z.uuid() });
const ReceiptPayload = z.object({ receiptId: z.uuid() });
const PaymentFinalPayload = z.object({ paymentId: z.uuid() }).loose();
const NotificationPayload = z.object({ notificationId: z.uuid() });
const PurgePayload = z.object({ documentId: z.uuid(), storageRef: z.string() });
const WalletEventPayload = z.object({ walletId: z.uuid() }).loose();
const PayoutTopicPayload = z.object({ walletId: z.uuid().nullable().optional() }).loose();
const PayoutEventPayload = z.object({ rail: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/), providerRef: z.string().min(1).max(128), reference: z.string().max(128).optional() });

// Wallet lifecycle events (docs/05). Family/staff notification channels are
// D16 + P08/P09; until then each event is acknowledged and logged (ids only).
// A delivery failure never touches wallet state.
const walletHandlers = Object.fromEntries(
  [...WALLET_TOPICS, ...CONTRIBUTION_TOPICS, ...CLAIM_TOPICS].map((topic) => [
    topic,
    async (payload: unknown) => {
      const { walletId } = WalletEventPayload.parse(payload);
      log.info({ topic, walletId }, 'wallet/contribution event (logged; notifications go through notification.send)');
    },
  ]),
);

// P07 payout / case / hold / closure events: logged (ids only) until P08/P09 notify staff.
const payoutTopicHandlers = Object.fromEntries(
  PAYOUT_TOPICS.map((topic) => [
    topic,
    async (payload: unknown) => {
      const { walletId } = PayoutTopicPayload.parse(payload);
      log.info({ topic, walletId }, 'payout/governance event (logged)');
    },
  ]),
);

const outboxWorker = createOutboxWorker(redisUrl, {
  ...walletHandlers,
  ...payoutTopicHandlers,
  // Payout callback = trigger only: re-read the payout from the provider (idempotent).
  [PAYOUT_EVENT_TOPIC]: async (payload) => {
    const { rail, providerRef, reference } = PayoutEventPayload.parse(payload);
    const r = await payouts.processEvent({ rail, providerRef, ...(reference ? { reference } : {}) });
    log.info({ outcome: r }, 'payout event');
  },
  // Stored WhatsApp message: run one orchestrator turn (idempotent: processed rows are skipped).
  [WA_INBOUND_TOPIC]: async (payload) => {
    const r = await whatsapp.process(InboundPayload.parse(payload).inboundId);
    log.info({ outcome: r.outcome, replayed: r.replayed }, 'whatsapp message');
  },
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
  // Verified Fidelity callback stored by the API: queue + run a SYNC (idempotent).
  [FIDELITY_EVENT_TOPIC]: async (payload) => {
    const { eventRowId } = EventPayload.parse(payload);
    const r = await claims.service.processEvent(eventRowId);
    log.info({ eventRowId, outcome: r.outcome }, 'fidelity event');
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

/** WhatsApp messages the queue never finished (crash between store and process). */
async function whatsappLoop(): Promise<void> {
  while (!stopping) {
    try {
      const { attempted } = await whatsapp.processPending();
      if (attempted) log.info({ attempted }, 'whatsapp retries');
    } catch (err) {
      log.error({ err }, 'whatsapp retry error');
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

/** Fidelity calls: retries (backoff per request) + periodic re-reads of open claims. */
async function fidelityLoop(): Promise<void> {
  while (!stopping) {
    try {
      if (await core.flags.get('fidelity.claims_link')) {
        const r = await claims.service.pollDue();
        if (r.queued || r.attempted) log.info(r, 'fidelity poll');
      }
    } catch (err) {
      log.error({ err }, 'fidelity poll error');
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

/** Payouts: decisions taken elsewhere, due submissions/retries, status polls, payee checks. */
async function payoutLoop(): Promise<void> {
  while (!stopping) {
    try {
      const r = await payouts.runDue();
      if (r.advanced || r.submitted || r.polled || r.payees) log.info(r, 'payout run');
    } catch (err) {
      log.error({ err }, 'payout loop error');
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

/** Case + recon-exception ageing / escalation (docs/14 §O). */
async function governanceLoop(): Promise<void> {
  while (!stopping) {
    try {
      const r = await payouts.sweep();
      if (r.casesEscalated || r.exceptionsEscalated || r.holdsDueForReview) log.info(r, 'governance sweep');
    } catch (err) {
      log.error({ err }, 'governance sweep error');
    }
    await new Promise((r) => setTimeout(r, 15 * 60_000));
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
    // Benefit credits vs Fidelity's benefit ledger (docs/07 Resilience).
    try {
      if (await core.flags.get('fidelity.claims_link')) {
        log.info({ day, ...(await claims.service.runRecon(SYSTEM_ACTOR, day)) }, 'benefit reconciliation run');
      }
    } catch (err) {
      log.error({ err, day }, 'benefit reconciliation error');
    }
    await new Promise((r) => setTimeout(r, 6 * 3_600_000));
  }
}

/**
 * Audit-chain head → an append-only anchor outside the database (docs/10).
 * Default: a JSONL file; in production point CHEMA_AUDIT_ANCHOR_FILE at
 * write-once storage (object lock / WORM) the DB operators cannot rewrite.
 */
const anchorFile = process.env['CHEMA_AUDIT_ANCHOR_FILE'] ?? '.data/audit-anchors.jsonl';
const anchorEveryMs = Number.parseInt(process.env['CHEMA_AUDIT_ANCHOR_INTERVAL_MS'] ?? '', 10) > 0
  ? Number.parseInt(process.env['CHEMA_AUDIT_ANCHOR_INTERVAL_MS'] ?? '', 10)
  : 5 * 60_000;
async function anchorLoop(): Promise<void> {
  const sink = new FileAnchorSink(anchorFile);
  // undefined ⇒ anchorHead reads the sink's last anchor itself (first round, or after an error).
  let last: Awaited<ReturnType<typeof anchorHead>> | undefined;
  while (!stopping) {
    try {
      mkdirSync(dirname(anchorFile), { recursive: true });
      const a = await anchorHead(db, sink, new Date(), last);
      if (a) {
        last = a;
        log.info({ seq: a.seq }, 'audit head anchored');
      }
    } catch (err) {
      last = undefined;
      log.error({ err }, 'audit anchor error');
    }
    await new Promise((r) => setTimeout(r, anchorEveryMs));
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
void fidelityLoop();
void payoutLoop();
void governanceLoop();
void whatsappLoop();
void anchorLoop();
