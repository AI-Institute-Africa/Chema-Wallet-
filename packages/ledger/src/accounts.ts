// Ledger accounts: per-wallet sub-ledgers and system accounts (docs/04 §2),
// plus the wallet lock every balance-reducing operation takes first.
import type { CommandTx } from '@chema/core';
import type { Currency, Queryable } from '@chema/shared';
import { isCurrency } from '@chema/shared';
import { LedgerError, LedgerValidationError, UnknownAccountError, UnknownWalletError } from './errors';
import {
  SYSTEM_ACCOUNT_KINDS,
  type AccountKind,
  type LedgerAccount,
  type SystemAccountKind,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RAIL_RE = /^[A-Z][A-Z0-9_]{1,31}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** `$a, $b, …` for n parameters starting at position `from`. */
export function placeholders(n: number, from = 1): string {
  return Array.from({ length: n }, (_, i) => `$${from + i}`).join(', ');
}

interface AccountRow {
  id: string;
  wallet_id: string | null;
  kind: AccountKind;
  qualifier: string | null;
  currency: Currency;
}

const SELECT = 'SELECT id, wallet_id, kind, qualifier, currency FROM ledger_account';

function toAccount(r: AccountRow): LedgerAccount {
  return { id: r.id, walletId: r.wallet_id, kind: r.kind, qualifier: r.qualifier, currency: r.currency };
}

/** Human-readable account code, e.g. `W:COMMUNITY`, `W:GROUP:<id>`, `SYS:PROVIDER_CLEARING:ECOCASH`. */
export function accountCode(a: Pick<LedgerAccount, 'walletId' | 'kind' | 'qualifier'>): string {
  const name = a.qualifier ? `${a.kind}:${a.qualifier}` : a.kind;
  return `${a.walletId ? 'W' : 'SYS'}:${name}`;
}

async function ensure(
  tx: CommandTx,
  walletId: string | null,
  kind: AccountKind,
  qualifier: string | null,
  currency: Currency,
): Promise<LedgerAccount> {
  if (!isCurrency(currency)) throw new LedgerValidationError('BAD_CURRENCY');
  await tx.query(
    `INSERT INTO ledger_account (wallet_id, kind, qualifier, currency)
     VALUES ($1::uuid, $2, $3::text, $4) ON CONFLICT DO NOTHING`,
    [walletId, kind, qualifier, currency],
  );
  const { rows } = await tx.query<AccountRow>(
    `${SELECT} WHERE wallet_id IS NOT DISTINCT FROM $1::uuid AND kind = $2
       AND qualifier IS NOT DISTINCT FROM $3::text AND currency = $4`,
    [walletId, kind, qualifier, currency],
  );
  const row = rows[0];
  if (!row) throw new LedgerError('ACCOUNT_NOT_CREATED', 'ledger account could not be created');
  return toAccount(row);
}

export interface WalletAccounts {
  community: LedgerAccount;
  fidelityBenefit: LedgerAccount;
}

/**
 * Create the wallet's COMMUNITY and FIDELITY_BENEFIT sub-ledgers in one
 * currency. Idempotent. Group sub-ledgers are added by ensureGroupAccount.
 */
export async function bootstrapWalletAccounts(
  tx: CommandTx,
  walletId: string,
  currency: Currency,
): Promise<WalletAccounts> {
  if (!isUuid(walletId)) throw new LedgerValidationError('BAD_WALLET_ID');
  return {
    community: await ensure(tx, walletId, 'COMMUNITY', null, currency),
    fidelityBenefit: await ensure(tx, walletId, 'FIDELITY_BENEFIT', null, currency),
  };
}

export async function ensureGroupAccount(
  tx: CommandTx,
  walletId: string,
  groupId: string,
  currency: Currency,
): Promise<LedgerAccount> {
  if (!isUuid(walletId)) throw new LedgerValidationError('BAD_WALLET_ID');
  if (!GROUP_RE.test(groupId)) throw new LedgerValidationError('BAD_GROUP_ID');
  return ensure(tx, walletId, 'GROUP', groupId, currency);
}

/**
 * System account, created on first use. `rail` is required for
 * PROVIDER_CLEARING / PAYOUT_CLEARING and refused for the others.
 */
export async function ensureSystemAccount(
  tx: CommandTx,
  kind: SystemAccountKind,
  currency: Currency,
  rail?: string,
): Promise<LedgerAccount> {
  if (!(SYSTEM_ACCOUNT_KINDS as readonly string[]).includes(kind)) throw new LedgerValidationError('BAD_ACCOUNT_KIND');
  const perRail = kind === 'PROVIDER_CLEARING' || kind === 'PAYOUT_CLEARING';
  if (perRail !== (rail !== undefined)) throw new LedgerValidationError(perRail ? 'RAIL_REQUIRED' : 'RAIL_NOT_ALLOWED');
  if (rail !== undefined && !RAIL_RE.test(rail)) throw new LedgerValidationError('BAD_RAIL');
  return ensure(tx, null, kind, rail ?? null, currency);
}

export async function getAccount(q: Queryable, accountId: string): Promise<LedgerAccount> {
  const found = (await getAccounts(q, [accountId])).get(accountId);
  if (!found) throw new UnknownAccountError(accountId);
  return found;
}

/** Accounts by id. Unknown or malformed ids are simply absent from the map. */
export async function getAccounts(q: Queryable, accountIds: readonly string[]): Promise<Map<string, LedgerAccount>> {
  const ids = [...new Set(accountIds)].filter(isUuid);
  const out = new Map<string, LedgerAccount>();
  if (ids.length === 0) return out;
  const { rows } = await q.query<AccountRow>(`${SELECT} WHERE id IN (${placeholders(ids.length)})`, ids);
  for (const r of rows) out.set(r.id, toAccount(r));
  return out;
}

export async function listWalletAccounts(q: Queryable, walletId: string): Promise<LedgerAccount[]> {
  if (!isUuid(walletId)) return [];
  const { rows } = await q.query<AccountRow>(
    `${SELECT} WHERE wallet_id = $1 ORDER BY kind, qualifier NULLS FIRST, currency`,
    [walletId],
  );
  return rows.map(toAccount);
}

/**
 * Serialise balance-reducing work on one wallet: row-locks all its accounts
 * until the transaction ends. Everything that debits a wallet account,
 * reserves funds or places a hold calls this BEFORE reading balances.
 *
 * The lock is only sound under READ COMMITTED (each later statement then sees
 * what the previous lock holder committed), so any other level is refused.
 * Credits do not take it: concurrent contributions never queue.
 */
export async function lockWallet(tx: Queryable, walletId: string): Promise<LedgerAccount[]> {
  if (!isUuid(walletId)) throw new UnknownWalletError(String(walletId));
  const { rows } = await tx.query<AccountRow & { iso: string }>(
    `SELECT id, wallet_id, kind, qualifier, currency, current_setting('transaction_isolation') AS iso
       FROM ledger_account WHERE wallet_id = $1 ORDER BY id FOR NO KEY UPDATE`,
    [walletId],
  );
  const first = rows[0];
  if (!first) throw new UnknownWalletError(walletId);
  if (first.iso !== 'read committed') {
    throw new LedgerError('ISOLATION', `ledger writes need READ COMMITTED, got ${first.iso}`);
  }
  return rows.map(toAccount);
}
