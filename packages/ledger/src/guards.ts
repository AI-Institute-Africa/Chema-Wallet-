// Pure journal checks (no I/O). The same rules are enforced again by the
// database triggers in migrations 0007/0008; this copy exists to fail early
// with a typed error, before anything is written.
import type { Currency } from '@chema/shared';
import {
  CrossSubLedgerError,
  CrossWalletError,
  LedgerValidationError,
  SubLedgerExitError,
  UnbalancedJournalError,
  UnknownAccountError,
} from './errors';
import { WALLET_EXIT_KINDS, type EntryInput, type LedgerAccount } from './types';

export interface JournalShape {
  /** The one wallet the journal touches, or null for a system-only journal. */
  walletId: string | null;
  /** Net debit per wallet account, only where the account loses value. */
  walletDebits: ReadonlyMap<string, bigint>;
}

export function validateJournal(
  entries: readonly EntryInput[],
  accounts: ReadonlyMap<string, LedgerAccount>,
  opts: { reversal?: boolean } = {},
): JournalShape {
  if (entries.length < 2) throw new LedgerValidationError('TOO_FEW_ENTRIES');

  const perCurrency = new Map<Currency, bigint>();
  const perWalletAccount = new Map<string, bigint>();
  const wallets = new Set<string>();
  const subLedgers = new Set<string>();
  const systemKinds = new Set<LedgerAccount['kind']>();

  for (const e of entries) {
    const account = accounts.get(e.accountId);
    if (!account) throw new UnknownAccountError(e.accountId);
    if (e.side !== 'D' && e.side !== 'C') throw new LedgerValidationError('BAD_SIDE');
    if (typeof e.amount.minor !== 'bigint' || e.amount.minor <= 0n) throw new LedgerValidationError('AMOUNT_NOT_POSITIVE');
    if (e.amount.ccy !== account.currency) throw new LedgerValidationError('CURRENCY_MISMATCH', account.currency);

    const signed = e.side === 'D' ? e.amount.minor : -e.amount.minor;
    perCurrency.set(account.currency, (perCurrency.get(account.currency) ?? 0n) + signed);
    if (account.walletId) {
      wallets.add(account.walletId);
      subLedgers.add(`${account.walletId}|${account.kind}|${account.qualifier ?? ''}`);
      perWalletAccount.set(account.id, (perWalletAccount.get(account.id) ?? 0n) + signed);
    } else {
      systemKinds.add(account.kind);
    }
  }

  for (const [ccy, total] of perCurrency) {
    if (total !== 0n) throw new UnbalancedJournalError(ccy);
  }
  if (wallets.size > 1) throw new CrossWalletError();
  if (subLedgers.size > 1) throw new CrossSubLedgerError();

  const walletDebits = new Map<string, bigint>();
  for (const [accountId, net] of perWalletAccount) {
    if (net > 0n) walletDebits.set(accountId, net);
  }

  // A reversal undoes a movement that was already allowed, so it is exempt.
  if (!opts.reversal && walletDebits.size > 0) {
    for (const kind of systemKinds) {
      if (!WALLET_EXIT_KINDS.has(kind)) throw new SubLedgerExitError(kind);
    }
  }

  const [walletId] = wallets;
  return { walletId: walletId ?? null, walletDebits };
}
