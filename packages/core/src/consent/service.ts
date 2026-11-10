// Consent (docs/10): grant / withdraw / query by purpose. Withdrawal keeps the
// record (sets withdrawn_at once) and later phases suppress public content off
// `hasConsent`. All writes go through the CommandBus (authorised + audited).
import type { Queryable } from '@chema/shared';
import type { Command } from '../command/bus';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { one } from '../db';

export const CONSENT_PURPOSES = ['PHOTO', 'NAME', 'TRIBUTE', 'NOTIFY', 'MARKETING', 'DISCLOSURE'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export function isConsentPurpose(v: string): v is ConsentPurpose {
  return (CONSENT_PURPOSES as readonly string[]).includes(v);
}

export interface ConsentView {
  id: string;
  purpose: ConsentPurpose;
  walletId: string | null;
  givenBy: string;
  ts: Date;
  withdrawnAt: Date | null;
}

interface ConsentRow {
  id: string;
  subject_person: string;
  purpose: ConsentPurpose;
  wallet_id: string | null;
  given_by: string;
  ts: Date;
  withdrawn_at: Date | null;
}

const view = (r: ConsentRow): ConsentView => ({
  id: r.id,
  purpose: r.purpose,
  walletId: r.wallet_id,
  givenBy: r.given_by,
  ts: r.ts,
  withdrawnAt: r.withdrawn_at,
});

/** Live consent for a purpose (optionally scoped to a wallet). Read-only helper for services. */
export async function hasConsent(q: Queryable, personId: string, purpose: ConsentPurpose, walletId?: string): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM consent_record
      WHERE subject_person = $1 AND purpose = $2 AND withdrawn_at IS NULL
        AND wallet_id IS NOT DISTINCT FROM $3::uuid`,
    [personId, purpose, walletId ?? null],
  );
  return rows.length > 0;
}

export interface GrantInput {
  subjectPersonId: string;
  purpose: string;
  walletId?: string;
}

export const grantConsent: Command<GrantInput, ConsentView> = {
  name: 'consent.grant',
  async resolve(_q, input) {
    if (!isConsentPurpose(input.purpose)) throw new ValidationError('unknown consent purpose');
    return {
      action: 'consent.manage',
      subject: { type: 'person', id: input.subjectPersonId, ownerPersonId: input.subjectPersonId },
    };
  },
  async run(tx, input, ctx) {
    const existing = await tx.query<ConsentRow>(
      `SELECT id, subject_person, purpose, wallet_id, given_by, ts, withdrawn_at FROM consent_record
        WHERE subject_person = $1 AND purpose = $2 AND withdrawn_at IS NULL AND wallet_id IS NOT DISTINCT FROM $3::uuid`,
      [input.subjectPersonId, input.purpose, input.walletId ?? null],
    );
    const live = existing.rows[0];
    if (live) return { result: view(live), audit: { subjectId: live.id, reasonCode: 'ALREADY_GRANTED' } };
    const { rows } = await tx.query<ConsentRow>(
      `INSERT INTO consent_record (subject_person, purpose, wallet_id, given_by, channel)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, subject_person, purpose, wallet_id, given_by, ts, withdrawn_at`,
      [input.subjectPersonId, input.purpose, input.walletId ?? null, ctx.actor.personId, ctx.actor.channel],
    );
    const row = one(rows, 'consent insert');
    return { result: view(row), audit: { subjectId: row.id, after: { purpose: row.purpose, walletId: row.wallet_id } } };
  },
};

export const withdrawConsent: Command<{ consentId: string }, ConsentView> = {
  name: 'consent.withdraw',
  async resolve(q, input) {
    if (!/^[0-9a-f-]{36}$/i.test(input.consentId)) throw new NotFoundError('consent_record', input.consentId);
    const { rows } = await q.query<{ subject_person: string; wallet_id: string | null }>(
      'SELECT subject_person, wallet_id FROM consent_record WHERE id = $1',
      [input.consentId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('consent_record', input.consentId);
    return {
      action: 'consent.manage',
      subject: { type: 'consent_record', id: input.consentId, ownerPersonId: row.subject_person },
    };
  },
  async run(tx, input, ctx) {
    const { rows } = await tx.query<ConsentRow>(
      `UPDATE consent_record SET withdrawn_at = now(), withdrawn_by = $2
        WHERE id = $1 AND withdrawn_at IS NULL
        RETURNING id, subject_person, purpose, wallet_id, given_by, ts, withdrawn_at`,
      [input.consentId, ctx.actor.personId],
    );
    const row = rows[0];
    if (!row) throw new ConflictError('ALREADY_WITHDRAWN');
    return { result: view(row), audit: { before: { withdrawn: false }, after: { withdrawn: true } } };
  },
};

/** Consent history for a person (live + withdrawn). Read via the bus for access logging. */
export const listConsents: Command<{ subjectPersonId: string; purpose?: string }, ConsentView[]> = {
  name: 'consent.list',
  async resolve(_q, input) {
    if (input.purpose !== undefined && !isConsentPurpose(input.purpose)) throw new ValidationError('unknown consent purpose');
    return {
      action: 'consent.view',
      subject: { type: 'person', id: input.subjectPersonId, ownerPersonId: input.subjectPersonId },
    };
  },
  async run(tx, input) {
    const { rows } = await tx.query<ConsentRow>(
      `SELECT id, subject_person, purpose, wallet_id, given_by, ts, withdrawn_at FROM consent_record
        WHERE subject_person = $1 AND ($2::text IS NULL OR purpose = $2) ORDER BY ts, id`,
      [input.subjectPersonId, input.purpose ?? null],
    );
    return { result: rows.map(view) };
  },
};
