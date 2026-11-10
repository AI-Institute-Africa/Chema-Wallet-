// In-process mock rails (docs/04 §5): MockEcoCash, MockOneMoney, MockCard.
// A MockRail is both the adapter (what the payments service calls) and a
// simulated provider back office (what tests drive): it keeps its own book of
// collections, emits HMAC-signed callbacks and produces settlement reports.
//
// Scenario switches reproduce the docs/14 §P cases: delay, duplicate callback,
// timeout, outage, partial settlement, fee variance, wrong destination,
// chargeback, refund failure.
import { randomUUID } from 'node:crypto';
import { isCurrency, money, type Money } from '@chema/shared';
import type {
  AdapterMode,
  CollectRequest,
  CollectResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderEventType,
  ProviderStatus,
  RefundResult,
  SettlementRow,
} from './adapter';
import { PROVIDER_EVENT_TYPES } from './adapter';
import { ProviderRejectedError, ProviderTimeoutError, ProviderUnavailableError, WebhookRejectedError } from './errors';
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from './signature';

export interface MockScenario {
  /** collect() fails before reaching the provider. */
  outage?: boolean;
  /** collect() is accepted by the provider but the answer never arrives. */
  timeout?: boolean;
  /** collect() is refused by the provider. */
  reject?: boolean;
  /** Callbacks become deliverable this many ms after they are produced. */
  callbackDelayMs?: number;
  /** Extra identical deliveries of every callback (same event id). */
  duplicateCallbacks?: number;
  /** Confirmation amount = requested + delta (negative ⇒ payer paid less). */
  confirmDeltaMinor?: bigint;
  /** Provider fee reported on confirmation and settlement. */
  providerFeeMinor?: bigint;
  /** Settlement gross = confirmed − this (partial settlement). */
  settleShortMinor?: bigint;
  /** Callbacks name a different merchant account. */
  wrongMerchant?: boolean;
  /** Refunds are refused asynchronously (REFUND_FAILED). */
  refundFails?: boolean;
}

export interface MockWebhook {
  headers: Record<string, string>;
  body: string;
  event: ProviderEvent;
}

interface BookEntry {
  providerRef: string;
  reference: string;
  amount: Money;
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  confirmed?: Money;
  fee?: Money;
}

interface Queued extends MockWebhook {
  dueAt: number;
}

export interface MockRailOptions {
  rail: string;
  merchantRef?: string;
  webhookSecret: string;
  mode?: AdapterMode;
  /** Redirect checkout (card) vs handset prompt (mobile money). */
  checkout?: 'REDIRECT' | 'PROMPT';
  clock?: () => Date;
}

export class MockRail implements ProviderAdapter {
  readonly rail: string;
  readonly mode: AdapterMode;
  readonly merchantRef: string;
  scenario: MockScenario = {};
  /** Every collect/refund/payout call, for assertions. */
  readonly calls: { op: string; reference: string }[] = [];

  private readonly secret: string;
  private readonly checkout: 'REDIRECT' | 'PROMPT';
  private readonly clock: () => Date;
  private readonly book = new Map<string, BookEntry>();
  private readonly byReference = new Map<string, string>();
  private readonly refunds = new Map<string, { paymentRef: string; amount: Money }>();
  private readonly settlements = new Map<string, SettlementRow[]>();
  private queue: Queued[] = [];
  private seq = 0;

  constructor(opts: MockRailOptions) {
    this.rail = opts.rail;
    this.mode = opts.mode ?? 'MOCK';
    this.merchantRef = opts.merchantRef ?? `MERCHANT-${opts.rail}`;
    this.secret = opts.webhookSecret;
    this.checkout = opts.checkout ?? 'PROMPT';
    this.clock = opts.clock ?? (() => new Date());
  }

  // ── Adapter ────────────────────────────────────────────────────────────
  async collect(req: CollectRequest): Promise<CollectResult> {
    this.calls.push({ op: 'collect', reference: req.reference });
    if (this.scenario.outage) throw new ProviderUnavailableError('mock outage');
    if (this.scenario.reject) throw new ProviderRejectedError('mock reject');
    const existing = this.byReference.get(req.reference);
    const providerRef = existing ?? `${this.rail}-${++this.seq}-${randomUUID().slice(0, 8)}`;
    if (!existing) {
      this.book.set(providerRef, { providerRef, reference: req.reference, amount: req.amount, state: 'PENDING' });
      this.byReference.set(req.reference, providerRef);
    }
    if (this.scenario.timeout) throw new ProviderTimeoutError();
    const next =
      this.checkout === 'REDIRECT'
        ? { type: 'REDIRECT' as const, url: `https://checkout.mock.invalid/${this.rail.toLowerCase()}/${providerRef}` }
        : { type: 'PROMPT' as const, message: 'Approve the payment prompt on your phone.' };
    return { providerRef, next };
  }

  async queryStatus(q: { providerRef?: string; reference: string }): Promise<ProviderStatus> {
    if (this.scenario.outage) throw new ProviderUnavailableError('mock outage');
    const ref = q.providerRef ?? this.byReference.get(q.reference);
    const e = ref ? this.book.get(ref) : undefined;
    if (!e) return { state: 'NOT_FOUND' };
    switch (e.state) {
      case 'PENDING':
        return { state: 'PENDING' };
      case 'SUCCEEDED':
        return {
          state: 'SUCCEEDED',
          providerRef: e.providerRef,
          amount: e.confirmed ?? e.amount,
          fee: e.fee ?? money(0n, e.amount.ccy),
          merchantRef: this.callbackMerchant(),
        };
      case 'FAILED':
        return { state: 'FAILED', providerRef: e.providerRef, reason: 'declined' };
      case 'EXPIRED':
        return { state: 'EXPIRED', providerRef: e.providerRef };
    }
  }

  verifyWebhook(headers: Readonly<Record<string, string | undefined>>, rawBody: string, now: Date): ProviderEvent {
    verifySignature(this.secret, headers, rawBody, now);
    return parseMockEvent(rawBody);
  }

  async payout(req: { reference: string }): Promise<{ providerRef: string }> {
    this.calls.push({ op: 'payout', reference: req.reference });
    if (this.scenario.outage) throw new ProviderUnavailableError('mock outage');
    return { providerRef: `${this.rail}-PO-${++this.seq}` };
  }

  async refund(q: { providerRef: string; amount: Money; reference: string }): Promise<RefundResult> {
    this.calls.push({ op: 'refund', reference: q.reference });
    if (this.scenario.outage) throw new ProviderUnavailableError('mock outage');
    const e = this.book.get(q.providerRef);
    if (!e || e.state !== 'SUCCEEDED') throw new ProviderRejectedError('not refundable');
    const refundRef = `${this.rail}-RF-${++this.seq}`;
    this.refunds.set(refundRef, { paymentRef: q.providerRef, amount: q.amount });
    this.emit(this.scenario.refundFails ? 'REFUND_FAILED' : 'REFUND_SUCCEEDED', e, {
      amount: q.amount,
      refundRef,
      ...(this.scenario.refundFails ? { reason: 'mock refund refused' } : {}),
    });
    return { providerRef: refundRef };
  }

  async settlementReport(date: string): Promise<SettlementRow[]> {
    if (this.scenario.outage) throw new ProviderUnavailableError('mock outage');
    return [...(this.settlements.get(date) ?? [])];
  }

  // ── Simulated provider back office (test driver) ────────────────────────
  /** The payer approved: book it, queue the success callback, add a settlement row. */
  succeed(providerRef: string, settlementDate = isoDate(this.clock())): void {
    const e = this.mustGet(providerRef);
    const delta = this.scenario.confirmDeltaMinor ?? 0n;
    e.state = 'SUCCEEDED';
    e.confirmed = money(e.amount.minor + delta, e.amount.ccy);
    e.fee = money(this.scenario.providerFeeMinor ?? 0n, e.amount.ccy);
    const settledGross = e.confirmed.minor - (this.scenario.settleShortMinor ?? 0n);
    if (settledGross > 0n) {
      this.addSettlementRow(settlementDate, {
        providerRef,
        gross: money(settledGross, e.amount.ccy),
        fee: e.fee,
        merchantRef: this.merchantRef,
      });
    }
    this.emit('PAYMENT_SUCCEEDED', e, { amount: e.confirmed, fee: e.fee });
  }

  fail(providerRef: string, reason = 'declined'): void {
    const e = this.mustGet(providerRef);
    e.state = 'FAILED';
    this.emit('PAYMENT_FAILED', e, { reason });
  }

  expire(providerRef: string): void {
    const e = this.mustGet(providerRef);
    e.state = 'EXPIRED';
    this.emit('PAYMENT_EXPIRED', e, {});
  }

  openDispute(providerRef: string, amount: Money, disputeRef = `${this.rail}-DP-${++this.seq}`): string {
    this.emit('DISPUTE_OPENED', this.mustGet(providerRef), { amount, disputeRef });
    return disputeRef;
  }

  chargeback(providerRef: string, amount: Money, disputeRef: string): void {
    this.emit('CHARGEBACK', this.mustGet(providerRef), { amount, disputeRef });
  }

  winDispute(providerRef: string, disputeRef: string): void {
    this.emit('DISPUTE_WON', this.mustGet(providerRef), { disputeRef });
  }

  /** Money the provider settled to us that we may know nothing about. */
  addSettlementRow(date: string, row: SettlementRow): void {
    const rows = this.settlements.get(date) ?? [];
    rows.push(row);
    this.settlements.set(date, rows);
  }

  providerRefFor(reference: string): string | undefined {
    return this.byReference.get(reference);
  }

  /** Callbacks deliverable now (removed from the queue). */
  takeWebhooks(now: Date = this.clock()): MockWebhook[] {
    const due = this.queue.filter((q) => q.dueAt <= now.getTime());
    this.queue = this.queue.filter((q) => q.dueAt > now.getTime());
    return due.map(({ headers, body, event }) => ({ headers, body, event }));
  }

  /** Sign an arbitrary body as this provider would (for replay/forgery tests). */
  signBody(body: string, at: Date = this.clock()): Record<string, string> {
    const ts = (BigInt(at.getTime()) / 1000n).toString();
    return { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: sign(this.secret, ts, body), 'content-type': 'application/json' };
  }

  private callbackMerchant(): string {
    return this.scenario.wrongMerchant ? 'MERCHANT-SOMEONE-ELSE' : this.merchantRef;
  }

  private mustGet(providerRef: string): BookEntry {
    const e = this.book.get(providerRef);
    if (!e) throw new Error(`mock ${this.rail}: unknown providerRef ${providerRef}`);
    return e;
  }

  private emit(
    type: ProviderEventType,
    e: BookEntry,
    extra: { amount?: Money; fee?: Money; refundRef?: string; disputeRef?: string; reason?: string },
  ): void {
    const now = this.clock();
    const event: ProviderEvent = {
      eventId: `${this.rail}-EV-${++this.seq}-${randomUUID().slice(0, 8)}`,
      type,
      providerRef: e.providerRef,
      reference: e.reference,
      merchantRef: this.callbackMerchant(),
      ...extra,
      occurredAt: now.toISOString(),
    };
    const body = JSON.stringify(toWire(event));
    const dueAt = now.getTime() + (this.scenario.callbackDelayMs ?? 0);
    const copies = 1 + (this.scenario.duplicateCallbacks ?? 0);
    for (let i = 0; i < copies; i++) {
      // Each delivery is signed when it is sent (fresh timestamp), like a real retrying provider.
      this.queue.push({ headers: this.signBody(body, new Date(dueAt)), body, event, dueAt });
    }
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface WireMoney {
  minor: string;
  ccy: string;
}

function toWire(e: ProviderEvent) {
  const m = (x: Money | undefined): WireMoney | undefined => (x ? { minor: x.minor.toString(), ccy: x.ccy } : undefined);
  return {
    id: e.eventId,
    type: e.type,
    provider_ref: e.providerRef,
    reference: e.reference,
    merchant: e.merchantRef,
    amount: m(e.amount),
    fee: m(e.fee),
    refund_ref: e.refundRef,
    dispute_ref: e.disputeRef,
    reason: e.reason,
    occurred_at: e.occurredAt,
  };
}

const MINOR_RE = /^(0|[1-9][0-9]{0,17})$/;

function wireMoney(v: unknown): Money | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') throw new WebhookRejectedError('MALFORMED');
  const { minor, ccy } = v as Record<string, unknown>;
  if (typeof minor !== 'string' || !MINOR_RE.test(minor) || !isCurrency(ccy)) throw new WebhookRejectedError('MALFORMED');
  return money(BigInt(minor), ccy);
}

function str(v: unknown, max = 128): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new WebhookRejectedError('MALFORMED');
  return v;
}

/** Parse the mock wire format. Throws WebhookRejectedError('MALFORMED'). */
export function parseMockEvent(rawBody: string): ProviderEvent {
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    o = parsed as Record<string, unknown>;
  } catch {
    throw new WebhookRejectedError('MALFORMED');
  }
  const type = o['type'];
  if (typeof type !== 'string' || !(PROVIDER_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new WebhookRejectedError('MALFORMED');
  }
  const eventId = str(o['id']);
  const providerRef = str(o['provider_ref']);
  const merchantRef = str(o['merchant']);
  const occurredAt = str(o['occurred_at'], 40);
  if (!eventId || !providerRef || !merchantRef || !occurredAt) throw new WebhookRejectedError('MALFORMED');
  const reference = str(o['reference']);
  const amount = wireMoney(o['amount']);
  const fee = wireMoney(o['fee']);
  const refundRef = str(o['refund_ref']);
  const disputeRef = str(o['dispute_ref']);
  const reason = str(o['reason'], 500);
  return {
    eventId,
    type: type as ProviderEventType,
    providerRef,
    merchantRef,
    occurredAt,
    ...(reference ? { reference } : {}),
    ...(amount ? { amount } : {}),
    ...(fee ? { fee } : {}),
    ...(refundRef ? { refundRef } : {}),
    ...(disputeRef ? { disputeRef } : {}),
    ...(reason ? { reason } : {}),
  };
}

type RailOpts = Omit<MockRailOptions, 'rail' | 'checkout'>;

export class MockEcoCash extends MockRail {
  constructor(opts: RailOpts) {
    super({ ...opts, rail: 'ECOCASH', checkout: 'PROMPT' });
  }
}

export class MockOneMoney extends MockRail {
  constructor(opts: RailOpts) {
    super({ ...opts, rail: 'ONEMONEY', checkout: 'PROMPT' });
  }
}

export class MockCard extends MockRail {
  constructor(opts: RailOpts) {
    super({ ...opts, rail: 'CARD', checkout: 'REDIRECT' });
  }
}
