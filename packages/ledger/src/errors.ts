// Ledger errors. Every one is thrown BEFORE the ledger writes anything, so a
// caller may catch it and carry on in the same transaction. Messages carry ids
// and amounts only, never PII.

export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed input (bad key, empty journal, wrong currency, missing reason…). */
export class LedgerValidationError extends LedgerError {
  constructor(code: string, detail?: string) {
    super(code, detail ? `invalid ledger request: ${code} (${detail})` : `invalid ledger request: ${code}`);
  }
}

export class UnknownAccountError extends LedgerError {
  constructor(readonly accountId: string) {
    super('UNKNOWN_ACCOUNT', 'ledger account not found');
  }
}

export class UnknownWalletError extends LedgerError {
  constructor(readonly walletId: string) {
    super('UNKNOWN_WALLET', 'wallet has no ledger accounts');
  }
}

export class UnknownJournalError extends LedgerError {
  constructor(readonly journalId: string) {
    super('UNKNOWN_JOURNAL', 'ledger journal not found');
  }
}

export class UnbalancedJournalError extends LedgerError {
  constructor(readonly currency: string) {
    super('UNBALANCED', `journal does not balance in ${currency}`);
  }
}

/** A journal may touch one wallet only (docs/04 §2). */
export class CrossWalletError extends LedgerError {
  constructor() {
    super('CROSS_WALLET', 'a journal cannot move value across wallets');
  }
}

/** Community, benefit and group money never mix inside a wallet either. */
export class CrossSubLedgerError extends LedgerError {
  constructor() {
    super('CROSS_SUB_LEDGER', 'a journal cannot move value between sub-ledgers of a wallet');
  }
}

/** Wallet money may leave only to fees, refund clearing or payout clearing. */
export class SubLedgerExitError extends LedgerError {
  constructor(readonly accountKind: string) {
    super('EXIT_NOT_ALLOWED', `wallet funds cannot move to ${accountKind}`);
  }
}

export class InsufficientFundsError extends LedgerError {
  constructor(
    readonly accountId: string,
    readonly requestedMinor: bigint,
    readonly availableMinor: bigint,
  ) {
    super('INSUFFICIENT_FUNDS', 'amount exceeds the available balance');
  }
}

/** The idempotency key was already used for different content. */
export class IdempotencyConflictError extends LedgerError {
  constructor(readonly idempotencyKey: string) {
    super('IDEMPOTENCY_CONFLICT', 'idempotency key reused with different content');
  }
}

export class AlreadyReversedError extends LedgerError {
  constructor(readonly journalId: string) {
    super('ALREADY_REVERSED', 'journal was already reversed');
  }
}

export class ReservationStateError extends LedgerError {
  constructor(
    readonly reservationId: string,
    readonly state: 'NOT_FOUND' | 'RELEASED' | 'CONSUMED' | 'MISMATCH',
  ) {
    super(`RESERVATION_${state}`, `reservation cannot be used: ${state}`);
  }
}

export class UnknownHoldError extends LedgerError {
  constructor(readonly holdId: string) {
    super('UNKNOWN_HOLD', 'hold not found');
  }
}

/** The books disagree with themselves. Never expected; never swallowed. */
export class LedgerInvariantError extends LedgerError {
  constructor(detail: string) {
    super('INVARIANT', `ledger invariant broken: ${detail}`);
  }
}
