// "Sign out everywhere" (docs/10 account compromise, docs/14 §S8). Both run
// through the bus, so each is authorised and audited:
// - a customer ends every one of their own customer sessions (this one too);
// - a FIDELITY_ADMIN (MFA, portal only, written reason) ends every customer
//   session of a person whose account is suspected compromised.
// Step-up grants die with their sessions. Staff sessions are not touched here:
// a compromised staff account is disabled (`staff.set_disabled`), which already
// ends its sessions.
import type { Command } from '../command/bus';
import { ConflictError, NotFoundError } from '../errors';
import { revokeAllSessions, type Clock } from './sessions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RevokeResult {
  revoked: number;
}

export interface RevokePersonInput {
  personId: string;
  /** Written reason, 10-1000 characters (kept as a hash in the audit row). */
  reason: string;
}

export function sessionCommands(clock: Clock) {
  const signOutEverywhere: Command<Record<string, never>, RevokeResult> = {
    name: 'identity.sign_out_everywhere',
    async resolve(_q, _input, actor) {
      return { action: 'session.revoke_own', subject: { type: 'person', id: actor.personId, ownerPersonId: actor.personId } };
    },
    async run(tx, _input, ctx) {
      const ids = await revokeAllSessions(tx, ctx.actor.personId, 'CUSTOMER', clock());
      return { result: { revoked: ids.length }, audit: { reasonCode: 'SIGN_OUT_EVERYWHERE', after: { revoked: ids.length } } };
    },
  };

  const revokePersonSessions: Command<RevokePersonInput, RevokeResult> = {
    name: 'identity.revoke_sessions',
    async resolve(q, input) {
      const id = typeof input.personId === 'string' && UUID.test(input.personId) ? input.personId : null;
      if (!id) throw new NotFoundError('person', String(input.personId));
      const { rows } = await q.query('SELECT 1 FROM person WHERE id = $1', [id]);
      if (rows.length === 0) throw new NotFoundError('person', id);
      return { action: 'session.revoke_all', subject: { type: 'person', id } };
    },
    async run(tx, input, ctx) {
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason.length < 10 || reason.length > 1000) throw new ConflictError('REASON_REQUIRED');
      const ids = await revokeAllSessions(tx, ctx.subject.id, 'CUSTOMER', clock());
      return {
        result: { revoked: ids.length },
        audit: { reasonCode: 'SUSPECTED_COMPROMISE', after: { revoked: ids.length, reason } },
      };
    },
  };

  return { signOutEverywhere, revokePersonSessions };
}

export type SessionCommands = ReturnType<typeof sessionCommands>;
