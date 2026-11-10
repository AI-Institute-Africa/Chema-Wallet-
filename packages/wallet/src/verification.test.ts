// docs/14 §V Verification — every scenario named — plus lifecycle, activation
// and DB-guard tests. Wallets move only through the real commands.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError, SYSTEM_ACTOR, ValidationError, type Actor } from '@chema/core';
import { MissingEvidenceError, type VerificationReasonCode } from './types';
import { loadPublicWallet } from './commands';
import { publicWalletQr, publicWalletView } from './public';
import { verifiedWalletGate } from './gate';
import { ALL_PASS, PUBLIC_BASE, createWalletHarness, draftInput, type WalletHarness } from './test-support';

let t: WalletHarness;
beforeAll(async () => {
  t = await createWalletHarness();
});
afterAll(() => t.close());

const reject = (reasonCode: VerificationReasonCode, notes = 'reviewer notes') => ({
  outcome: 'REJECTED' as const,
  reasonCode,
  checklist: { ...ALL_PASS, ADMIN_IDENTITY_MATCHES: 'FAIL' as const },
  notes,
});

async function submitted(death: Parameters<WalletHarness['fullEvidence']>[2] = 'DEATH_CERTIFICATE') {
  const admin = await t.h.customer();
  const walletId = await t.draft(admin.actor);
  await t.fullEvidence(admin.actor, walletId, death);
  const { caseId } = await t.h.bus.execute(t.w.submit, { walletId }, { actor: admin.actor });
  const verifier = await t.verifier();
  await t.assignVerifier(walletId, verifier.personId);
  return { admin, walletId, caseId, verifier };
}

/** The private view, read through the bus as an authorised actor. */
const view = (walletId: string, actor: Actor) => t.h.bus.execute(t.w.view, { walletId }, { actor });

async function status(walletId: string): Promise<string> {
  const { rows } = await t.h.db.query<{ status: string }>('SELECT status FROM wallet WHERE id = $1', [walletId]);
  return rows[0]?.status ?? 'none';
}

async function topics(walletId: string): Promise<string[]> {
  const { rows } = await t.h.db.query<{ topic: string }>(
    "SELECT topic FROM outbox_event WHERE payload->>'walletId' = $1 ORDER BY created_at, id",
    [walletId],
  );
  return rows.map((r) => r.topic);
}

describe('§V missing evidence', () => {
  it('refuses submission and names what is missing', async () => {
    const admin = await t.h.customer();
    const walletId = await t.draft(admin.actor);
    await t.addEvidence(admin.actor, walletId, 'DEATH_CERTIFICATE');
    const err = await t.h.bus.execute(t.w.submit, { walletId }, { actor: admin.actor }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingEvidenceError);
    expect((err as MissingEvidenceError).missing).toEqual(['ADMIN_ID', 'MANDATE']);
    expect(await status(walletId)).toBe('DRAFT');
  });

  it('does not count evidence whose malware scan has not passed', async () => {
    const admin = await t.h.customer();
    const walletId = await t.draft(admin.actor);
    await t.addEvidence(admin.actor, walletId, 'DEATH_CERTIFICATE', { scan: false });
    await t.addEvidence(admin.actor, walletId, 'ADMIN_ID');
    await t.addEvidence(admin.actor, walletId, 'MANDATE');
    const err = (await t.h.bus.execute(t.w.submit, { walletId }, { actor: admin.actor }).catch((e: unknown) => e)) as MissingEvidenceError;
    expect(err.missing).toEqual(['DEATH_EVIDENCE(DEATH_CERTIFICATE|PARLOUR_CONFIRMATION|BURIAL_ORDER):SCAN_PENDING']);
  });

  it('rejects evidence whose document class does not match its type, or that belongs to another wallet', async () => {
    const admin = await t.h.customer();
    const walletId = await t.draft(admin.actor);
    const idDoc = await t.upload(admin.actor, walletId, 'ID');
    await expect(
      t.h.bus.execute(t.w.addEvidence, { walletId, documentId: idDoc, evidenceType: 'DEATH_CERTIFICATE' }, { actor: admin.actor }),
    ).rejects.toThrow(ValidationError);
    const other = await t.h.customer();
    const otherWallet = await t.draft(other.actor);
    const foreign = await t.upload(other.actor, otherWallet, 'DEATH_EVIDENCE');
    await expect(
      t.h.bus.execute(t.w.addEvidence, { walletId, documentId: foreign, evidenceType: 'DEATH_CERTIFICATE' }, { actor: admin.actor }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('§V approved evidence (any configured type)', () => {
  it.each(['DEATH_CERTIFICATE', 'PARLOUR_CONFIRMATION', 'BURIAL_ORDER'] as const)('%s + ID + mandate activates the wallet', async (death) => {
    const { walletId, caseId, verifier } = await submitted(death);
    expect(await status(walletId)).toBe('PENDING_VERIFICATION');
    const res = await t.h.bus.execute(
      t.w.decide,
      { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS },
      { actor: verifier.actor },
    );
    expect(res.status).toBe('ACTIVE');
    expect(res.publicSlug).toMatch(/^[a-z2-7]{26}$/);
    const v = await view(walletId, verifier.actor);
    expect(v.badge?.tooltip).toBe('Funeral checks passed. This does not mean insurance cover or claim approval.');
    expect(v.share?.url).toBe(`${PUBLIC_BASE}/w/${res.publicSlug}`);
    expect(v.share?.whatsapp).toContain(encodeURIComponent('dignified send-off'));
    const { rows } = await t.h.db.query<{ approved_by: string }>('SELECT approved_by FROM mandate WHERE wallet_id = $1 AND superseded_at IS NULL', [walletId]);
    expect(rows[0]?.approved_by).toBe(verifier.personId);
    expect(await topics(walletId)).toEqual(['wallet.draft_created', 'wallet.verification_submitted', 'wallet.verified']);
  });

  it('only counts the types the config accepts (D05)', async () => {
    const strict = await createWalletHarness({ 'verification.evidence_types': 'DEATH_CERTIFICATE' });
    try {
      const admin = await strict.h.customer();
      const walletId = await strict.draft(admin.actor);
      await strict.fullEvidence(admin.actor, walletId, 'BURIAL_ORDER');
      const err = (await strict.h.bus.execute(strict.w.submit, { walletId }, { actor: admin.actor }).catch((e: unknown) => e)) as MissingEvidenceError;
      expect(err.missing).toEqual(['DEATH_EVIDENCE(DEATH_CERTIFICATE)']);
      await strict.addEvidence(admin.actor, walletId, 'DEATH_CERTIFICATE');
      await expect(strict.h.bus.execute(strict.w.submit, { walletId }, { actor: admin.actor })).resolves.toMatchObject({ status: 'PENDING_VERIFICATION' });
    } finally {
      await strict.close();
    }
  });

  it('refuses APPROVED unless every checklist item passed', async () => {
    const { caseId, verifier } = await submitted();
    await expect(
      t.h.bus.execute(
        t.w.decide,
        { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: { ...ALL_PASS, MANDATE_SHOWS_AUTHORITY: 'FAIL' } },
        { actor: verifier.actor },
      ),
    ).rejects.toThrow(ConflictError);
    await expect(
      t.h.bus.execute(t.w.decide, { caseId, outcome: 'APPROVED', reasonCode: 'OTHER', checklist: ALL_PASS }, { actor: verifier.actor }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('§V identity mismatch', () => {
  it('rejects with a reason code and leaves no slug, QR or badge', async () => {
    const { walletId, caseId, verifier, admin } = await submitted();
    const res = await t.h.bus.execute(t.w.decide, { caseId, ...reject('IDENTITY_MISMATCH') }, { actor: verifier.actor });
    expect(res).toMatchObject({ status: 'VERIFICATION_REJECTED', publicSlug: null });
    const v = await view(walletId, admin.actor);
    expect(v).toMatchObject({ status: 'VERIFICATION_REJECTED', badge: null, publicSlug: null, share: null, canAppeal: true });
    expect(v.latestCase).toMatchObject({ outcome: 'REJECTED', reasonCode: 'IDENTITY_MISMATCH' });
    expect(await topics(walletId)).toContain('wallet.verification_rejected');
  });

  it('needs written notes for an adverse outcome', async () => {
    const { caseId, verifier } = await submitted();
    await expect(t.h.bus.execute(t.w.decide, { caseId, ...reject('IDENTITY_MISMATCH', '  ') }, { actor: verifier.actor })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('§V duplicate certificate', () => {
  it('flags the second wallet for review without blocking it; approval waits for a human review', async () => {
    const first = await t.h.customer();
    const w1 = await t.draft(first.actor);
    await t.addEvidence(first.actor, w1, 'DEATH_CERTIFICATE', { certificateNumber: 'BD 1234/2026' });

    const second = await t.h.customer();
    const w2 = await t.draft(second.actor);
    await t.addEvidence(second.actor, w2, 'DEATH_CERTIFICATE', { certificateNumber: 'bd-1234-2026' });
    await t.addEvidence(second.actor, w2, 'ADMIN_ID');
    await t.addEvidence(second.actor, w2, 'MANDATE');

    const { rows } = await t.h.db.query<{ id: string; rule: string; matched_wallet_id: string }>(
      'SELECT id, rule, matched_wallet_id FROM fraud_flag WHERE wallet_id = $1',
      [w2],
    );
    expect(rows).toEqual([expect.objectContaining({ rule: 'DUPLICATE_CERTIFICATE', matched_wallet_id: w1 })]);
    expect(await status(w2)).toBe('DRAFT'); // a flag never changes state

    const { caseId } = await t.h.bus.execute(t.w.submit, { walletId: w2 }, { actor: second.actor });
    const verifier = await t.verifier();
    await t.assignVerifier(w2, verifier.personId);
    const approve = () =>
      t.h.bus.execute(t.w.decide, { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS }, { actor: verifier.actor });
    await expect(approve()).rejects.toThrow(/OPEN_FRAUD_FLAGS/);

    const flagId = rows[0]!.id;
    await expect(
      t.h.bus.execute(t.w.reviewFlag, { flagId, outcome: 'DISMISSED', note: 'x' }, { actor: verifier.actor }),
    ).rejects.toThrow(ValidationError);
    await t.h.bus.execute(t.w.reviewFlag, { flagId, outcome: 'DISMISSED', note: 'Second wallet is the official one; first abandoned.' }, { actor: verifier.actor });
    await expect(approve()).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('flags the identical certificate file reused on another wallet', async () => {
    const bytes = Buffer.from('%PDF-1.4 the very same scan');
    const a = await t.h.customer();
    const wa = await t.draft(a.actor);
    await t.addEvidence(a.actor, wa, 'DEATH_CERTIFICATE', { bytes });
    const b = await t.h.customer();
    const wb = await t.draft(b.actor);
    await t.addEvidence(b.actor, wb, 'BURIAL_ORDER', { bytes });
    const { rows } = await t.h.db.query<{ details: { via: string } }>(
      "SELECT details FROM fraud_flag WHERE wallet_id = $1 AND rule = 'DUPLICATE_CERTIFICATE'",
      [wb],
    );
    expect(rows.map((r) => r.details.via)).toEqual(['FILE']);
  });
});

describe('§V community-only wallet', () => {
  it('activates with no Fidelity policy at all', async () => {
    const { walletId } = await t.activeWallet();
    const { rows } = await t.h.db.query('SELECT 1 FROM fidelity_link WHERE wallet_id = $1', [walletId]);
    expect(rows).toHaveLength(0);
    expect(await status(walletId)).toBe('ACTIVE');
  });

  it('stores a Fidelity link stub at create time without gating verification', async () => {
    const admin = await t.h.customer();
    const walletId = (await t.h.bus.execute(t.w.createDraft, draftInput({ fidelity: { policyNo: 'FLA-778812' } }), { actor: admin.actor })).id;
    const { rows } = await t.h.db.query<{ route_status: string; claim_status_mirror: string }>(
      'SELECT route_status, claim_status_mirror FROM fidelity_link WHERE wallet_id = $1',
      [walletId],
    );
    expect(rows).toEqual([{ route_status: 'UNSET', claim_status_mirror: 'NONE' }]);
    await t.fullEvidence(admin.actor, walletId);
    await expect(t.h.bus.execute(t.w.submit, { walletId }, { actor: admin.actor })).resolves.toMatchObject({ status: 'PENDING_VERIFICATION' });
  });
});

describe('§V agent-assisted creation', () => {
  it('agent drafts + uploads for the family; admin must confirm identity; agent cannot decide', async () => {
    const agent = await t.h.staff('AGENT');
    const adminPhone = '+263771234500';
    const view0 = await t.h.bus.execute(t.w.createDraft, draftInput({ adminPhone }), { actor: agent.actor });
    const walletId = view0.id;
    expect(view0.createdByKind).toBe('AGENT');
    const { rows: roles } = await t.h.db.query<{ role: string; phone: string | null }>(
      `SELECT r.role, p.phone_e164 AS phone FROM wallet_role r JOIN person p ON p.id = r.person_id WHERE r.wallet_id = $1 ORDER BY r.role`,
      [walletId],
    );
    expect(roles).toEqual([
      { role: 'ADMIN', phone: adminPhone },
      { role: 'AGENT', phone: null },
    ]);

    await t.fullEvidence(agent.actor, walletId);
    await expect(t.h.bus.execute(t.w.submit, { walletId }, { actor: agent.actor })).rejects.toThrow(/ADMIN_NOT_CONFIRMED/);

    const admin = await t.h.customer(adminPhone); // family admin verifies their own phone (OTP)
    const { caseId } = await t.h.bus.execute(t.w.submit, { walletId }, { actor: agent.actor });
    await expect(
      t.h.bus.execute(t.w.decide, { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS }, { actor: agent.actor }),
    ).rejects.toThrow(ForbiddenError);
    expect((await view(walletId, admin.actor)).status).toBe('PENDING_VERIFICATION');
  });

  it('requires the admin phone from an agent, and refuses it from a customer', async () => {
    const agent = await t.h.staff('AGENT');
    await expect(t.h.bus.execute(t.w.createDraft, draftInput(), { actor: agent.actor })).rejects.toThrow(ValidationError);
    const c = await t.h.customer();
    await expect(t.h.bus.execute(t.w.createDraft, draftInput({ adminPhone: '+263771234501' }), { actor: c.actor })).rejects.toThrow(ValidationError);
  });

  it('an unassigned agent cannot touch someone else’s draft', async () => {
    const admin = await t.h.customer();
    const walletId = await t.draft(admin.actor);
    const stranger = await t.h.staff('AGENT');
    await expect(t.h.bus.execute(t.w.view, { walletId }, { actor: stranger.actor })).rejects.toThrow(ForbiddenError);
    await expect(t.h.bus.execute(t.w.submit, { walletId }, { actor: stranger.actor })).rejects.toThrow(ForbiddenError);
  });
});

describe('§V rejection + appeal', () => {
  it('rejected → appeal with new evidence → a different reviewer approves', async () => {
    const { walletId, caseId, verifier, admin } = await submitted();
    await t.h.bus.execute(t.w.decide, { caseId, ...reject('AUTHORITY_NOT_SHOWN') }, { actor: verifier.actor });
    await t.addEvidence(admin.actor, walletId, 'MANDATE');
    await expect(t.h.bus.execute(t.w.appeal, { walletId, reason: 'short' }, { actor: admin.actor })).rejects.toThrow(ValidationError);
    const appealed = await t.h.bus.execute(
      t.w.appeal,
      { walletId, reason: 'Added the family council letter naming me as administrator.' },
      { actor: admin.actor },
    );
    expect(appealed.status).toBe('PENDING_VERIFICATION');
    await expect(t.h.bus.execute(t.w.appeal, { walletId, reason: 'Appealing a second time please.' }, { actor: admin.actor })).rejects.toThrow(
      /NOT_REJECTED/,
    );

    const approve = (actor: typeof verifier.actor) =>
      t.h.bus.execute(
        t.w.decide,
        { caseId: appealed.caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS },
        { actor },
      );
    await expect(approve(verifier.actor)).rejects.toThrow(/APPEAL_SAME_REVIEWER/);
    const { rows: denied } = await t.h.db.query<{ reason_code: string }>(
      "SELECT reason_code FROM audit_log WHERE action = 'verification.decide' AND subject_id = $1 AND authz_result = 'DENIED'",
      [appealed.caseId],
    );
    expect(denied.map((d) => d.reason_code)).toEqual(['APPEAL_SAME_REVIEWER']);
    const second = await t.verifier();
    await t.assignVerifier(walletId, second.personId);
    await expect(approve(second.actor)).resolves.toMatchObject({ status: 'ACTIVE' });
    const { rows } = await t.h.db.query<{ appeal_of: string | null }>('SELECT appeal_of FROM verification_case WHERE wallet_id = $1 ORDER BY submitted_at', [walletId]);
    expect(rows.map((r) => r.appeal_of)).toEqual([null, caseId]);
  });

  it('only the wallet admin may appeal', async () => {
    const { walletId, caseId, verifier } = await submitted();
    await t.h.bus.execute(t.w.decide, { caseId, ...reject('EVIDENCE_NOT_AUTHENTIC') }, { actor: verifier.actor });
    const other = await t.h.customer();
    await expect(
      t.h.bus.execute(t.w.appeal, { walletId, reason: 'I am not the admin but appeal anyway.' }, { actor: other.actor }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('MORE_INFO sends the wallet back to DRAFT for more evidence and a resubmission', async () => {
    const { walletId, caseId, verifier, admin } = await submitted();
    const res = await t.h.bus.execute(
      t.w.decide,
      { caseId, outcome: 'MORE_INFO', reasonCode: 'MISSING_EVIDENCE', checklist: { ...ALL_PASS, DEATH_EVIDENCE_VALID: 'FAIL' }, notes: 'Certificate is unreadable; please rescan.' },
      { actor: verifier.actor },
    );
    expect(res.status).toBe('DRAFT');
    expect(await topics(walletId)).toContain('wallet.verification_more_info');
    await t.addEvidence(admin.actor, walletId, 'DEATH_CERTIFICATE');
    await expect(t.h.bus.execute(t.w.submit, { walletId }, { actor: admin.actor })).resolves.toMatchObject({ status: 'PENDING_VERIFICATION' });
  });
});

describe('§V pending/rejected shows no badge', () => {
  it('draft and pending wallets have no slug, QR, share text or badge', async () => {
    const admin = await t.h.customer();
    const walletId = await t.draft(admin.actor);
    const draft = await view(walletId, admin.actor);
    expect(draft).toMatchObject({ status: 'DRAFT', badge: null, publicSlug: null, share: null });
    await t.fullEvidence(admin.actor, walletId);
    await t.h.bus.execute(t.w.submit, { walletId }, { actor: admin.actor });
    expect(await view(walletId, admin.actor)).toMatchObject({ status: 'PENDING_VERIFICATION', badge: null, publicSlug: null, share: null });
    const { rows } = await t.h.db.query<{ public_slug: string | null }>('SELECT public_slug FROM wallet WHERE id = $1', [walletId]);
    expect(rows[0]?.public_slug).toBeNull();
  });
});

describe('§V draft not publicly reachable (404)', () => {
  it('every public read is a NotFound for DRAFT, PENDING, REJECTED and SUSPENDED wallets', async () => {
    const { walletId, slug } = await t.activeWallet();
    await expect(publicWalletView(t.h.db, slug, PUBLIC_BASE)).resolves.toMatchObject({ slug, badge: { label: 'Verified funeral' } });
    await expect(publicWalletQr(t.h.db, slug, PUBLIC_BASE)).resolves.toContain('<svg');
    expect(await verifiedWalletGate.canAccept(t.h.db, walletId)).toBe(true);

    const fa = await t.fidelityAdmin();
    await t.h.bus.execute(t.w.suspend, { walletId, reasonCode: 'FRAUD_SUSPECTED', note: 'Two families dispute authority.' }, { actor: fa.actor });
    await expect(publicWalletView(t.h.db, slug, PUBLIC_BASE)).rejects.toThrow(NotFoundError);
    await expect(publicWalletQr(t.h.db, slug, PUBLIC_BASE)).rejects.toThrow(NotFoundError);
    await expect(
      t.h.bus.execute(t.w.report, { slug, category: 'SCAM' }, { actor: SYSTEM_ACTOR }),
    ).rejects.toThrow(NotFoundError);
    expect(await verifiedWalletGate.canAccept(t.h.db, walletId)).toBe(false);

    await t.h.bus.execute(t.w.unsuspend, { walletId, note: 'Dispute resolved by family meeting.' }, { actor: fa.actor });
    await expect(publicWalletView(t.h.db, slug, PUBLIC_BASE)).resolves.toMatchObject({ slug });
  });

  it('a draft, pending or rejected wallet has no slug to find, and the gate refuses it', async () => {
    const { walletId, caseId, verifier } = await submitted();
    expect(await verifiedWalletGate.canAccept(t.h.db, walletId)).toBe(false);
    await t.h.bus.execute(t.w.decide, { caseId, ...reject('DETAILS_INCONSISTENT') }, { actor: verifier.actor });
    expect(await verifiedWalletGate.canAccept(t.h.db, walletId)).toBe(false);
    await expect(loadPublicWallet(t.h.db, 'a'.repeat(26))).rejects.toThrow(NotFoundError);
    await expect(loadPublicWallet(t.h.db, 'not-a-slug')).rejects.toThrow(NotFoundError);
  });
});

describe('§V verifier ≠ creator', () => {
  it('an unassigned verifier cannot decide', async () => {
    const { caseId } = await submitted();
    const outsider = await t.verifier();
    await expect(
      t.h.bus.execute(t.w.decide, { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS }, { actor: outsider.actor }),
    ).rejects.toThrow(/NOT_ASSIGNED/);
  });

  it('a verifier who created the wallet is refused (OWN_CASE), and audited', async () => {
    const verifier = await t.verifier();
    // A wallet whose creator is the verifier's person (not reachable via commands: raw fixture).
    const { rows } = await t.h.db.query<{ id: string }>(
      `INSERT INTO wallet (deceased_name, deceased_name_norm, date_of_death, funeral_location, funeral_location_norm, currency,
                           admin_person, created_by, created_by_kind, source_channel, status)
       VALUES ('X', 'x', DATE '2026-11-01', 'Y', 'y', 'USD', $1, $1, 'CUSTOMER', 'WEB', 'PENDING_VERIFICATION') RETURNING id`,
      [verifier.personId],
    );
    const walletId = rows[0]!.id;
    const { rows: c } = await t.h.db.query<{ id: string }>(
      `INSERT INTO verification_case (wallet_id, evidence, submitted_by, submitted_at, created_at)
       VALUES ($1, ARRAY[gen_random_uuid()], $2, now(), now()) RETURNING id`,
      [walletId, verifier.personId],
    );
    await t.h.assign(verifier.personId, walletId);
    await expect(
      t.h.bus.execute(t.w.decide, { caseId: c[0]!.id, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS }, { actor: verifier.actor }),
    ).rejects.toThrow(/OWN_CASE/);
    const { rows: audit } = await t.h.db.query<{ authz_result: string; reason_code: string }>(
      "SELECT authz_result, reason_code FROM audit_log WHERE action = 'verification.decide' AND subject_id = $1",
      [c[0]!.id],
    );
    expect(audit).toEqual([{ authz_result: 'DENIED', reason_code: 'OWN_CASE' }]);
  });

  it('a verifier holding any role on the wallet is refused by the handler and by the database', async () => {
    const { walletId, caseId, verifier } = await submitted();
    await t.h.grantRole(walletId, verifier.personId, 'APPROVER');
    await expect(
      t.h.bus.execute(t.w.decide, { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS }, { actor: verifier.actor }),
    ).rejects.toThrow(/REVIEWER_IS_PARTY/);
    const { rows: audit } = await t.h.db.query<{ authz_result: string; reason_code: string; actor_id: string }>(
      "SELECT authz_result, reason_code, actor_id FROM audit_log WHERE action = 'verification.decide' AND subject_id = $1",
      [caseId],
    );
    expect(audit).toEqual([{ authz_result: 'DENIED', reason_code: 'REVIEWER_IS_PARTY', actor_id: verifier.personId }]);
    await expect(
      t.h.db.query(
        `UPDATE verification_case SET reviewer = $2, checklist = '{}'::jsonb, outcome = 'APPROVED', reason_code = 'EVIDENCE_SUFFICIENT', decided_at = now() WHERE id = $1`,
        [caseId, verifier.personId],
      ),
    ).rejects.toThrow(/reviewer is party/);
  });

  it('a FIDELITY_ADMIN cannot assign a party to the case as its verifier', async () => {
    const { walletId, verifier } = await submitted();
    await t.h.grantRole(walletId, verifier.personId, 'APPROVER');
    const v2 = await t.verifier();
    await t.h.grantRole(walletId, v2.personId, 'CLAIMANT');
    await expect(t.assignVerifier(walletId, v2.personId)).rejects.toThrow(/VERIFIER_IS_PARTY/);
    const notVerifier = await t.h.staff('CLAIMS_OFFICER');
    await expect(t.assignVerifier(walletId, notVerifier.personId)).rejects.toThrow(ValidationError);
  });
});

describe('lifecycle', () => {
  it('create_draft makes the creator ADMIN, opens the two sub-ledgers and emits wallet.draft_created', async () => {
    const admin = await t.h.customer();
    const walletId = await t.draft(admin.actor, { targetMinor: 150_000n });
    const { rows: roles } = await t.h.db.query<{ person_id: string; role: string }>('SELECT person_id, role FROM wallet_role WHERE wallet_id = $1', [walletId]);
    expect(roles).toEqual([{ person_id: admin.personId, role: 'ADMIN' }]);
    const { rows: accts } = await t.h.db.query<{ kind: string }>('SELECT kind FROM ledger_account WHERE wallet_id = $1 ORDER BY kind', [walletId]);
    expect(accts.map((a) => a.kind)).toEqual(['COMMUNITY', 'FIDELITY_BENEFIT']);
    expect(await topics(walletId)).toEqual(['wallet.draft_created']);
    expect((await view(walletId, admin.actor)).targetMinor).toBe('150000');
  });

  it('validates draft fields', async () => {
    const c = await t.h.customer();
    const bad = [
      { dateOfDeath: '2026-13-01' },
      { dateOfDeath: '2099-01-01' },
      { funeralDate: '2026-11-01' }, // before date of death
      { deceasedName: '   ' },
      { familyContactPhone: '0771234567' },
      { targetMinor: 0n },
    ];
    for (const b of bad) await expect(t.h.bus.execute(t.w.createDraft, draftInput(b), { actor: c.actor })).rejects.toThrow(ValidationError);
  });

  it('staff other than agents cannot create drafts; only FIDELITY_ADMIN suspends, with a written reason', async () => {
    const verifier = await t.verifier();
    await expect(t.h.bus.execute(t.w.createDraft, draftInput(), { actor: verifier.actor })).rejects.toThrow(ForbiddenError);
    const { walletId, admin } = await t.activeWallet();
    await expect(
      t.h.bus.execute(t.w.suspend, { walletId, reasonCode: 'OTHER', note: 'I want to suspend this.' }, { actor: admin.actor }),
    ).rejects.toThrow(ForbiddenError);
    const fa = await t.fidelityAdmin();
    await expect(t.h.bus.execute(t.w.suspend, { walletId, reasonCode: 'OTHER', note: 'no' }, { actor: fa.actor })).rejects.toThrow(ValidationError);
    await t.h.bus.execute(t.w.suspend, { walletId, reasonCode: 'LEGAL_ORDER', note: 'Court order 12/2026 received.' }, { actor: fa.actor });
    const { rows } = await t.h.db.query<{ to_status: string; reason_code: string; note: string }>(
      "SELECT to_status, reason_code, note FROM wallet_status_event WHERE wallet_id = $1 AND to_status = 'SUSPENDED'",
      [walletId],
    );
    expect(rows).toEqual([{ to_status: 'SUSPENDED', reason_code: 'LEGAL_ORDER', note: 'Court order 12/2026 received.' }]);
    expect(await topics(walletId)).toContain('wallet.suspended');
    // Suspended wallets keep their slug but lose the badge.
    expect(await view(walletId, admin.actor)).toMatchObject({ status: 'SUSPENDED', badge: null, share: null });
  });

  it('verifier queue shows only assigned open cases; FIDELITY_ADMIN sees everything', async () => {
    const { caseId, verifier } = await submitted();
    const mine = await t.h.bus.execute(t.w.queue, {}, { actor: verifier.actor });
    expect(mine.map((q) => q.caseId)).toEqual([caseId]);
    const other = await t.verifier();
    expect(await t.h.bus.execute(t.w.queue, {}, { actor: other.actor })).toEqual([]);
    const fa = await t.fidelityAdmin();
    const all = await t.h.bus.execute(t.w.queue, {}, { actor: fa.actor });
    expect(all.find((q) => q.caseId === caseId)?.assignedVerifiers).toEqual([verifier.personId]);
  });
});

describe('fraud rules (review tasks only)', () => {
  it('duplicate deceased by normalised name + date of death + location', async () => {
    const a = await t.h.customer();
    const w1 = await t.draft(a.actor, { deceasedName: 'The late Mr. Farai Chiwenga', funeralLocation: 'Mbare,  Harare' });
    const b = await t.h.customer();
    const w2 = await t.draft(b.actor, { deceasedName: 'CHIWENGA farai', funeralLocation: 'mbare harare' });
    const { rows } = await t.h.db.query<{ rule: string; matched_wallet_id: string }>('SELECT rule, matched_wallet_id FROM fraud_flag WHERE wallet_id = $1', [w2]);
    expect(rows).toEqual([{ rule: 'DUPLICATE_DECEASED', matched_wallet_id: w1 }]);
    expect(await status(w2)).toBe('DRAFT');
  });

  it('same admin phone across different deaths, and creator velocity', async () => {
    const c = await t.h.customer();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await t.draft(c.actor));
    const { rows } = await t.h.db.query<{ rule: string; n: string }>(
      'SELECT rule, count(*)::text AS n FROM fraud_flag WHERE wallet_id = $1 GROUP BY rule ORDER BY rule',
      [ids[3]],
    );
    expect(rows).toEqual([
      { rule: 'ADMIN_MULTI_DEATH', n: '3' },
      { rule: 'CREATOR_VELOCITY', n: '1' },
    ]);
    // Older drafts were under the limit when created.
    const { rows: first } = await t.h.db.query("SELECT 1 FROM fraud_flag WHERE wallet_id = $1 AND rule = 'CREATOR_VELOCITY'", [ids[0]]);
    expect(first).toHaveLength(0);
  });

  it('fraud flags are hidden from the family and the assisting agent', async () => {
    const c = await t.h.customer();
    const w1 = await t.draft(c.actor);
    await t.draft(c.actor);
    expect((await view(w1, c.actor)).fraudFlags).toBeUndefined();
  });
});

describe('report suspicious wallet', () => {
  it('opens a FRAUD case and emits wallet.report_received; rate limited per reporter', async () => {
    const { walletId, slug } = await t.activeWallet();
    const res = await t.h.bus.execute(
      t.w.report,
      { slug, category: 'FAKE_DEATH', details: 'I know this person; they are alive.', reporterIpHash: 'ip-1' },
      { actor: SYSTEM_ACTOR },
    );
    const { rows } = await t.h.db.query<{ case_type: string; wallet_id: string }>('SELECT case_type, wallet_id FROM case_record WHERE id = $1', [res.caseId]);
    expect(rows).toEqual([{ case_type: 'FRAUD', wallet_id: walletId }]);
    expect(await topics(walletId)).toContain('wallet.report_received');
    expect(await status(walletId)).toBe('ACTIVE'); // a report is not an adverse action
    for (let i = 0; i < 4; i++) await t.h.bus.execute(t.w.report, { slug, category: 'SCAM', reporterIpHash: 'ip-1' }, { actor: SYSTEM_ACTOR });
    await expect(t.h.bus.execute(t.w.report, { slug, category: 'SCAM', reporterIpHash: 'ip-1' }, { actor: SYSTEM_ACTOR })).rejects.toThrow(RateLimitedError);
    await expect(t.h.bus.execute(t.w.report, { slug, category: 'SCAM', reporterIpHash: 'ip-2' }, { actor: SYSTEM_ACTOR })).resolves.toBeTruthy();
  });

  it('a draft cannot be reported (it is not public)', async () => {
    const c = await t.h.customer();
    await t.draft(c.actor);
    await expect(t.h.bus.execute(t.w.report, { slug: 'b'.repeat(26), category: 'SCAM' }, { actor: c.actor })).rejects.toThrow(NotFoundError);
  });
});

describe('database guards (raw SQL, bypassing the library)', () => {
  it('enforces the state machine, slug rules and append-only history', async () => {
    const c = await t.h.customer();
    const walletId = await t.draft(c.actor);
    await expect(t.h.db.query("UPDATE wallet SET status = 'ACTIVE' WHERE id = $1", [walletId])).rejects.toThrow();
    await expect(t.h.db.query("UPDATE wallet SET public_slug = $2 WHERE id = $1", [walletId, 'a'.repeat(26)])).rejects.toThrow();
    await expect(t.h.db.query('DELETE FROM wallet WHERE id = $1', [walletId])).rejects.toThrow(/DELETE denied/);
    await expect(t.h.db.query("UPDATE wallet SET status = 'CLOSED' WHERE id = $1", [walletId])).rejects.toThrow(/illegal transition/);
    await expect(t.h.db.query('DELETE FROM wallet_status_event WHERE wallet_id = $1', [walletId])).rejects.toThrow(/append-only/);

    const { walletId: active, slug } = await t.activeWallet();
    await expect(t.h.db.query('UPDATE wallet SET public_slug = $2 WHERE id = $1', [active, 'c'.repeat(26)])).rejects.toThrow(/set-once/);
    await expect(t.h.db.query("UPDATE wallet SET deceased_name = 'Other' WHERE id = $1", [active])).rejects.toThrow(/frozen/);
    await expect(t.h.db.query("UPDATE wallet SET status = 'PENDING_VERIFICATION' WHERE id = $1", [active])).rejects.toThrow(/illegal transition/);
    expect(slug).toMatch(/^[a-z2-7]{26}$/);
  });

  it('decided verification cases are immutable', async () => {
    const { caseId, verifier } = await submitted();
    await t.h.bus.execute(t.w.decide, { caseId, ...reject('OTHER') }, { actor: verifier.actor });
    await expect(t.h.db.query("UPDATE verification_case SET outcome = 'APPROVED' WHERE id = $1", [caseId])).rejects.toThrow(/set-once/);
    await expect(
      t.h.bus.execute(t.w.decide, { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS }, { actor: verifier.actor }),
    ).rejects.toThrow(/CASE_CLOSED/);
  });
});
