// Fee and FX quote (docs/04 §6, D08). No fee is hard-coded: `fees.enabled`
// off or an empty fee_schedule ⇒ zero fee and no fee copy. Integer maths only.
import type { FlagService } from '@chema/core';
import { money, parseMinor, type Currency, type Money, type Queryable } from '@chema/shared';
import type { FeeDisclosure } from './types';

export interface Quote {
  gross: Money;
  fee: Money;
  net: Money;
  feePayer: 'CONTRIBUTOR' | 'WALLET' | null;
  fxRate: string | null;
  settlementCurrency: Currency;
}

interface ScheduleRow {
  fee_payer: 'CONTRIBUTOR' | 'WALLET';
  fixed_minor: string;
  rate_bps: number;
}

/**
 * `amount` is what the contributor wants to give. If the contributor pays the
 * fee it is added on top (gross = amount + fee, net = amount); if the wallet
 * bears it, it comes out of the gift (gross = amount, net = amount − fee).
 */
export async function quoteFees(q: Queryable, flags: FlagService, rail: string, amount: Money, now: Date): Promise<Quote> {
  const none: Quote = { gross: amount, fee: money(0n, amount.ccy), net: amount, feePayer: null, fxRate: null, settlementCurrency: amount.ccy };
  if (!(await flags.getIn(q, 'fees.enabled'))) return none;
  const { rows } = await q.query<ScheduleRow>(
    `SELECT fee_payer, fixed_minor::text AS fixed_minor, rate_bps FROM fee_schedule
      WHERE rail = $1 AND currency = $2 AND effective_from <= $3
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
    [rail, amount.ccy, now.toISOString()],
  );
  const row = rows[0];
  if (!row) return none;
  const feeMinor = parseMinor(row.fixed_minor) + (amount.minor * BigInt(row.rate_bps)) / 10_000n;
  if (feeMinor === 0n) return none;
  if (row.fee_payer === 'CONTRIBUTOR') {
    return { ...none, gross: money(amount.minor + feeMinor, amount.ccy), fee: money(feeMinor, amount.ccy), feePayer: 'CONTRIBUTOR' };
  }
  if (feeMinor >= amount.minor) throw new FeeExceedsAmountError();
  return { ...none, fee: money(feeMinor, amount.ccy), net: money(amount.minor - feeMinor, amount.ccy), feePayer: 'WALLET' };
}

export class FeeExceedsAmountError extends Error {
  constructor() {
    super('fee would consume the whole contribution');
    this.name = 'FeeExceedsAmountError';
  }
}

export function disclosureOf(q: Pick<Quote, 'gross' | 'fee' | 'net' | 'feePayer' | 'fxRate'>): FeeDisclosure {
  return { totalCharged: q.gross, feePayer: q.feePayer, providerFee: q.fee, fxRate: q.fxRate, expectedCredit: q.net };
}
