import { ConflictError, NotFoundError, ValidationError } from '@chema/core';
import type { Queryable } from '@chema/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

export function requireUuid(v: unknown, what: string): string {
  if (!isUuid(v)) throw new NotFoundError(what, String(v));
  return v;
}

/** Written reasons for human decisions: 10-1000 chars after trimming. */
export function note(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < 10 || s.length > 1000) throw new ConflictError('REASON_REQUIRED');
  return s;
}

export function iso(d: Date | string | null): string | null {
  return d === null ? null : new Date(d).toISOString();
}

export async function walletExists(q: Queryable, walletId: string): Promise<string> {
  if (!isUuid(walletId)) throw new NotFoundError('wallet', String(walletId));
  const { rows } = await q.query<{ id: string }>('SELECT id FROM wallet WHERE id = $1', [walletId]);
  if (!rows[0]) throw new NotFoundError('wallet', walletId);
  return rows[0].id;
}

export function bounded(n: unknown, lo: number, hi: number, dflt: number): number {
  if (n === undefined) return dflt;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) throw new ValidationError('out of range');
  return n;
}
