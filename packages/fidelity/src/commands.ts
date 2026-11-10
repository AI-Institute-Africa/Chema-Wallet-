import { randomUUID } from 'node:crypto';
// Family / agent / staff commands of the claim path (docs/07 Flow). Each runs
// through the CommandBus (authorised, audited, one transaction); calls to
// Fidelity never run inside these transactions: commands only queue them
// (fidelity_request) or record what came back.
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  consumeApproval,
  createApproval,
  hasConsent,
  sha256Hex,
  type Action,
  type Actor,
  type Command,
  type CommandTx,
  type Subject,
} from '@chema/core';
import { releaseHold } from '@chema/ledger';
import { closeCase } from '@chema/payments';
import type { Queryable } from '@chema/shared';
import type { PolicyIdentifier, PolicyRecord, Requester } from './adapter';
import { enqueueRequest, enqueueSync, emit } from './requests';
import {
  LINKABLE_OUTCOMES,
  claimKey,
  effectivePolicyNo,
  hasOpenRequest,
  isAssignedStaff,
  isFamilyMember,
  linkById,
  linkByWallet,
  loadWallet,
  maskPolicy,
  normId,
  normName,
  recipientHash,
  type ClaimsDeps,
  type LinkRow,
  type LookupOutcome,
  type WalletRow,
} from './store';

export interface ClaimView {
  walletId: string;
  linked: boolean;
  policyNo: string | null;
  lookupOutcome: LookupOutcome | null;
  linkState: LinkRow['link_state'];
  linkError: string | null;
  claimStatus: LinkRow['claim_status_mirror'];
  claimReason: string | null;
  routeStatus: LinkRow['route_status'];
  routeKind: LinkRow['route_kind'];
  recipientNominated: boolean;
  benefit: {
    paymentStatus: LinkRow['benefit_payment_status'];
    amountMinor: bigint | null;
    currency: LinkRow['benefit_currency'];
    credited: boolean;
  };
  /** A call to Fidelity is queued or retrying (outage): show "status updating". */
  statusUpdating: boolean;
}

export async function claimView(q: Queryable, walletId: string, link: LinkRow | undefined): Promise<ClaimView> {
  if (!link) {
    return {
      walletId,
      linked: false,
      policyNo: null,
      lookupOutcome: null,
      linkState: 'NONE',
      linkError: null,
      claimStatus: 'NONE',
      claimReason: null,
      routeStatus: 'UNSET',
      routeKind: null,
      recipientNominated: false,
      benefit: { paymentStatus: 'NONE', amountMinor: null, currency: null, credited: false },
      statusUpdating: false,
    };
  }
  return {
    walletId,
    linked: link.link_state === 'LINKED',
    policyNo: maskPolicy(effectivePolicyNo(link)),
    lookupOutcome: link.lookup_outcome,
    linkState: link.link_state,
    linkError: link.link_error,
    claimStatus: link.claim_status_mirror,
    claimReason: link.claim_reason,
    routeStatus: link.route_status,
    routeKind: link.route_kind,
    recipientNominated: link.proposed_recipient !== null,
    benefit: {
      paymentStatus: link.benefit_payment_status,
      amountMinor: link.benefit_minor === null ? null : BigInt(link.benefit_minor),
      currency: link.benefit_currency,
      credited: link.benefit_journal_id !== null,
    },
    statusUpdating: await hasOpenRequest(q, link.id),
  };
}

/**
 * Deterministic match of the deceased against the policy's covered lives:
 * national IDs decide when both sides have one; otherwise the normalised name.
 */
export function coveredLifeMatches(record: PolicyRecord, deceasedName: string, nationalId: string | null): boolean {
  const want = normName(deceasedName);
  const wantId = nationalId ? normId(nationalId) : null;
  return record.coveredLives.some((l) => {
    const lifeId = l.nationalId ? normId(l.nationalId) : null;
    if (wantId && lifeId) return wantId === lifeId;
    return normName(l.name) === want;
  });
}

/** Lookup outcome, in precedence order. Fidelity's record decides; Chema only classifies it. */
export function lookupOutcome(record: PolicyRecord | null, deceasedName: string, nationalId: string | null): LookupOutcome {
  if (!record) return 'NO_POLICY';
  if (record.status !== 'ACTIVE') return 'INACTIVE';
  if (!coveredLifeMatches(record, deceasedName, nationalId)) return 'COVERED_LIFE_MISMATCH';
  if (record.premiumStatus === 'ARREARS') return 'ARREARS';
  return 'ELIGIBLE';
}

const IDENT_RE = /^[A-Za-z0-9 /-]{1,64}$/;

interface WalletInput {
  walletId: string;
}

/** Resolve the wallet subject; a disabled `fidelity.claims_link` hides the claim path (audited NOT_FOUND). */
function walletSubject(deps: ClaimsDeps, action: Action, opts: { gated: boolean }) {
  return async (q: Queryable, input: WalletInput): Promise<{ action: Action; subject: Subject; wallet: WalletRow }> => {
    const wallet = await loadWallet(q, input.walletId);
    if (opts.gated && !(await deps.flags.getIn(q, 'fidelity.claims_link'))) throw new NotFoundError('fidelity_claims', input.walletId);
    return { action, subject: { type: 'wallet', id: wallet.id, walletId: wallet.id, createdByPersonId: wallet.created_by }, wallet };
  };
}

/** The wallet admin's live DISCLOSURE consent for this wallet (docs/07 Flow 1, docs/10). */
async function disclosureConsent(q: Queryable, walletId: string): Promise<boolean> {
  const w = await loadWallet(q, walletId);
  return hasConsent(q, w.admin_person, 'DISCLOSURE', walletId);
}

export interface LookupPrepared {
  linkId: string;
  identifier: PolicyIdentifier;
  requester: Requester;
}

export interface LookupView {
  outcome: LookupOutcome;
  policyNo: string | null;
  /** Can a claim be lodged on this outcome? (Fidelity still decides it.) */
  linkable: boolean;
}

export interface LinkInput extends WalletInput {
  /** The family member proposed to receive the benefit. Never inferred (e.g. from the admin role). */
  recipientPersonId: string;
  /** Their national ID, compared (hashed) with the beneficiary on Fidelity's approved route. */
  recipientIdNumber: string;
}

export interface UnblockInput extends WalletInput {
  /** Reference of the written Legal + Claims + Finance approval (Fidelity's document number). */
  externalApprovalRef: string;
  /** The scanned written approval, uploaded to the wallet. */
  documentId: string;
  /** Who the written approval names as the benefit recipient. */
  recipientPersonId: string;
  /** Second call only: the approved `claim.route.unblock` approval. */
  approvalId?: string;
}

async function shareableDocument(tx: Queryable, walletId: string, documentId: string): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT (linked_wallet = $2 AND malware_scan = 'CLEAN' AND deleted_at IS NULL) AS ok FROM document WHERE id = $1`,
    [documentId, walletId],
  );
  return rows[0]?.ok === true;
}

export function claimCommands(deps: ClaimsDeps) {
  const gatedLookup = walletSubject(deps, 'claim.lookup_policy', { gated: true });

  /** Step 1 of a lookup: authorise, check consent, store identifiers. The call itself runs after. */
  const lookupPrepare: Command<WalletInput & PolicyIdentifier, LookupPrepared> = {
    name: 'claim.lookup_policy',
    resolve: gatedLookup,
    async guard(q, input) {
      return (await disclosureConsent(q, input.walletId)) ? null : 'CONSENT_REQUIRED';
    },
    async run(tx, input, ctx) {
      const policyNo = input.policyNo?.trim() || null;
      const nationalId = input.nationalId?.trim() || null;
      if ((policyNo && !IDENT_RE.test(policyNo)) || (nationalId && !IDENT_RE.test(nationalId))) throw new ValidationError('bad identifier');
      let link = await linkByWallet(tx, input.walletId, true);
      if (!link) {
        if (!policyNo && !nationalId) throw new ValidationError('policy number or national ID required');
        const { rows } = await tx.query<{ id: string }>(
          'INSERT INTO fidelity_link (wallet_id, policy_no, national_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
          [input.walletId, policyNo, nationalId, ctx.actor.personId],
        );
        const inserted = rows[0];
        if (!inserted) throw new ConflictError('LINK_NOT_CREATED');
        link = await linkById(tx, inserted.id);
      } else if (policyNo || nationalId) {
        const changed = (policyNo && policyNo !== link.policy_no) || (nationalId && nationalId !== link.national_id);
        if (changed) {
          if (link.claim_key) throw new ConflictError('CLAIM_DETAILS_FROZEN');
          await tx.query('UPDATE fidelity_link SET policy_no = COALESCE($2, policy_no), national_id = COALESCE($3, national_id) WHERE id = $1', [
            link.id,
            policyNo,
            nationalId,
          ]);
          link = await linkById(tx, link.id);
        }
      }
      const identifier: PolicyIdentifier = link.policy_no
        ? { policyNo: link.policy_no }
        : { nationalId: link.national_id ?? '' };
      return {
        result: {
          linkId: link.id,
          identifier,
          requester: { ref: ctx.actor.personId, role: ctx.actor.staffRole ?? ctx.actor.kind },
        },
        audit: { subjectId: link.id, reasonCode: 'LOOKUP_REQUESTED' },
      };
    },
  };

  /** Step 2: classify and store Fidelity's answer. Only the outcome is kept, never covered lives. */
  const lookupRecord: Command<WalletInput & { linkId: string; record: PolicyRecord | null }, LookupView> = {
    name: 'claim.lookup_record',
    resolve: gatedLookup,
    async guard(q, input) {
      return (await disclosureConsent(q, input.walletId)) ? null : 'CONSENT_REQUIRED';
    },
    async run(tx, input) {
      const now = deps.clock();
      const link = await linkById(tx, input.linkId, true);
      if (link.wallet_id !== input.walletId) throw new NotFoundError('fidelity_link', input.linkId);
      const wallet = await loadWallet(tx, input.walletId);
      const outcome = lookupOutcome(input.record, wallet.deceased_name, link.national_id);
      const found = input.record?.policyNo ?? null;
      if (link.claim_key) {
        // Lodged already: the identifiers are frozen; report without rewriting.
        return {
          result: { outcome, policyNo: maskPolicy(effectivePolicyNo(link)), linkable: LINKABLE_OUTCOMES.has(outcome) },
          audit: { subjectId: link.id, reasonCode: `LOOKUP_${outcome}` },
        };
      }
      await tx.query('UPDATE fidelity_link SET lookup_outcome = $2, lookup_at = $3, lookup_policy_no = $4 WHERE id = $1', [
        link.id,
        outcome,
        now.toISOString(),
        found,
      ]);
      return {
        result: { outcome, policyNo: maskPolicy(found ?? link.policy_no), linkable: LINKABLE_OUTCOMES.has(outcome) },
        audit: { subjectId: link.id, reasonCode: `LOOKUP_${outcome}` },
      };
    },
  };

  /** Lodge or link the claim (queued call, idempotent on wallet + policy + deceased). */
  const link: Command<LinkInput, { view: ClaimView; requestId: string | null }> = {
    name: 'claim.link',
    resolve: walletSubject(deps, 'claim.link', { gated: true }),
    async run(tx, input, ctx) {
      const now = deps.clock();
      const wallet = await loadWallet(tx, input.walletId);
      if (wallet.status === 'CLOSED') throw new ConflictError('WALLET_CLOSED');
      const row = await linkByWallet(tx, input.walletId, true);
      if (!row || !row.lookup_outcome) throw new ConflictError('LOOKUP_REQUIRED');
      if (!LINKABLE_OUTCOMES.has(row.lookup_outcome)) throw new ConflictError(`LOOKUP_${row.lookup_outcome}`);
      if (row.link_state === 'DUPLICATE_CLAIM') throw new ConflictError('DUPLICATE_CLAIM');
      if (row.link_state === 'LINKED') return { result: { view: await claimView(tx, wallet.id, row), requestId: null }, audit: { subjectId: row.id, reasonCode: 'ALREADY_LINKED' } };

      const idNumber = normId(input.recipientIdNumber);
      if (idNumber.length < 4 || idNumber.length > 32) throw new ValidationError('bad recipient ID number');
      if (!(await isFamilyMember(tx, wallet.id, input.recipientPersonId))) throw new ConflictError('RECIPIENT_NOT_ON_WALLET');
      const hash = recipientHash(deps, idNumber);
      const policyNo = effectivePolicyNo(row);
      if (!policyNo) throw new ConflictError('LOOKUP_REQUIRED');
      const key = row.claim_key ?? claimKey(wallet.id, policyNo, wallet.deceased_name, wallet.date_of_death);
      if (row.claim_key && (row.proposed_recipient !== input.recipientPersonId || row.proposed_recipient_id_hash !== hash)) {
        throw new ConflictError('CLAIM_DETAILS_FROZEN');
      }
      await tx.query(
        `UPDATE fidelity_link SET claim_key = $2, link_state = 'QUEUED', link_error = NULL,
                proposed_recipient = $3, proposed_recipient_id_hash = $4 WHERE id = $1`,
        [row.id, key, input.recipientPersonId, hash],
      );
      const requestId = await enqueueRequest(tx, { linkId: row.id, walletId: wallet.id, kind: 'LINK_CLAIM', dedupeKey: `link:${key}:${randomUUID()}`, now });
      const after = await linkById(tx, row.id);
      return {
        result: { view: await claimView(tx, wallet.id, after), requestId },
        audit: { subjectId: row.id, reasonCode: 'CLAIM_QUEUED', after: { linkState: 'QUEUED', by: ctx.actor.kind } },
      };
    },
  };

  /** Share scanned wallet documents with the claim (references only; Fidelity reads them under its own access control). */
  const submitEvidence: Command<WalletInput & { documentIds: readonly string[] }, { added: number; requestId: string | null }> = {
    name: 'claim.submit_evidence',
    resolve: walletSubject(deps, 'claim.submit_evidence', { gated: true }),
    async run(tx, input, ctx) {
      const now = deps.clock();
      const ids = [...new Set(input.documentIds)];
      if (ids.length === 0 || ids.length > 20) throw new ValidationError('1 to 20 documents');
      const row = await linkByWallet(tx, input.walletId, true);
      if (!row || row.link_state !== 'LINKED' || !row.claim_ref) throw new ConflictError('CLAIM_NOT_LINKED');
      const added: string[] = [];
      for (const id of ids) {
        if (!(await shareableDocument(tx, input.walletId, id))) throw new ConflictError('DOCUMENT_NOT_SHAREABLE');
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO claim_evidence (link_id, document_id, added_by, added_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (link_id, document_id) DO NOTHING RETURNING id`,
          [row.id, id, ctx.actor.personId, now.toISOString()],
        );
        if (rows[0]) added.push(id);
      }
      if (added.length === 0) return { result: { added: 0, requestId: null }, audit: { subjectId: row.id, reasonCode: 'NOTHING_NEW' } };
      added.sort();
      const requestId = await enqueueRequest(tx, {
        linkId: row.id,
        walletId: input.walletId,
        kind: 'SUBMIT_EVIDENCE',
        dedupeKey: `evidence:${row.id}:${sha256Hex(added.join(','))}`,
        payload: { documentIds: added },
        now,
      });
      return { result: { added: added.length, requestId }, audit: { subjectId: row.id, reasonCode: 'EVIDENCE_QUEUED' } };
    },
  };

  /** Claim status for the family and assigned staff. Never for contributors (docs/07 Never). */
  const view: Command<WalletInput, ClaimView> = {
    name: 'claim.view',
    resolve: walletSubject(deps, 'claim.view', { gated: false }),
    async run(tx, input) {
      return { result: await claimView(tx, input.walletId, await linkByWallet(tx, input.walletId)) };
    },
  };

  /**
   * Beneficiary mismatch (docs/07 §5, D03): record the written Legal + Claims
   * + Finance approval. First call (maker = assigned claims officer) creates a
   * `claim.route.unblock` approval; ops/finance checks it; the maker's second
   * call (with approvalId) approves the route, releases the benefit hold and
   * closes the case. The recipient is the one the approval names, never inferred.
   */
  const unblockRoute: Command<UnblockInput, { approvalId: string; status: 'PENDING_APPROVAL' | 'UNBLOCKED' }> = {
    name: 'claim.route.unblock',
    resolve: walletSubject(deps, 'claim.route.unblock', { gated: true }),
    async guard(q, input, actor) {
      return (await isAssignedStaff(q, input.walletId, actor.personId)) ? null : 'NOT_ASSIGNED';
    },
    async run(tx, input, ctx) {
      const ref = input.externalApprovalRef.trim();
      if (ref.length < 3 || ref.length > 128) throw new ValidationError('external approval reference required');
      const row = await linkByWallet(tx, input.walletId, true);
      if (!row || row.route_status !== 'BLOCKED_MISMATCH') throw new ConflictError('ROUTE_NOT_BLOCKED');
      if (!(await shareableDocument(tx, input.walletId, input.documentId))) throw new ConflictError('DOCUMENT_NOT_SHAREABLE');
      if (!(await isFamilyMember(tx, input.walletId, input.recipientPersonId))) throw new ConflictError('RECIPIENT_NOT_ON_WALLET');
      const payload = { linkId: row.id, externalApprovalRef: ref, documentId: input.documentId, recipientPersonId: input.recipientPersonId };
      const expect = { action: 'claim.route.unblock' as const, subjectType: 'fidelity_link', subjectId: row.id, payload };
      if (!input.approvalId) {
        const approvalId = await createApproval(tx, ctx.actor, { ...expect, walletId: input.walletId });
        return { result: { approvalId, status: 'PENDING_APPROVAL' }, audit: { subjectId: row.id, approvalRef: approvalId, reasonCode: 'UNBLOCK_REQUESTED' } };
      }
      await consumeApproval(tx, ctx.actor, input.approvalId, expect);
      await applyUnblock(tx, ctx.actor, deps, row, { approvalId: input.approvalId, externalRef: ref, recipientPersonId: input.recipientPersonId });
      return { result: { approvalId: input.approvalId, status: 'UNBLOCKED' }, audit: { subjectId: row.id, approvalRef: input.approvalId, reasonCode: 'ROUTE_UNBLOCKED' } };
    },
  };

  return { lookupPrepare, lookupRecord, link, submitEvidence, view, unblockRoute };
}

export type ClaimCommands = ReturnType<typeof claimCommands>;

async function applyUnblock(
  tx: CommandTx,
  actor: Actor,
  deps: ClaimsDeps,
  row: LinkRow,
  a: { approvalId: string; externalRef: string; recipientPersonId: string },
): Promise<void> {
  const now = deps.clock();
  await tx.query(
    `UPDATE fidelity_link SET route_status = 'APPROVED', route_approval_ref = $2, external_approval_ref = $3, approved_recipient = $4
      WHERE id = $1`,
    [row.id, a.approvalId, a.externalRef, a.recipientPersonId],
  );
  if (row.mismatch_hold_id) await releaseHold(tx, actor, row.mismatch_hold_id, `route approved: ${a.externalRef}`);
  if (row.mismatch_case_id) await closeCase(tx, row.mismatch_case_id, actor.personId, 'ROUTE_APPROVED_IN_WRITING');
  await emit(tx, 'benefit.route_unblocked', { walletId: row.wallet_id, linkId: row.id });
  // Re-read Fidelity's record: a settled payment can now be credited.
  await enqueueSync(tx, row, now);
}
