// P09 portal read surfaces (docs/12 queues). Reads go through the bus too:
// authorised against their own matrix action and audited. Oversight roles
// (ops/finance, Fidelity admin, auditor) see every row; claims officers and
// verifiers get only wallets they are assigned to (docs/02 Staff). No queue
// returns message bodies, documents or national ids.
import {
  CHECKER_ACTION,
  FLAG_KEYS,
  FLAGS,
  loadApproval,
  type Actor,
  type Authorizer,
  type Command,
  type FlagService,
  type Subject,
} from '@chema/core';
import { accountCode, getBalances, listWalletAccounts } from '@chema/ledger';
import { iso, walletExists } from './util';

export interface QueueDeps {
  flags: FlagService;
  authorizer: Authorizer;
  clock: () => Date;
}

const queueSubject = (id: string) => ({ type: 'queue', id });

/** Staff whose queues are limited to their assignments. */
function scoped(actor: Actor): boolean {
  return actor.kind === 'STAFF' && (actor.staffRole === 'CLAIMS_OFFICER' || actor.staffRole === 'COMMUNITY_VERIFIER');
}

const ASSIGNED_SQL = `EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.wallet_id = w.id AND sa.staff_person_id = $1 AND sa.revoked_at IS NULL)`;

// ── 3. Approvals (checker view) ─────────────────────────────────────────────

export interface ApprovalItem {
  id: string;
  action: string;
  subjectType: string;
  subjectId: string;
  walletId: string | null;
  amountMinor: string | null;
  currency: string | null;
  makerId: string;
  makerRole: string;
  createdAt: string;
  escalatedTo: string | null;
  /** Would the CURRENT actor pass the checker rule (maker ≠ checker, role, escalation)? */
  canDecide: boolean;
  whyNot: string | null;
}

export function approvalQueue(deps: QueueDeps): Command<Record<string, never>, ApprovalItem[]> {
  return {
    name: 'approval.queue',
    async resolve() {
      return { action: 'approval.queue', subject: queueSubject('approvals') };
    },
    async run(tx, _i, ctx) {
      const { rows } = await tx.query<{ id: string; maker_role: string }>(
        `SELECT id, maker_role FROM approval WHERE decision IS NULL AND consumed_at IS NULL ORDER BY created_at LIMIT 200`,
      );
      const out: ApprovalItem[] = [];
      for (const r of rows) {
        const a = await loadApproval(tx, r.id);
        if (!a) continue;
        const checker = CHECKER_ACTION[a.action];
        const subject: Subject = {
          type: 'approval',
          id: a.id,
          makerPersonId: a.maker_id,
          ...(a.wallet_id ? { walletId: a.wallet_id } : {}),
          ...(a.amount_minor !== null ? { amountMinor: BigInt(a.amount_minor) } : {}),
          ...(a.escalated_to ? { escalatedTo: a.escalated_to } : {}),
        };
        const d = checker ? await deps.authorizer.authorize(tx, ctx.actor, checker, subject) : { allowed: false, reason: 'NOT_APPROVABLE' };
        out.push({
          id: a.id,
          action: a.action,
          subjectType: a.subject_type,
          subjectId: a.subject_id,
          walletId: a.wallet_id,
          amountMinor: a.amount_minor,
          currency: a.currency,
          makerId: a.maker_id,
          makerRole: r.maker_role,
          createdAt: new Date(a.created_at).toISOString(),
          escalatedTo: a.escalated_to,
          canDecide: d.allowed,
          whyNot: d.allowed ? null : d.reason,
        });
      }
      return { result: out };
    },
  };
}

// ── 2. Claims mirror ────────────────────────────────────────────────────────

export const claimQueue: Command<Record<string, never>, unknown[]> = {
  name: 'claim.queue',
  async resolve() {
    return { action: 'claim.queue', subject: queueSubject('claims') };
  },
  async run(tx, _i, ctx) {
    const scope = scoped(ctx.actor);
    const { rows } = await tx.query(
      `SELECT f.wallet_id AS "walletId", w.deceased_name AS "deceased", f.claim_ref AS "claimRef",
              f.claim_status_mirror AS "claimStatus", f.route_status AS "routeStatus", f.link_state AS "linkState",
              f.claim_reason AS "claimReason", f.created_at AS "createdAt", f.updated_at AS "updatedAt",
              (SELECT count(*)::int FROM fidelity_request r WHERE r.link_id = f.id AND r.status = 'DEAD') AS "deadRequests"
         FROM fidelity_link f JOIN wallet w ON w.id = f.wallet_id
        WHERE (f.claim_status_mirror NOT IN ('APPROVED', 'DECLINED') OR f.route_status IN ('PENDING_APPROVAL', 'BLOCKED_MISMATCH'))
          ${scope ? `AND ${ASSIGNED_SQL}` : ''}
        ORDER BY f.updated_at LIMIT 200`,
      scope ? [ctx.actor.personId] : [],
    );
    return { result: rows };
  },
};

// ── 7. Fraud flags + suspicious-wallet reports ──────────────────────────────

export const fraudQueue: Command<Record<string, never>, { flags: unknown[]; reports: unknown[] }> = {
  name: 'fraud_flag.queue',
  async resolve() {
    return { action: 'fraud_flag.queue', subject: queueSubject('fraud') };
  },
  async run(tx, _i, ctx) {
    const scope = scoped(ctx.actor);
    const params = scope ? [ctx.actor.personId] : [];
    const { rows: flags } = await tx.query(
      `SELECT f.id, f.wallet_id AS "walletId", f.rule, f.matched_wallet_id AS "matchedWalletId", f.created_at AS "createdAt",
              w.status AS "walletStatus"
         FROM fraud_flag f JOIN wallet w ON w.id = f.wallet_id
        WHERE f.reviewed_at IS NULL ${scope ? `AND ${ASSIGNED_SQL}` : ''}
        ORDER BY f.created_at LIMIT 200`,
      params,
    );
    const { rows: reports } = await tx.query(
      `SELECT r.id, r.wallet_id AS "walletId", r.category, r.case_id AS "caseId", r.created_at AS "createdAt",
              c.status AS "caseStatus", w.status AS "walletStatus"
         FROM wallet_report r JOIN wallet w ON w.id = r.wallet_id JOIN case_record c ON c.id = r.case_id
        WHERE c.closed_at IS NULL ${scope ? `AND ${ASSIGNED_SQL}` : ''}
        ORDER BY r.created_at LIMIT 200`,
      params,
    );
    return { result: { flags, reports } };
  },
};

// ── 8. Holds register ───────────────────────────────────────────────────────

export function holdRegister(deps: QueueDeps): Command<{ includeReleased?: boolean }, unknown[]> {
  return {
    name: 'hold.register',
    async resolve() {
      return { action: 'hold.register', subject: queueSubject('holds') };
    },
    async run(tx, input) {
      const now = deps.clock().toISOString();
      const { rows } = await tx.query(
        `SELECT h.id, h.wallet_id AS "walletId", h.scope, h.source_kind AS "sourceKind", h.amount_minor::text AS "amountMinor",
                h.currency, h.reason_code AS "reasonCode", h.owner_id AS "ownerId", h.placed_by AS "placedBy",
                h.review_at AS "reviewAt", (h.released_at IS NULL AND h.review_at <= $1) AS "overdue",
                h.created_at AS "createdAt", h.released_at AS "releasedAt", h.release_reason AS "releaseReason",
                (SELECT a.id FROM approval a WHERE a.action = 'hold.release' AND a.subject_id = h.id::text
                   AND a.decision IS NULL ORDER BY a.created_at DESC LIMIT 1) AS "pendingReleaseApproval"
           FROM hold h
          WHERE ($2::boolean OR h.released_at IS NULL)
          ORDER BY (h.released_at IS NULL) DESC, h.review_at LIMIT 500`,
        [now, input.includeReleased === true],
      );
      return { result: rows };
    },
  };
}

// ── 9. Config & flags ───────────────────────────────────────────────────────

export function configView(deps: QueueDeps): Command<Record<string, never>, { flags: unknown[]; changes: unknown[]; pending: unknown[] }> {
  return {
    name: 'config.view',
    async resolve() {
      return { action: 'config.view', subject: queueSubject('config') };
    },
    async run(tx) {
      const flags: unknown[] = [];
      for (const key of FLAG_KEYS) {
        const d = FLAGS[key];
        let value: unknown = null;
        let source: string;
        let error: string | null = null;
        try {
          const r = await deps.flags.resolvedIn(tx, key);
          value = r.value === null || r.value === undefined ? null : (d.encode as (v: unknown) => unknown)(r.value);
          source = r.source;
        } catch (err) {
          source = 'invalid';
          error = err instanceof Error ? err.name : 'error';
        }
        flags.push({
          key,
          description: d.description,
          decision: d.decision ?? null,
          financial: d.financial,
          locked: d.locked === true,
          value,
          source,
          error,
        });
      }
      const { rows: changes } = await tx.query(
        `SELECT key, old_value AS "oldValue", new_value AS "newValue", actor_id AS "actorId", actor_role AS "actorRole",
                approval_ref AS "approvalRef", reason, changed_at AS "changedAt"
           FROM config_flag_change ORDER BY id DESC LIMIT 50`,
      );
      const { rows: pending } = await tx.query(
        `SELECT id, subject_id AS "key", maker_id AS "makerId", decision, created_at AS "createdAt"
           FROM approval WHERE action = 'config.change' AND consumed_at IS NULL
            AND (decision IS NULL OR decision = 'APPROVED') ORDER BY created_at DESC LIMIT 50`,
      );
      return { result: { flags, changes, pending } };
    },
  };
}

// ── 10. Access review (export) ──────────────────────────────────────────────

export interface AccessReviewRow {
  staffId: string;
  personId: string;
  login: string;
  role: string;
  disabled: boolean;
  mfaEnrolledAt: string | null;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  activeAssignments: number;
  createdAt: string | null;
}

export const accessReview: Command<Record<string, never>, { rows: AccessReviewRow[]; csv: string }> = {
  name: 'role.review',
  async resolve() {
    return { action: 'role.review', subject: queueSubject('access_review') };
  },
  async run(tx) {
    const { rows } = await tx.query<{
      id: string; person_id: string; login: string; staff_role: string; disabled_at: Date | null; mfa_enrolled_at: Date | null;
      locked_until: Date | null; created_at: Date | null; last_login: Date | null; assignments: number;
    }>(
      `SELECT s.id, s.person_id, s.login, s.staff_role, s.disabled_at, s.mfa_enrolled_at, s.locked_until, s.created_at,
              (SELECT max(a.created_at) FROM auth_session a WHERE a.staff_id = s.id) AS last_login,
              (SELECT count(*)::int FROM staff_assignment x WHERE x.staff_person_id = s.person_id AND x.revoked_at IS NULL) AS assignments
         FROM staff_account s ORDER BY s.staff_role, s.login`,
    );
    const out: AccessReviewRow[] = rows.map((r) => ({
      staffId: r.id,
      personId: r.person_id,
      login: r.login,
      role: r.staff_role,
      disabled: r.disabled_at !== null,
      mfaEnrolledAt: iso(r.mfa_enrolled_at),
      lastLoginAt: iso(r.last_login),
      lockedUntil: iso(r.locked_until),
      activeAssignments: r.assignments,
      createdAt: iso(r.created_at),
    }));
    const header = 'login,role,disabled,mfa_enrolled_at,last_login_at,active_assignments';
    const csv = [header, ...out.map((r) => [r.login, r.role, r.disabled, r.mfaEnrolledAt ?? '', r.lastLoginAt ?? '', r.activeAssignments].join(','))].join('\n');
    return { result: { rows: out, csv }, audit: { reasonCode: 'ACCESS_REVIEW_EXPORT' } };
  },
};

// ── Ops failures (dead letters) ─────────────────────────────────────────────

export const failures: Command<Record<string, never>, Record<string, unknown[]>> = {
  name: 'ops.failures',
  async resolve() {
    return { action: 'ops.failures.view', subject: queueSubject('failures') };
  },
  async run(tx) {
    const { rows: notifications } = await tx.query(
      `SELECT id, template, channel, wallet_id AS "walletId", attempts, last_error AS "lastError", updated_at AS "updatedAt"
         FROM notification WHERE status = 'DEAD' ORDER BY updated_at DESC LIMIT 100`,
    );
    const { rows: fidelity } = await tx.query(
      `SELECT id, wallet_id AS "walletId", kind, attempts, last_error AS "lastError", updated_at AS "updatedAt"
         FROM fidelity_request WHERE status = 'DEAD' ORDER BY updated_at DESC LIMIT 100`,
    );
    const { rows: whatsapp } = await tx.query(
      `SELECT id, provider, status, outcome, attempts, received_at AS "receivedAt"
         FROM wa_inbound WHERE status IN ('FAILED', 'IGNORED') ORDER BY received_at DESC LIMIT 100`,
    );
    const { rows: payouts } = await tx.query(
      `SELECT id, wallet_id AS "walletId", status, rail, amount_minor::text AS "amountMinor", currency, attempts,
              last_error AS "lastError", updated_at AS "updatedAt"
         FROM payout_request WHERE status IN ('RAIL_DOWN', 'OVERRIDE_PENDING', 'RETRY') ORDER BY updated_at LIMIT 100`,
    );
    return { result: { notifications, fidelity, whatsapp, payouts } };
  },
};

// ── Support hand-off (WhatsApp escalations) ─────────────────────────────────

export const supportQueue: Command<{ includeClosed?: boolean }, unknown[]> = {
  name: 'support.queue',
  async resolve() {
    return { action: 'support.view', subject: queueSubject('support') };
  },
  async run(tx, input) {
    const { rows } = await tx.query<{ person_id: string | null } & Record<string, unknown>>(
      `SELECT e.id, e.ref, e.reason, e.status, e.created_at AS "createdAt", e.closed_at AS "closedAt", e.close_note AS "closeNote",
              c.id AS "conversationId", c.state AS "conversationState", c.locale, c.last_inbound_at AS "lastInboundAt",
              c.person_id
         FROM wa_escalation e JOIN wa_conversation c ON c.id = e.conversation_id
        WHERE ($1::boolean OR e.status = 'OPEN')
        ORDER BY e.created_at LIMIT 200`,
      [input.includeClosed === true],
    );
    const out: unknown[] = [];
    for (const r of rows) {
      const { person_id, ...rest } = r;
      // Case links: wallets where the person holds a role (never inferred from the phone).
      const wallets = person_id
        ? (
            await tx.query<{ wallet_id: string; role: string; status: string }>(
              `SELECT r.wallet_id, r.role, w.status FROM wallet_role r JOIN wallet w ON w.id = r.wallet_id
                WHERE r.person_id = $1 AND r.revoked_at IS NULL ORDER BY w.created_at DESC LIMIT 10`,
              [person_id],
            )
          ).rows.map((w) => ({ walletId: w.wallet_id, role: w.role, walletStatus: w.status }))
        : [];
      out.push({ ...rest, signedIn: person_id !== null, personId: person_id, wallets });
    }
    return { result: out };
  },
};

// ── Ledger accounts for an adjustment (maker view) ──────────────────────────

export const adjustmentAccounts: Command<{ walletId?: string }, unknown[]> = {
  name: 'ledger.accounts',
  async resolve(q, input) {
    if (input.walletId === undefined) return { action: 'ledger.adjust', subject: { type: 'ledger_accounts', id: 'system' } };
    const walletId = await walletExists(q, input.walletId);
    return { action: 'ledger.adjust', subject: { type: 'ledger_accounts', id: walletId, walletId } };
  },
  async run(tx, input) {
    if (input.walletId !== undefined) {
      const accounts = await listWalletAccounts(tx, input.walletId);
      const balances = await getBalances(tx, input.walletId);
      return {
        result: accounts.map((a) => {
          const b = balances.find((x) => x.account.id === a.id);
          return { id: a.id, code: accountCode(a), kind: a.kind, currency: a.currency, available: b?.available.minor.toString() ?? '0', settled: b?.settled.minor.toString() ?? '0' };
        }),
      };
    }
    const { rows } = await tx.query<{ id: string; kind: string; qualifier: string | null; currency: string }>(
      `SELECT id, kind, qualifier, currency FROM ledger_account WHERE wallet_id IS NULL ORDER BY kind, qualifier, currency`,
    );
    return {
      result: rows.map((a) => ({ id: a.id, code: `SYS:${a.kind}${a.qualifier ? `:${a.qualifier}` : ''}`, kind: a.kind, currency: a.currency })),
    };
  },
};
