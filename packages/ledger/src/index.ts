// @chema/ledger — append-only double-entry ledger (docs/04 §1 §2).
// Depends on @chema/shared and @chema/core only: never on channels, providers
// or Fidelity adapters.
export * from './errors';
export * from './types';
export {
  accountCode,
  bootstrapWalletAccounts,
  ensureGroupAccount,
  ensureSystemAccount,
  getAccount,
  getAccounts,
  listWalletAccounts,
  lockWallet,
  type WalletAccounts,
} from './accounts';
export { validateBenefitRules, validateJournal, type JournalShape } from './guards';
export { post, reverse } from './post';
export { reserve, release, type ReserveInput, type ReserveResult } from './reservations';
export { placeHold, releaseHold, type HoldInput } from './holds';
export {
  getBalances,
  getStatement,
  type PendingSource,
  type StatementEntry,
  type StatementJournal,
  type SubLedgerBalance,
} from './balances';
