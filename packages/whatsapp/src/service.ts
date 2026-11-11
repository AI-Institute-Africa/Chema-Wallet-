// WhatsApp pipeline (docs/09): webhook → verify signature + replay → store raw
// (idempotent by message id) → queue → resolve session → orchestrator → core
// services → reply (notification: retry, dead-letter, delivery status).
// Plus the secure web hand-off the orchestrator sends people to.
//
// Every state change here is a bus command (audited): `whatsapp.ingest` and
// `whatsapp.process` run as SYSTEM; `handoff.redeem` runs as the person.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SYSTEM_ACTOR,
  ValidationError,
  enqueueOutbox,
  sha256Hex,
  type Actor,
  type Command,
  type Secrets,
} from '@chema/core';
import { enqueueNotification, type ChannelProvider, type InboundMessage, type StatusEvent, type WaProviderName } from '@chema/channels';
import { PAYOUT_PURPOSES, type PayoutPurpose } from '@chema/payouts';
import { format, isCurrency, money, t, type Locale, type MessageKey, type Queryable } from '@chema/shared';
import { createHmac } from 'node:crypto';
import { NoAssistant, type Assistant } from './faq';
import { AMOUNT_STATES, Orchestrator, WA_LIMITS, type HandoffPurpose, type OrchestratorDeps, type TurnResult } from './orchestrator';
import { CONV_COLS, bodyAad, decodeConversation, handoffAad, loadConversation, phoneAad, sealData, type ConvRow } from './store';
import { looksSensitive, maskPhone, openText, phoneHashOf, sealText, waKeys, type WaKeys } from './util';

export const WA_INBOUND_TOPIC = 'whatsapp.inbound';

/** Not in spec — safest reasonable defaults (PROGRESS.md Assumptions). */
export const WA_PIPELINE = {
  /** Per number: at most this many messages per window; the rest are stored IGNORED, unanswered. */
  rateMax: 20,
  rateWindowMs: 60_000,
  /** Messages older than this when they arrive are stored IGNORED (STALE). */
  maxMessageAgeMs: 24 * 60 * 60_000,
  /** Processing attempts before an inbound message is marked FAILED. */
  maxAttempts: 5,
  maxBodyChars: 4096,
} as const;

export interface WhatsAppServiceDeps extends Omit<OrchestratorDeps, 'assistant' | 'reportKey'> {
  secrets: Secrets;
  /** Enabled providers. The simulator outside production; Meta only behind `channel.whatsapp` (D16). */
  providers: readonly ChannelProvider[];
  assistant?: Assistant;
  clock?: () => Date;
}

interface InboundRow {
  id: string;
  conversation_id: string;
  body_sealed: string;
  redacted: boolean;
  status: string;
  attempts: number;
  sent_at: Date;
}

interface HandoffRow {
  id: string;
  conversation_id: string;
  purpose: HandoffPurpose;
  context_sealed: string;
  auth_session_id: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface HandoffSummary {
  purpose: HandoffPurpose;
  expiresAt: string;
  /** Masked, minimum data: enough to recognise the request. */
  summary: Record<string, string>;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Human-readable conversation reference: WA- + 8 base32 characters. */
const escalationRefOf = (bytes: Buffer) => `WA-${[...bytes].map((b) => B32[b % 32]).join('')}`;

const HANDOFF_COLS = 'id, conversation_id, purpose, context_sealed, auth_session_id, expires_at, consumed_at';
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

async function handoffByToken(q: Queryable, token: string, lock = false): Promise<HandoffRow> {
  if (!TOKEN.test(token)) throw new NotFoundError('wa_handoff', 'invalid');
  const { rows } = await q.query<HandoffRow>(`SELECT ${HANDOFF_COLS} FROM wa_handoff WHERE token_hash = $1${lock ? ' FOR UPDATE' : ''}`, [sha256Hex(token)]);
  if (!rows[0]) throw new NotFoundError('wa_handoff', 'unknown');
  return rows[0];
}

export class WhatsAppService {
  readonly keys: WaKeys;
  readonly orchestrator: Orchestrator;
  private readonly clock: () => Date;
  private readonly providers: Map<WaProviderName, ChannelProvider>;
  private readonly notifyKey: Buffer;
  readonly ingestCmd: Command<{ provider: WaProviderName; msg: InboundMessage }, { inboundId: string | null; duplicate: boolean; queued: boolean }>;
  readonly statusCmd: Command<{ provider: WaProviderName; s: StatusEvent }, { stored: boolean }>;
  readonly commitCmd: Command<{ inboundId: string; result: TurnResult }, { replayed: boolean; escalationRef: string | null }>;
  readonly failCmd: Command<{ inboundId: string; error: string }, { status: string }>;
  readonly redeemCmd: Command<{ token: string; purpose: HandoffPurpose; notice?: { template: MessageKey; params: Record<string, string> } }, { handoffId: string; conversationId: string; context: Record<string, string> }>;

  constructor(private readonly d: WhatsAppServiceDeps) {
    this.clock = d.clock ?? (() => new Date());
    this.keys = waKeys(d.secrets);
    this.notifyKey = d.secrets.dataKey;
    this.providers = new Map(d.providers.map((p) => [p.name, p]));
    const reportKey = createHmac('sha256', d.secrets.authKey).update('chema:wa-report:v1').digest();
    this.orchestrator = new Orchestrator({ ...d, assistant: d.assistant ?? new NoAssistant(), reportKey });
    const keys = this.keys;
    const clock = this.clock;
    const notifyKey = this.notifyKey;

    this.ingestCmd = {
      name: 'whatsapp.ingest',
      async resolve() {
        return { action: 'whatsapp.ingest', subject: { type: 'wa_inbound', id: 'new' } };
      },
      async run(tx, { provider, msg }) {
        const now = clock();
        const { rows: dup } = await tx.query<{ id: string }>('SELECT id FROM wa_inbound WHERE provider = $1 AND message_id = $2', [provider, msg.messageId]);
        if (dup[0]) return { result: { inboundId: dup[0].id, duplicate: true, queued: false }, audit: { reasonCode: 'DUPLICATE', subjectId: dup[0].id } };

        const hash = phoneHashOf(keys, msg.from);
        const newId = randomUUID();
        await tx.query(
          `INSERT INTO wa_conversation (id, phone_hash, phone_sealed, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (phone_hash) DO NOTHING`,
          [newId, hash, sealText(keys, msg.from, phoneAad(newId)), now.toISOString()],
        );
        const { rows } = await tx.query<ConvRow>(`SELECT ${CONV_COLS} FROM wa_conversation WHERE phone_hash = $1 FOR UPDATE`, [hash]);
        const conv = rows[0];
        if (!conv) throw new ConflictError('WA_CONVERSATION');

        const fresh = !conv.rate_window_start || now.getTime() - new Date(conv.rate_window_start).getTime() > WA_PIPELINE.rateWindowMs;
        const count = fresh ? 1 : conv.rate_count + 1;
        const limited = count > WA_PIPELINE.rateMax;
        const stale = now.getTime() - msg.sentAt.getTime() > WA_PIPELINE.maxMessageAgeMs;
        // A secret is never stored, not even sealed (docs/09).
        const redacted = looksSensitive(msg.text, AMOUNT_STATES.has(conv.state));
        const id = randomUUID();
        const outcome = limited ? 'RATE_LIMITED' : stale ? 'STALE' : null;
        const { rows: ins } = await tx.query<{ id: string }>(
          `INSERT INTO wa_inbound (id, provider, message_id, conversation_id, body_sealed, redacted, sent_at, received_at, status, outcome, processed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (provider, message_id) DO NOTHING RETURNING id`,
          [
            id,
            provider,
            msg.messageId,
            conv.id,
            sealText(keys, redacted ? '' : `${msg.kind}:${msg.text.slice(0, WA_PIPELINE.maxBodyChars)}`, bodyAad(id)),
            redacted,
            msg.sentAt.toISOString(),
            now.toISOString(),
            outcome ? 'IGNORED' : 'RECEIVED',
            outcome,
            outcome ? now.toISOString() : null,
          ],
        );
        if (!ins[0]) return { result: { inboundId: null, duplicate: true, queued: false }, audit: { reasonCode: 'DUPLICATE' } };
        await tx.query('UPDATE wa_conversation SET rate_window_start = $2, rate_count = $3, updated_at = $4 WHERE id = $1', [
          conv.id,
          fresh ? now.toISOString() : new Date(conv.rate_window_start ?? now).toISOString(),
          Math.min(count, 1_000_000),
          now.toISOString(),
        ]);
        if (!outcome) await enqueueOutbox(tx, WA_INBOUND_TOPIC, { inboundId: id });
        return {
          result: { inboundId: id, duplicate: false, queued: !outcome },
          audit: { reasonCode: outcome ?? (redacted ? 'STORED_REDACTED' : 'STORED'), subjectId: id },
        };
      },
    };

    this.statusCmd = {
      name: 'whatsapp.ingest',
      async resolve(_q, { s }) {
        return { action: 'whatsapp.ingest', subject: { type: 'wa_delivery_event', id: s.providerMessageId.slice(0, 64) } };
      },
      async run(tx, { provider, s }) {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO wa_delivery_event (id, provider, provider_message_id, status, error, occurred_at, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (provider, provider_message_id, status) DO NOTHING RETURNING id`,
          [randomUUID(), provider, s.providerMessageId, s.status, s.error ?? null, s.at.toISOString(), clock().toISOString()],
        );
        return { result: { stored: rows.length === 1 }, audit: { reasonCode: rows.length === 1 ? `DELIVERY_${s.status}` : 'DUPLICATE' } };
      },
    };

    this.commitCmd = {
      name: 'whatsapp.process',
      async resolve(q, { inboundId }) {
        const { rows } = await q.query<{ id: string }>('SELECT id FROM wa_inbound WHERE id = $1', [inboundId]);
        if (!rows[0]) throw new NotFoundError('wa_inbound', inboundId);
        return { action: 'whatsapp.process', subject: { type: 'wa_inbound', id: inboundId } };
      },
      async run(tx, { inboundId, result }) {
        const now = clock();
        const { rows } = await tx.query<InboundRow>('SELECT id, conversation_id, status, sent_at FROM wa_inbound WHERE id = $1 FOR UPDATE', [inboundId]);
        const row = rows[0];
        if (!row || row.status !== 'RECEIVED') return { result: { replayed: true, escalationRef: null }, audit: { reasonCode: 'ALREADY_PROCESSED' } };
        const conv = await loadConversation(tx, keys, row.conversation_id, true);
        const tr = (key: MessageKey, params: Record<string, string> = {}) => t(key, params, result.locale);
        const lines = result.text ? [result.text] : [];

        let escalationRef: string | null = null;
        if (result.escalate) {
          const { rows: open } = await tx.query<{ ref: string }>("SELECT ref FROM wa_escalation WHERE conversation_id = $1 AND status = 'OPEN'", [conv.id]);
          if (open[0]) {
            escalationRef = open[0].ref;
            lines.push(tr('wa.human.already', { ref: escalationRef }));
          } else {
            escalationRef = escalationRefOf(randomBytes(8));
            await tx.query('INSERT INTO wa_escalation (id, ref, conversation_id, inbound_id, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
              randomUUID(),
              escalationRef,
              conv.id,
              inboundId,
              result.escalate,
              now.toISOString(),
            ]);
            lines.push(tr('wa.human.ref', { ref: escalationRef }));
          }
        }

        for (const h of result.handoffs) {
          await tx.query(
            `INSERT INTO wa_handoff (id, token_hash, conversation_id, purpose, context_sealed, auth_session_id, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              h.id,
              sha256Hex(h.token),
              conv.id,
              h.purpose,
              sealText(keys, JSON.stringify(h.context), handoffAad(h.id)),
              h.authSessionId,
              new Date(now.getTime() + WA_LIMITS.handoffTtlMs).toISOString(),
              now.toISOString(),
            ],
          );
        }

        await tx.query(
          `UPDATE wa_conversation SET state = $2, data_sealed = $3, locale = $4, misunderstood = $5, last_inbound_at = $6,
                  auth_session_id = CASE WHEN $7 THEN NULL ELSE auth_session_id END,
                  person_id = CASE WHEN $7 THEN NULL ELSE person_id END, updated_at = $8
            WHERE id = $1`,
          [conv.id, result.state, sealData(keys, conv.id, result.data), result.locale, Math.min(result.misunderstood, 100), row.sent_at, result.unbind, now.toISOString()],
        );

        const text = lines.join('\n\n');
        if (text) {
          await enqueueNotification(
            tx,
            notifyKey,
            { template: 'wa.reply', channel: 'WHATSAPP', to: { address: conv.phone }, params: { text }, dedupeKey: `wa:reply:${inboundId}`, locale: result.locale },
            now,
          );
        }
        await tx.query("UPDATE wa_inbound SET status = 'PROCESSED', outcome = $2, attempts = attempts + 1, processed_at = $3 WHERE id = $1", [
          inboundId,
          result.outcome.slice(0, 64),
          now.toISOString(),
        ]);
        return { result: { replayed: false, escalationRef }, audit: { reasonCode: result.outcome.slice(0, 64) } };
      },
    };

    this.failCmd = {
      name: 'whatsapp.process',
      async resolve(_q, { inboundId }) {
        return { action: 'whatsapp.process', subject: { type: 'wa_inbound', id: inboundId } };
      },
      async run(tx, { inboundId, error }) {
        const { rows } = await tx.query<{ status: string; attempts: number }>('SELECT status, attempts FROM wa_inbound WHERE id = $1 FOR UPDATE', [inboundId]);
        const r = rows[0];
        if (!r || r.status !== 'RECEIVED') return { result: { status: r?.status ?? 'MISSING' } };
        const final = r.attempts + 1 >= WA_PIPELINE.maxAttempts;
        await tx.query(
          `UPDATE wa_inbound SET attempts = attempts + 1, status = $2, outcome = $3, processed_at = $4 WHERE id = $1`,
          [inboundId, final ? 'FAILED' : 'RECEIVED', final ? 'PROCESSING_FAILED' : null, final ? clock().toISOString() : null],
        );
        return { result: { status: final ? 'FAILED' : 'RECEIVED' }, audit: { reasonCode: final ? 'FAILED' : 'RETRY', after: { error: error.slice(0, 120) } } };
      },
    };

    this.redeemCmd = {
      name: 'handoff.redeem',
      async resolve(q, { token }) {
        const h = await handoffByToken(q, token);
        return { action: 'handoff.redeem', subject: { type: 'wa_handoff', id: h.id } };
      },
      async guard(tx, { token, purpose }, actor) {
        const h = await handoffByToken(tx, token, true);
        if (h.consumed_at) return 'HANDOFF_USED';
        if (h.expires_at.getTime() <= clock().getTime()) return 'HANDOFF_EXPIRED';
        if (h.purpose !== purpose) return 'HANDOFF_PURPOSE';
        if (purpose === 'LOGIN') {
          // The OTP proved the phone; it must be THIS conversation's phone.
          if (actor.kind !== 'CUSTOMER' || actor.channel !== 'WHATSAPP' || !actor.sessionId) return 'HANDOFF_SESSION';
          const conv = await loadConversation(tx, keys, h.conversation_id);
          const { rows } = await tx.query<{ phone_e164: string | null }>('SELECT phone_e164 FROM person WHERE id = $1', [actor.personId]);
          if (rows[0]?.phone_e164 !== conv.phone) return 'HANDOFF_PHONE_MISMATCH';
        } else if (purpose === 'PAYOUT_REQUEST') {
          if (!h.auth_session_id || actor.sessionId !== h.auth_session_id) return 'HANDOFF_SESSION';
        }
        return null;
      },
      async run(tx, { token, purpose, notice }, { actor }) {
        const now = clock();
        const h = await handoffByToken(tx, token, true);
        await tx.query('UPDATE wa_handoff SET consumed_at = $2 WHERE id = $1', [h.id, now.toISOString()]);
        const conv = await loadConversation(tx, keys, h.conversation_id, true);
        if (purpose === 'LOGIN') {
          await tx.query(
            "UPDATE wa_conversation SET auth_session_id = $2, person_id = $3, state = 'MENU', data_sealed = $4, misunderstood = 0, updated_at = $5 WHERE id = $1",
            [conv.id, actor.sessionId, actor.personId, sealData(keys, conv.id, conv.data.contribs ? { contribs: conv.data.contribs } : {}), now.toISOString()],
          );
        }
        if (notice) {
          await enqueueNotification(
            tx,
            notifyKey,
            { template: notice.template, channel: 'WHATSAPP', to: { address: conv.phone }, params: notice.params, dedupeKey: `wa:handoff:${h.id}`, locale: conv.locale },
            now,
          );
        }
        const context = JSON.parse(openText(keys, h.context_sealed, handoffAad(h.id))) as Record<string, string>;
        return { result: { handoffId: h.id, conversationId: conv.id, context }, audit: { reasonCode: `REDEEMED_${purpose}` } };
      },
    };
  }

  // ── Pipeline ─────────────────────────────────────────────────────────────

  provider(name: string): ChannelProvider {
    const p = this.providers.get(name.toUpperCase() as WaProviderName);
    if (!p) throw new NotFoundError('wa_provider', name);
    return p;
  }

  /**
   * Verify, store raw, queue. A forged or stale webhook is refused (ForbiddenError)
   * and stores nothing; a duplicate message id stores and queues nothing.
   */
  async receiveWebhook(providerName: string, headers: Record<string, string | undefined>, rawBody: string) {
    const provider = this.provider(providerName);
    const v = provider.verify(headers, rawBody, this.clock());
    if (!v.ok) throw new ForbiddenError(`WEBHOOK_${v.reason}`);
    let parsed;
    try {
      parsed = provider.parse(rawBody);
    } catch {
      throw new ValidationError('malformed webhook');
    }
    const actor: Actor = { ...SYSTEM_ACTOR, channel: 'WHATSAPP' };
    const out = { stored: [] as string[], duplicates: 0, statuses: 0 };
    for (const msg of parsed.messages) {
      const r = await this.d.bus.execute(this.ingestCmd, { provider: provider.name, msg }, { actor });
      if (r.duplicate) out.duplicates += 1;
      else if (r.inboundId && r.queued) out.stored.push(r.inboundId);
    }
    for (const s of parsed.statuses) {
      if ((await this.d.bus.execute(this.statusCmd, { provider: provider.name, s }, { actor })).stored) out.statuses += 1;
    }
    return out;
  }

  /** Worker handler for `whatsapp.inbound`. Idempotent: a processed message is skipped. */
  async process(inboundId: string): Promise<{ outcome: string; replayed: boolean }> {
    const { rows } = await this.d.db.query<InboundRow>(
      'SELECT id, conversation_id, body_sealed, redacted, status, attempts, sent_at FROM wa_inbound WHERE id = $1',
      [inboundId],
    );
    const row = rows[0];
    if (!row || row.status !== 'RECEIVED') return { outcome: row?.status ?? 'MISSING', replayed: true };
    try {
      const conv = await loadConversation(this.d.db, this.keys, row.conversation_id);
      const body = openText(this.keys, row.body_sealed, bodyAad(row.id));
      const sep = body.indexOf(':');
      const kind = (row.redacted ? 'TEXT' : body.slice(0, sep)) as 'TEXT' | 'MEDIA' | 'OTHER';
      const text = row.redacted ? '' : body.slice(sep + 1);

      // Session: bound only after a WhatsApp OTP login; the session must be live
      // and its person must still own this number. Otherwise drop the binding.
      let actor: Actor | null = null;
      let signedOut = false;
      if (conv.authSessionId) {
        const a = await this.d.auth.actorForSession(conv.authSessionId);
        const { rows: p } = a ? await this.d.db.query<{ phone_e164: string | null }>('SELECT phone_e164 FROM person WHERE id = $1', [a.personId]) : { rows: [] };
        if (a && a.kind === 'CUSTOMER' && p[0]?.phone_e164 === conv.phone) actor = a;
        else signedOut = true;
      }
      const result = await this.orchestrator.handle({ inboundId, text, kind, redacted: row.redacted, conv, actor, signedOut, now: this.clock() });
      if (signedOut) result.unbind = true;
      const c = await this.d.bus.execute(this.commitCmd, { inboundId, result }, { actor: SYSTEM_ACTOR });
      return { outcome: result.outcome, replayed: c.replayed };
    } catch (err) {
      await this.d.bus.execute(this.failCmd, { inboundId, error: err instanceof Error ? err.message : 'error' }, { actor: SYSTEM_ACTOR });
      throw err;
    }
  }

  /** Retry loop: RECEIVED messages the queue never finished. */
  async processPending(olderThanMs = 60_000, limit = 50): Promise<{ attempted: number }> {
    const { rows } = await this.d.db.query<{ id: string }>(
      "SELECT id FROM wa_inbound WHERE status = 'RECEIVED' AND received_at < $1 ORDER BY received_at LIMIT $2",
      [new Date(this.clock().getTime() - olderThanMs).toISOString(), limit],
    );
    for (const r of rows) await this.process(r.id).catch(() => undefined);
    return { attempted: rows.length };
  }

  /** Sent WhatsApp notifications the provider later reported FAILED (ops reconciliation, P09 screen). */
  async failedDeliveries(limit = 100): Promise<{ notificationId: string; template: string; error: string | null; at: string }[]> {
    const { rows } = await this.d.db.query<{ id: string; template: string; error: string | null; occurred_at: Date }>(
      `SELECT n.id, n.template, e.error, e.occurred_at FROM notification n
         JOIN wa_delivery_event e ON e.provider_message_id = n.provider_ref AND e.status = 'FAILED'
        WHERE n.channel = 'WHATSAPP' ORDER BY e.occurred_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ notificationId: r.id, template: r.template, error: r.error, at: new Date(r.occurred_at).toISOString() }));
  }

  // ── Secure hand-off (the web page behind the link) ─────────────────────────

  private async live(token: string): Promise<{ h: HandoffRow; context: Record<string, string> }> {
    const h = await handoffByToken(this.d.db, token);
    if (h.consumed_at || h.expires_at.getTime() <= this.clock().getTime()) throw new NotFoundError('wa_handoff', 'expired');
    return { h, context: JSON.parse(openText(this.keys, h.context_sealed, handoffAad(h.id))) as Record<string, string> };
  }

  /** What the link is for, masked. Does not consume it. Unknown, used or expired ⇒ NotFoundError. */
  async describe(token: string): Promise<HandoffSummary> {
    const { h, context } = await this.live(token);
    let summary: Record<string, string> = {};
    if (h.purpose === 'LOGIN') {
      const conv = await loadConversation(this.d.db, this.keys, h.conversation_id);
      summary = { phone: maskPhone(conv.phone) };
    } else if (h.purpose === 'PAYOUT_REQUEST') {
      const ccy = isCurrency(context['currency']) ? context['currency'] : 'USD';
      summary = { amount: format(money(BigInt(context['amountMinor'] ?? '0'), ccy)), payee: context['payeeLabel'] ?? '', purpose: context['purpose'] ?? '' };
    } else if (context['walletId']) {
      summary = { walletId: context['walletId'] };
    }
    return { purpose: h.purpose, expiresAt: h.expires_at.toISOString(), summary };
  }

  /** Send the one-time code for this link: login OTP to the conversation's number, or the payout step-up. */
  async startOtp(token: string): Promise<{ challengeId: string }> {
    const { h, context } = await this.live(token);
    if (h.purpose === 'LOGIN') {
      const conv = await loadConversation(this.d.db, this.keys, h.conversation_id);
      return this.d.auth.startLogin({ phone: conv.phone, channel: 'WHATSAPP' });
    }
    if (h.purpose === 'PAYOUT_REQUEST') {
      const actor = await this.sessionOf(h);
      return this.d.auth.startStepUp(actor, { action: 'payout.request', subjectType: 'wallet', subjectId: context['walletId'] ?? '' });
    }
    throw new ConflictError('HANDOFF_NO_CODE');
  }

  private async sessionOf(h: HandoffRow): Promise<Actor> {
    const actor = h.auth_session_id ? await this.d.auth.actorForSession(h.auth_session_id) : null;
    if (!actor) throw new ForbiddenError('SESSION_ENDED');
    return actor;
  }

  /** Enter the code on the secure page: completes the sign-in or the payout request. Single use. */
  async confirm(token: string, challengeId: string, code: string, meta: { ip?: string } = {}) {
    const { h, context } = await this.live(token);
    if (h.purpose === 'LOGIN') {
      const s = await this.d.auth.verifyLogin({ challengeId, code, ...(meta.ip ? { ip: meta.ip } : {}) });
      const actor = await this.d.auth.actorForSession(s.sessionId);
      if (!actor) throw new ForbiddenError('SESSION_ENDED');
      await this.d.bus.execute(this.redeemCmd, { token, purpose: 'LOGIN', notice: { template: 'wa.notice.signed_in', params: {} } }, { actor });
      return { purpose: 'LOGIN' as const };
    }
    if (h.purpose === 'PAYOUT_REQUEST') {
      const actor = await this.sessionOf(h);
      const { stepUpToken } = await this.d.auth.verifyStepUp(actor, challengeId, code);
      const ccy = isCurrency(context['currency']) ? context['currency'] : 'USD';
      const purpose = (PAYOUT_PURPOSES as readonly string[]).includes(context['purpose'] ?? '') ? (context['purpose'] as PayoutPurpose) : 'OTHER_APPROVED';
      const amountMinor = BigInt(context['amountMinor'] ?? '0');
      // Same service + command as the web; the hand-off id makes it idempotent.
      const plan = await this.d.payouts.requestPayout(
        actor,
        {
          walletId: context['walletId'] ?? '',
          source: { kind: 'COMMUNITY' },
          currency: ccy,
          parts: [{ payeeId: context['payeeId'] ?? '', amountMinor, purpose }],
          idempotencyKey: `wa-handoff:${h.id}`,
        },
        stepUpToken,
      );
      const status = plan.payouts[0]?.status ?? 'REQUESTED';
      try {
        await this.d.bus.execute(
          this.redeemCmd,
          { token, purpose: 'PAYOUT_REQUEST', notice: { template: 'wa.notice.payout_requested', params: { amount: format(money(amountMinor, ccy)), status } } },
          { actor },
        );
      } catch (err) {
        // A concurrent confirm already used it: the request above was a replay.
        if (!(err instanceof ForbiddenError && err.message === 'HANDOFF_USED')) throw err;
      }
      return { purpose: 'PAYOUT_REQUEST' as const, planId: plan.planId, approvalId: plan.approvalId, status };
    }
    throw new ConflictError('HANDOFF_NO_CODE');
  }

  /** Context-only links (evidence upload, portal): consume and return where to go. */
  async open(token: string, actor: Actor) {
    const { h } = await this.live(token);
    if (h.purpose !== 'EVIDENCE' && h.purpose !== 'PORTAL') throw new ConflictError('HANDOFF_NEEDS_CODE');
    const r = await this.d.bus.execute(this.redeemCmd, { token, purpose: h.purpose }, { actor });
    return { purpose: h.purpose, walletId: r.context['walletId'] ?? null };
  }

  /** Conversation by phone (tests / ops): decoded, or null. */
  async conversationFor(phone: string) {
    const { rows } = await this.d.db.query<ConvRow>(`SELECT ${CONV_COLS} FROM wa_conversation WHERE phone_hash = $1`, [phoneHashOf(this.keys, phone)]);
    return rows[0] ? decodeConversation(this.keys, rows[0]) : null;
  }
}

export type { Locale };
