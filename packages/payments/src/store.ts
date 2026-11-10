// Payment row access and the single transition helper.
import { parseMinor, type Queryable } from '@chema/shared';
import { disclosureOf } from './fees';
import { canTransition, PAYMENT_COLUMNS, type PaymentRow, type PaymentState, type PaymentView, type StateSource } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: PaymentState,
    readonly to: PaymentState,
  ) {
    super(`illegal payment transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export async function loadPayment(q: Queryable, id: string, opts: { lock?: boolean } = {}): Promise<PaymentRow | undefined> {
  if (!isUuid(id)) return undefined;
  const { rows } = await q.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payment WHERE id = $1${opts.lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0];
}

export async function loadPaymentByProviderRef(
  q: Queryable,
  rail: string,
  providerRef: string,
  opts: { lock?: boolean } = {},
): Promise<PaymentRow | undefined> {
  const { rows } = await q.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payment WHERE rail = $1 AND provider_ref = $2${opts.lock ? ' FOR UPDATE' : ''}`,
    [rail, providerRef],
  );
  return rows[0];
}

export async function logState(
  q: Queryable,
  p: { id: string; from: PaymentState | null; to: PaymentState; source: StateSource; eventId?: string; detail?: string },
  now: Date,
): Promise<void> {
  await q.query(
    `INSERT INTO payment_state_log (payment_id, from_state, to_state, source, event_id, detail, at)
     VALUES ($1, $2, $3, $4, $5::uuid, $6, $7)`,
    [p.id, p.from, p.to, p.source, p.eventId ?? null, p.detail ?? null, now.toISOString()],
  );
}

/**
 * Move a (locked) payment to `to`, setting extra columns in the same UPDATE.
 * Checked here and again by the payment_guard trigger.
 */
export async function transition(
  q: Queryable,
  p: PaymentRow,
  to: PaymentState,
  source: StateSource,
  now: Date,
  set: Record<string, unknown> = {},
  log: { eventId?: string; detail?: string } = {},
): Promise<void> {
  if (!canTransition(p.state, to)) throw new IllegalTransitionError(p.state, to);
  const cols = Object.keys(set);
  for (const c of cols) if (!/^[a-z_]+$/.test(c)) throw new Error(`bad column ${c}`);
  const assignments = ['state = $2', 'updated_at = $3', ...cols.map((c, i) => `${c} = $${i + 4}`)];
  await q.query(`UPDATE payment SET ${assignments.join(', ')} WHERE id = $1`, [
    p.id,
    to,
    now.toISOString(),
    ...cols.map((c) => set[c]),
  ]);
  if (p.state !== to) await logState(q, { id: p.id, from: p.state, to, source, ...log }, now);
}

export function toView(p: PaymentRow): PaymentView {
  const m = (v: string) => ({ minor: parseMinor(v), ccy: p.currency });
  return {
    id: p.id,
    walletId: p.wallet_id,
    rail: p.rail,
    state: p.state,
    disclosure: disclosureOf({ gross: m(p.gross_minor), fee: m(p.fee_minor), net: m(p.net_minor), feePayer: p.fee_payer, fxRate: p.fx_rate }),
    next: p.state === 'INITIATED' || p.state === 'PENDING_UNKNOWN' ? p.next_action : null,
    receiptId: p.receipt_id,
    failureReason: p.failure_reason,
    createdAt: new Date(p.created_at).toISOString(),
  };
}
