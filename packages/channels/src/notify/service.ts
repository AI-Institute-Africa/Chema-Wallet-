// Notification service skeleton (P05 Do 10): template + queue + retry + status.
// Producers call `enqueueNotification` inside their own command transaction;
// the worker delivers after commit. Delivery never touches transaction state:
// a failed send only changes this row (docs/CLAUDE.md invariant).
//
// Addresses and template params are sealed with the data key (they can hold
// names, phone numbers and tribute text). A person recipient is resolved to
// a phone number at send time, never copied.
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  SYSTEM_ACTOR,
  enqueueOutbox,
  seal,
  unseal,
  type Command,
  type CommandBus,
  type CommandTx,
} from '@chema/core';
import { isLocale, t, type Locale, type MessageKey, type Queryable, type SqlClient } from '@chema/shared';

export const NOTIFICATION_CHANNELS = ['WEB', 'EMAIL', 'SMS'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationStatus = 'QUEUED' | 'RETRY' | 'SENT' | 'DEAD' | 'SUPPRESSED';

/** Retry policy: 1 min doubling, at most 5 attempts, then DEAD (an operator can see it). */
export const NOTIFY_RETRY = { maxAttempts: 5, firstDelayMs: 60_000, leaseMs: 5 * 60_000 } as const;

export const NOTIFICATION_TOPIC = 'notification.send';

export interface NotificationRequest {
  template: MessageKey;
  channel: NotificationChannel;
  /** A person (resolved at send time) or a raw address (phone / email) for people without an account. */
  to: { personId: string } | { address: string };
  params: Record<string, string>;
  /** Same key ⇒ same notification (at-least-once producers stay idempotent). */
  dedupeKey: string;
  walletId?: string;
  locale?: Locale;
}

const paramsAad = (id: string) => `notification:params:${id}`;
const addressAad = (id: string) => `notification:to:${id}`;

/** Queue a notification in the producer's transaction. Returns the id (existing one on a duplicate key). */
export async function enqueueNotification(
  tx: CommandTx,
  key: Buffer,
  req: NotificationRequest,
  now: Date,
): Promise<{ id: string; created: boolean }> {
  // Fail at enqueue, not at delivery, when a param is missing.
  t(req.template, req.params, req.locale ?? 'en');
  const id = randomUUID();
  const params = seal(key, Buffer.from(JSON.stringify(req.params), 'utf8'), paramsAad(id)).toString('base64');
  const address = 'address' in req.to ? seal(key, Buffer.from(req.to.address, 'utf8'), addressAad(id)).toString('base64') : null;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO notification (id, template, channel, recipient_person, recipient_sealed, locale, params_sealed, dedupe_key,
                               wallet_id, status, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9::uuid, 'QUEUED', $10, $10, $10)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [
      id,
      req.template,
      req.channel,
      'personId' in req.to ? req.to.personId : null,
      address,
      req.locale ?? 'en',
      params,
      req.dedupeKey,
      req.walletId ?? null,
      now.toISOString(),
    ],
  );
  if (!rows[0]) {
    const { rows: prior } = await tx.query<{ id: string }>('SELECT id FROM notification WHERE dedupe_key = $1', [req.dedupeKey]);
    return { id: prior[0]?.id ?? '', created: false };
  }
  await enqueueOutbox(tx, NOTIFICATION_TOPIC, { notificationId: id });
  return { id, created: true };
}

/** A delivery channel. `send` throws on failure; the service records it and retries. */
export interface ChannelSender {
  readonly channel: Exclude<NotificationChannel, 'WEB'>;
  send(to: string, text: string): Promise<void>;
}

/** Mock SMS / email sender: records messages; `failNext` simulates a dead provider. */
export class MockSender implements ChannelSender {
  readonly sent: { to: string; text: string }[] = [];
  private failures = 0;
  constructor(readonly channel: 'SMS' | 'EMAIL') {}
  failNext(n = 1): void {
    this.failures += n;
  }
  async send(to: string, text: string): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(`${this.channel} provider unavailable`);
    }
    this.sent.push({ to, text });
  }
}

export interface NotificationView {
  id: string;
  template: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  attempts: number;
  lastError: string | null;
}

interface Row {
  id: string;
  template: string;
  channel: NotificationChannel;
  recipient_person: string | null;
  recipient_sealed: string | null;
  locale: string;
  params_sealed: string;
  status: NotificationStatus;
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
}

const COLS = 'id, template, channel, recipient_person, recipient_sealed, locale, params_sealed, status, attempts, next_attempt_at, last_error';

async function load(q: Queryable, id: string, lock = false): Promise<Row> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError('notification', id);
  const { rows } = await q.query<Row>(`SELECT ${COLS} FROM notification WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new NotFoundError('notification', id);
  return rows[0];
}

const viewOf = (r: Row): NotificationView => ({
  id: r.id,
  template: r.template,
  channel: r.channel,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
});

type Claimed = { kind: 'SEND'; to: string; text: string; channel: Exclude<NotificationChannel, 'WEB'> } | { kind: 'DONE'; view: NotificationView };

export interface NotificationDeps {
  db: SqlClient;
  bus: CommandBus;
  key: Buffer;
  senders: readonly ChannelSender[];
  clock?: () => Date;
}

/**
 * Delivery: claim (tx) → send (no tx) → record (tx). Claiming bumps
 * `attempts` and leases the row, so two workers never send the same attempt.
 */
export class NotificationService {
  private readonly clock: () => Date;
  private readonly claimCmd: Command<{ id: string }, Claimed>;
  private readonly recordCmd: Command<{ id: string; error: string | null }, NotificationView>;

  constructor(private readonly deps: NotificationDeps) {
    this.clock = deps.clock ?? (() => new Date());
    const clock = this.clock;
    const key = deps.key;

    this.claimCmd = {
      name: 'notification.claim',
      async resolve(q, input) {
        const r = await load(q, input.id);
        return { action: 'notification.process', subject: { type: 'notification', id: r.id } };
      },
      async run(tx, input) {
        const now = clock();
        const r = await load(tx, input.id, true);
        if (r.status !== 'QUEUED' && r.status !== 'RETRY') return { result: { kind: 'DONE', view: viewOf(r) } };
        if (r.next_attempt_at && new Date(r.next_attempt_at).getTime() > now.getTime()) {
          return { result: { kind: 'DONE', view: viewOf(r) } };
        }
        const params = JSON.parse(unseal(key, Buffer.from(r.params_sealed, 'base64'), paramsAad(r.id)).toString('utf8')) as Record<string, string>;
        const locale: Locale = isLocale(r.locale) ? r.locale : 'en';
        const text = t(r.template as MessageKey, params, locale);
        // WEB = in-app notice: stored is delivered.
        if (r.channel === 'WEB') {
          await tx.query("UPDATE notification SET status = 'SENT', attempts = attempts + 1, sent_at = $2, next_attempt_at = NULL, updated_at = $2 WHERE id = $1", [r.id, now.toISOString()]);
          return { result: { kind: 'DONE', view: { ...viewOf(r), status: 'SENT', attempts: r.attempts + 1 } }, audit: { reasonCode: 'SENT' } };
        }
        let to: string | null = null;
        if (r.recipient_sealed) {
          to = unseal(key, Buffer.from(r.recipient_sealed, 'base64'), addressAad(r.id)).toString('utf8');
        } else if (r.recipient_person && r.channel === 'SMS') {
          const { rows } = await tx.query<{ phone_e164: string | null }>('SELECT phone_e164 FROM person WHERE id = $1', [r.recipient_person]);
          to = rows[0]?.phone_e164 ?? null;
        }
        if (!to) {
          await tx.query("UPDATE notification SET status = 'SUPPRESSED', next_attempt_at = NULL, last_error = 'no address', updated_at = $2 WHERE id = $1", [r.id, now.toISOString()]);
          return { result: { kind: 'DONE', view: { ...viewOf(r), status: 'SUPPRESSED' } }, audit: { reasonCode: 'NO_ADDRESS' } };
        }
        await tx.query('UPDATE notification SET attempts = attempts + 1, next_attempt_at = $2, updated_at = $3 WHERE id = $1', [
          r.id,
          new Date(now.getTime() + NOTIFY_RETRY.leaseMs).toISOString(),
          now.toISOString(),
        ]);
        return { result: { kind: 'SEND', to, text, channel: r.channel }, audit: { reasonCode: 'CLAIMED' } };
      },
    };

    this.recordCmd = {
      name: 'notification.record',
      async resolve(q, input) {
        const r = await load(q, input.id);
        return { action: 'notification.process', subject: { type: 'notification', id: r.id } };
      },
      async run(tx, input) {
        const now = clock();
        const r = await load(tx, input.id, true);
        if (r.status !== 'QUEUED' && r.status !== 'RETRY') throw new ConflictError('NOTIFICATION_FINAL');
        if (input.error === null) {
          await tx.query("UPDATE notification SET status = 'SENT', sent_at = $2, next_attempt_at = NULL, last_error = NULL, updated_at = $2 WHERE id = $1", [r.id, now.toISOString()]);
          return { result: { ...viewOf(r), status: 'SENT', lastError: null }, audit: { reasonCode: 'SENT' } };
        }
        const err = input.error.slice(0, 200);
        if (r.attempts >= NOTIFY_RETRY.maxAttempts) {
          await tx.query("UPDATE notification SET status = 'DEAD', next_attempt_at = NULL, last_error = $2, updated_at = $3 WHERE id = $1", [r.id, err, now.toISOString()]);
          return { result: { ...viewOf(r), status: 'DEAD', lastError: err }, audit: { reasonCode: 'DEAD' } };
        }
        const delay = NOTIFY_RETRY.firstDelayMs * 2 ** Math.min(r.attempts - 1, 10);
        await tx.query("UPDATE notification SET status = 'RETRY', next_attempt_at = $2, last_error = $3, updated_at = $4 WHERE id = $1", [
          r.id,
          new Date(now.getTime() + delay).toISOString(),
          err,
          now.toISOString(),
        ]);
        return { result: { ...viewOf(r), status: 'RETRY', lastError: err }, audit: { reasonCode: 'RETRY' } };
      },
    };
  }

  /** Worker handler for `notification.send` and the retry loop. Never throws for a provider failure. */
  async deliver(id: string): Promise<NotificationView> {
    const claimed = await this.deps.bus.execute(this.claimCmd, { id }, { actor: SYSTEM_ACTOR });
    if (claimed.kind === 'DONE') return claimed.view;
    const sender = this.deps.senders.find((s) => s.channel === claimed.channel);
    let error: string | null = null;
    if (!sender) {
      error = `no ${claimed.channel} sender`;
    } else {
      try {
        await sender.send(claimed.to, claimed.text);
      } catch (err) {
        error = err instanceof Error ? err.message : 'send failed';
      }
    }
    return this.deps.bus.execute(this.recordCmd, { id, error }, { actor: SYSTEM_ACTOR });
  }

  /** Retry loop: deliver every QUEUED/RETRY notification that is due. */
  async deliverDue(limit = 50): Promise<{ attempted: number }> {
    const { rows } = await this.deps.db.query<{ id: string }>(
      `SELECT id FROM notification WHERE status IN ('QUEUED', 'RETRY') AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2`,
      [this.clock().toISOString(), limit],
    );
    for (const r of rows) await this.deliver(r.id);
    return { attempted: rows.length };
  }

  async status(id: string): Promise<NotificationView> {
    return viewOf(await load(this.deps.db, id));
  }
}
