// Test-only helpers. Never import from runtime code: `inTx` hands out a
// CommandTx without going through the CommandBus (no authorisation, no audit).
import { randomUUID } from 'node:crypto';
import { SYSTEM_ACTOR, type Actor, type CommandTx } from '@chema/core';
import { money, type Currency, type SqlClient } from '@chema/shared';
import { bootstrapWalletAccounts, ensureSystemAccount } from './accounts';
import { post } from './post';
import type { LedgerAccount, PostResult } from './types';

export const TEST_ACTOR: Actor = SYSTEM_ACTOR;
export const TEST_RAIL = 'MOCK';

/** Run ledger code in its own transaction, as a bus command handler would. */
export function inTx<T>(db: SqlClient, fn: (tx: CommandTx) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as CommandTx));
}

export interface SystemAccounts {
  providerClearing: LedgerAccount;
  payoutClearing: LedgerAccount;
  fees: LedgerAccount;
  refundClearing: LedgerAccount;
  suspense: LedgerAccount;
}

export function seedSystem(db: SqlClient, currency: Currency = 'USD'): Promise<SystemAccounts> {
  return inTx(db, async (tx) => ({
    providerClearing: await ensureSystemAccount(tx, 'PROVIDER_CLEARING', currency, TEST_RAIL),
    payoutClearing: await ensureSystemAccount(tx, 'PAYOUT_CLEARING', currency, TEST_RAIL),
    fees: await ensureSystemAccount(tx, 'FEES', currency),
    refundClearing: await ensureSystemAccount(tx, 'REFUND_CLEARING', currency),
    suspense: await ensureSystemAccount(tx, 'SUSPENSE_UNMATCHED', currency),
  }));
}

export interface TestWallet {
  walletId: string;
  community: LedgerAccount;
  fidelityBenefit: LedgerAccount;
}

/** A fresh wallet id with its two standard sub-ledgers. */
export async function seedWallet(db: SqlClient, currency: Currency = 'USD'): Promise<TestWallet> {
  const walletId = randomUUID();
  const accounts = await inTx(db, (tx) => bootstrapWalletAccounts(tx, walletId, currency));
  return { walletId, ...accounts };
}

/** Confirmed incoming money: DR provider clearing / CR the wallet account. */
export function creditWallet(
  db: SqlClient,
  sys: SystemAccounts,
  account: LedgerAccount,
  minor: bigint,
  idempotencyKey: string = `test:${randomUUID()}`,
): Promise<PostResult> {
  const amount = money(minor, account.currency);
  return inTx(db, (tx) =>
    post(tx, TEST_ACTOR, {
      idempotencyKey,
      kind: account.kind === 'FIDELITY_BENEFIT' ? 'BENEFIT' : 'CONTRIBUTION',
      entries: [
        { accountId: sys.providerClearing.id, side: 'D', amount },
        { accountId: account.id, side: 'C', amount },
      ],
    }),
  );
}
