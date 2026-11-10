// Wallet lifecycle + community verification commands (docs/05). Every state
// change runs through the CommandBus: resolve the subject from the DB →
// authorise (matrix) → handler → audit, in one transaction. The wallet_guard,
// verification_case_* triggers re-check the same rules in the database.
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
  actorRoleLabel,
  enqueueOutbox,
  type Actor,
  type Command,
  type CommandTx,
  type FlagService,
} from '@chema/core';
import { bootstrapWalletAccounts } from '@chema/ledger';
import type { Locale, Queryable } from '@chema/shared';
import { badgeFor, certificateNumberHash, newPublicSlug, publicUrl, shareLinks } from './activation';
import { DEFAULT_VELOCITY_LIMIT, DeterministicFraudRules, recordFindings, type FraudRules } from './fraud';
import { normaliseLocation, normaliseName } from './normalise';
import {
  CHECKLIST_ITEMS,
  DEATH_EVIDENCE_TYPES,
  EVIDENCE_DOCUMENT_CLASS,
  EVIDENCE_TYPES,
  MissingEvidenceError,
  REPORT_CATEGORIES,
  SUSPEND_REASON_CODES,
  VERIFICATION_OUTCOMES,
  VERIFICATION_REASON_CODES,
  includes,
  type CaseView,
  type Checklist,
  type EvidenceType,
  type EvidenceView,
  type FraudFlagView,
  type FraudRule,
  type ReportCategory,
  type SuspendReasonCode,
  type VerificationOutcome,
  type VerificationReasonCode,
  type WalletStatus,
  type WalletTopic,
  type WalletView,
} from './types';

export interface WalletDeps {
  flags: FlagService;
  /** Base URL of the public web app; the share link is `${base}/w/${slug}`. */
  publicBaseUrl: string;
  clock?: () => Date;
  fraud?: FraudRules;
  locale?: Locale;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface WalletRow {
  id: string;
  status: WalletStatus;
  deceased_name: string;
  date_of_death: string;
  funeral_date: string | null;
  funeral_location: string;
  currency: 'USD' | 'ZWG';
  target_minor: string | null;
  public_slug: string | null;
  verified_at: Date | null;
  admin_person: string;
  created_by: string;
  created_by_kind: 'CUSTOMER' | 'AGENT';
  created_at: Date;
}

// Dates as text: node-postgres would turn a `date` into local-midnight Date.
const WALLET_COLS = `id, status, deceased_name, date_of_death::text AS date_of_death, funeral_date::text AS funeral_date,
  funeral_location, currency, target_minor::text AS target_minor, public_slug, verified_at, admin_person, created_by,
  created_by_kind, created_at`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadWallet(q: Queryable, walletId: string, lock = false): Promise<WalletRow> {
  if (!UUID.test(walletId)) throw new NotFoundError('wallet', walletId);
  const { rows } = await q.query<WalletRow>(
    `SELECT ${WALLET_COLS} FROM wallet WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [walletId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('wallet', walletId);
  return row;
}

/** Public lookup: unknown slug and every non-ACTIVE status are the same 404. */
export async function loadPublicWallet(q: Queryable, slug: string): Promise<WalletRow> {
  if (!/^[a-z2-7]{26}$/.test(slug)) throw new NotFoundError('wallet', 'public');
  const { rows } = await q.query<WalletRow>(`SELECT ${WALLET_COLS} FROM wallet WHERE public_slug = $1`, [slug]);
  const row = rows[0];
  if (!row || row.status !== 'ACTIVE') throw new NotFoundError('wallet', 'public');
  return row;
}

interface CaseRow {
  id: string;
  wallet_id: string;
  submitted_by: string;
  submitted_at: Date;
  appeal_of: string | null;
  reviewer: string | null;
  outcome: VerificationOutcome | null;
  reason_code: VerificationReasonCode | null;
  decided_at: Date | null;
}

const CASE_COLS = 'id, wallet_id, submitted_by, submitted_at, appeal_of, reviewer, outcome, reason_code, decided_at';

async function loadCase(q: Queryable, caseId: string, lock = false): Promise<CaseRow> {
  if (!UUID.test(caseId)) throw new NotFoundError('verification_case', caseId);
  const { rows } = await q.query<CaseRow>(
    `SELECT ${CASE_COLS} FROM verification_case WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [caseId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('verification_case', caseId);
  return row;
}

async function latestCase(q: Queryable, walletId: string): Promise<CaseRow | undefined> {
  const { rows } = await q.query<CaseRow>(
    `SELECT ${CASE_COLS} FROM verification_case WHERE wallet_id = $1 ORDER BY submitted_at DESC, created_at DESC LIMIT 1`,
    [walletId],
  );
  return rows[0];
}

const walletSubject = (w: WalletRow) => ({ type: 'wallet', id: w.id, walletId: w.id, createdByPersonId: w.created_by });

// ── Input validation ────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: string, field: string): string {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new ValidationError(`${field} must be YYYY-MM-DD`);
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new ValidationError(`${field} is not a real date`);
  return value;
}

function text(value: string, field: string, max = 200): string {
  const v = value.trim();
  if (v.length === 0 || v.length > max) throw new ValidationError(`${field} must be 1-${max} characters`);
  return v;
}

const PHONE = /^\+[1-9][0-9]{6,14}$/;

function requiredNote(note: string | undefined, min = 10): string {
  const v = (note ?? '').trim();
  if (v.length < min || v.length > 2000) throw new ValidationError(`a written reason of ${min}-2000 characters is required`);
  return v;
}

// ── Shared steps ────────────────────────────────────────────────────────────

async function setStatus(
  tx: CommandTx,
  actor: Actor,
  w: WalletRow,
  to: WalletStatus,
  now: Date,
  extra: { reasonCode?: string; note?: string; caseId?: string; slug?: string } = {},
): Promise<void> {
  if (extra.slug) {
    await tx.query('UPDATE wallet SET status = $2, public_slug = $3, verified_at = $4, updated_at = $4 WHERE id = $1', [
      w.id,
      to,
      extra.slug,
      now,
    ]);
  } else {
    await tx.query('UPDATE wallet SET status = $2, updated_at = $3 WHERE id = $1', [w.id, to, now]);
  }
  await tx.query(
    `INSERT INTO wallet_status_event (wallet_id, from_status, to_status, actor_id, actor_role, reason_code, note, case_id, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [w.id, w.status, to, actor.personId, actorRoleLabel(actor), extra.reasonCode ?? null, extra.note ?? null, extra.caseId ?? null, now],
  );
}

const emit = (tx: CommandTx, topic: WalletTopic, payload: Record<string, unknown>) => enqueueOutbox(tx, topic, payload);

interface UsableEvidence {
  id: string;
  document_id: string;
  evidence_type: EvidenceType;
  malware_scan: 'CLEAN' | 'INFECTED' | null;
}

async function evidenceOf(q: Queryable, walletId: string): Promise<UsableEvidence[]> {
  const { rows } = await q.query<UsableEvidence>(
    `SELECT e.id, e.document_id, e.evidence_type, d.malware_scan
       FROM verification_evidence e JOIN document d ON d.id = e.document_id
      WHERE e.wallet_id = $1 AND d.deleted_at IS NULL
      ORDER BY e.created_at, e.id`,
    [walletId],
  );
  return rows;
}

/**
 * Evidence standard (docs/05, config `verification.evidence_types`): any ONE
 * accepted death evidence + admin ID + mandate, each malware-scanned CLEAN.
 * Completeness only: whether it is convincing is the reviewer's call.
 */
async function completeEvidence(tx: CommandTx, flags: FlagService, walletId: string): Promise<{ evidence: UsableEvidence[]; mandateDocs: string[] }> {
  const accepted = new Set<string>(await flags.getIn(tx, 'verification.evidence_types'));
  const all = await evidenceOf(tx, walletId);
  const clean = all.filter((e) => e.malware_scan === 'CLEAN');
  const missing: string[] = [];
  const has = (pred: (e: UsableEvidence) => boolean) => clean.some(pred);
  const pendingScan = (pred: (e: UsableEvidence) => boolean) => all.some((e) => pred(e) && e.malware_scan === null);
  const isDeath = (e: UsableEvidence) => accepted.has(e.evidence_type);
  const need: [string, (e: UsableEvidence) => boolean][] = [
    [`DEATH_EVIDENCE(${[...accepted].join('|')})`, isDeath],
    ['ADMIN_ID', (e) => e.evidence_type === 'ADMIN_ID'],
    ['MANDATE', (e) => e.evidence_type === 'MANDATE'],
  ];
  for (const [label, pred] of need) {
    if (!has(pred)) missing.push(pendingScan(pred) ? `${label}:SCAN_PENDING` : label);
  }
  if (missing.length) throw new MissingEvidenceError(missing);
  return { evidence: clean, mandateDocs: clean.filter((e) => e.evidence_type === 'MANDATE').map((e) => e.document_id) };
}

/** Is the reviewer party to this wallet in any capacity (creator, admin, any role, submitter)? */
async function isParty(q: Queryable, personId: string, w: WalletRow, c: CaseRow): Promise<boolean> {
  if (personId === w.created_by || personId === w.admin_person || personId === c.submitted_by) return true;
  const { rows } = await q.query('SELECT 1 FROM wallet_role WHERE wallet_id = $1 AND person_id = $2', [w.id, personId]);
  return rows.length > 0;
}

// ── Views ───────────────────────────────────────────────────────────────────

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function caseView(c: CaseRow): CaseView {
  return {
    id: c.id,
    submittedAt: c.submitted_at.toISOString(),
    appealOf: c.appeal_of,
    outcome: c.outcome,
    reasonCode: c.reason_code,
    decidedAt: iso(c.decided_at),
  };
}

export async function walletView(q: Queryable, deps: WalletDeps, walletId: string, opts: { staff: boolean }): Promise<WalletView> {
  const w = await loadWallet(q, walletId);
  const evidence: EvidenceView[] = (
    await q.query<UsableEvidence & { created_at: Date }>(
      `SELECT e.id, e.document_id, e.evidence_type, d.malware_scan, e.created_at
         FROM verification_evidence e JOIN document d ON d.id = e.document_id
        WHERE e.wallet_id = $1 AND d.deleted_at IS NULL ORDER BY e.created_at, e.id`,
      [walletId],
    )
  ).rows.map((e) => ({
    id: e.id,
    documentId: e.document_id,
    evidenceType: e.evidence_type,
    scan: e.malware_scan ?? 'PENDING',
    addedAt: e.created_at.toISOString(),
  }));
  const last = await latestCase(q, walletId);
  const active = w.status === 'ACTIVE' && w.public_slug !== null;
  const url = active && w.public_slug ? publicUrl(deps.publicBaseUrl, w.public_slug) : null;
  const view: WalletView = {
    id: w.id,
    status: w.status,
    deceasedName: w.deceased_name,
    dateOfDeath: w.date_of_death,
    funeralDate: w.funeral_date,
    funeralLocation: w.funeral_location,
    currency: w.currency,
    targetMinor: w.target_minor,
    createdByKind: w.created_by_kind,
    createdAt: w.created_at.toISOString(),
    verifiedAt: iso(w.verified_at),
    badge: active ? badgeFor(deps.locale) : null,
    publicSlug: active ? w.public_slug : null,
    share: url ? shareLinks(w.deceased_name, url, deps.locale) : null,
    evidence,
    latestCase: last ? caseView(last) : null,
    canAppeal: w.status === 'VERIFICATION_REJECTED' && last?.outcome === 'REJECTED',
  };
  if (opts.staff) {
    const { rows } = await q.query<{
      id: string;
      rule: FraudRule;
      matched_wallet_id: string | null;
      details: Record<string, unknown>;
      reviewed_at: Date | null;
      review_outcome: 'DISMISSED' | 'CONFIRMED' | null;
    }>(
      `SELECT id, rule, matched_wallet_id, details, reviewed_at, review_outcome
         FROM fraud_flag WHERE wallet_id = $1 ORDER BY created_at, id`,
      [walletId],
    );
    view.fraudFlags = rows.map(
      (f): FraudFlagView => ({
        id: f.id,
        rule: f.rule,
        matchedWalletId: f.matched_wallet_id,
        details: f.details,
        reviewedAt: iso(f.reviewed_at),
        reviewOutcome: f.review_outcome,
      }),
    );
  }
  return view;
}

// ── Command inputs ──────────────────────────────────────────────────────────

export interface CreateDraftInput {
  deceasedName: string;
  dateOfDeath: string;
  funeralDate?: string;
  funeralLocation: string;
  familyContactPhone?: string;
  targetMinor?: bigint;
  currency: 'USD' | 'ZWG';
  /** Agent-assisted only: the family administrator's phone (docs/05 Agent-assisted). */
  adminPhone?: string;
  /** Optional Fidelity link stub (docs/05 Edge). Never gates verification. */
  fidelity?: { policyNo?: string; nationalId?: string };
}

export interface AddEvidenceInput {
  walletId: string;
  documentId: string;
  evidenceType: EvidenceType;
  /** DEATH_CERTIFICATE only; stored as a hash for duplicate detection. */
  certificateNumber?: string;
}

export interface DecideInput {
  caseId: string;
  outcome: VerificationOutcome;
  reasonCode: VerificationReasonCode;
  checklist: Checklist;
  notes?: string;
}

export interface QueueItem {
  caseId: string;
  walletId: string;
  deceasedName: string;
  submittedAt: string;
  appealOf: string | null;
  openFraudFlags: number;
  assignedVerifiers: string[];
}

// ── Commands ────────────────────────────────────────────────────────────────

export function walletCommands(deps: WalletDeps) {
  const clock = deps.clock ?? (() => new Date());
  const fraud = deps.fraud ?? new DeterministicFraudRules();

  async function runFraud(tx: CommandTx, walletId: string): Promise<number> {
    const now = clock();
    const velocityLimit = (await deps.flags.getIn(tx, 'fraud.velocity_max_drafts_24h')) ?? DEFAULT_VELOCITY_LIMIT;
    return recordFindings(tx, walletId, await fraud.evaluate(tx, walletId, { now, velocityLimit }), now);
  }

  const createDraft: Command<CreateDraftInput, WalletView> = {
    name: 'wallet.create_draft',
    async resolve(_q, input, actor) {
      const isAgent = actor.kind === 'STAFF' && actor.staffRole === 'AGENT';
      if (isAgent && !input.adminPhone) throw new ValidationError('adminPhone is required when an agent creates a draft');
      if (!isAgent && input.adminPhone) throw new ValidationError('adminPhone is for agent-assisted drafts only');
      return { action: 'wallet.create_draft', subject: { type: 'wallet', id: 'new' } };
    },
    async run(tx, input, { actor }) {
      const now = clock();
      const today = now.toISOString().slice(0, 10);
      const deceasedName = text(input.deceasedName, 'deceasedName');
      const funeralLocation = text(input.funeralLocation, 'funeralLocation');
      const dateOfDeath = isoDate(input.dateOfDeath, 'dateOfDeath');
      if (dateOfDeath > today) throw new ValidationError('dateOfDeath is in the future');
      const funeralDate = input.funeralDate === undefined ? null : isoDate(input.funeralDate, 'funeralDate');
      if (funeralDate !== null && funeralDate < dateOfDeath) throw new ValidationError('funeralDate is before dateOfDeath');
      if (input.familyContactPhone !== undefined && !PHONE.test(input.familyContactPhone)) throw new ValidationError('familyContactPhone must be E.164');
      if (input.targetMinor !== undefined && input.targetMinor <= 0n) throw new ValidationError('targetMinor must be positive');
      if (input.currency !== 'USD' && input.currency !== 'ZWG') throw new ValidationError('unsupported currency');

      const isAgent = actor.kind === 'STAFF';
      let adminPerson = actor.personId;
      if (isAgent) {
        const phone = input.adminPhone ?? '';
        if (!PHONE.test(phone)) throw new ValidationError('adminPhone must be E.164');
        await tx.query('INSERT INTO person (phone_e164) VALUES ($1) ON CONFLICT (phone_e164) DO NOTHING', [phone]);
        const { rows } = await tx.query<{ id: string }>('SELECT id FROM person WHERE phone_e164 = $1', [phone]);
        adminPerson = rows[0]?.id ?? '';
        if (adminPerson === actor.personId) throw new ValidationError('an agent cannot be the family administrator');
      }

      const id = randomUUID();
      await tx.query(
        `INSERT INTO wallet (id, deceased_name, deceased_name_norm, date_of_death, funeral_date, funeral_location,
                             funeral_location_norm, family_contact_phone, target_minor, currency, admin_person, created_by,
                             created_by_kind, source_channel, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
        [
          id,
          deceasedName,
          normaliseName(deceasedName),
          dateOfDeath,
          funeralDate,
          funeralLocation,
          normaliseLocation(funeralLocation),
          input.familyContactPhone ?? null,
          input.targetMinor?.toString() ?? null,
          input.currency,
          adminPerson,
          actor.personId,
          isAgent ? 'AGENT' : 'CUSTOMER',
          actor.channel === 'SYSTEM' ? 'ADMIN' : actor.channel,
          now,
        ],
      );
      await tx.query('INSERT INTO wallet_role (wallet_id, person_id, role, granted_by) VALUES ($1, $2, $3, $4)', [
        id,
        adminPerson,
        'ADMIN',
        actor.personId,
      ]);
      // The creating agent is assigned to this case (docs/02: agents see assigned cases).
      if (isAgent) {
        await tx.query('INSERT INTO wallet_role (wallet_id, person_id, role, granted_by) VALUES ($1, $2, $3, $4)', [
          id,
          actor.personId,
          'AGENT',
          actor.personId,
        ]);
      }
      await bootstrapWalletAccounts(tx, id, input.currency);
      const f = input.fidelity;
      const policyNo = f?.policyNo?.trim() || null;
      const nationalId = f?.nationalId?.trim() || null;
      if (policyNo || nationalId) {
        await tx.query('INSERT INTO fidelity_link (wallet_id, policy_no, national_id, created_by) VALUES ($1, $2, $3, $4)', [
          id,
          policyNo,
          nationalId,
          actor.personId,
        ]);
      }
      await tx.query(
        `INSERT INTO wallet_status_event (wallet_id, from_status, to_status, actor_id, actor_role, ts)
         VALUES ($1, NULL, 'DRAFT', $2, $3, $4)`,
        [id, actor.personId, actorRoleLabel(actor), now],
      );
      await emit(tx, 'wallet.draft_created', { walletId: id, createdByKind: isAgent ? 'AGENT' : 'CUSTOMER' });
      const flagged = await runFraud(tx, id);
      return {
        result: await walletView(tx, deps, id, { staff: false }),
        audit: { subjectId: id, after: { status: 'DRAFT', createdByKind: isAgent ? 'AGENT' : 'CUSTOMER', fraudFlags: flagged } },
      };
    },
  };

  const view: Command<{ walletId: string }, WalletView> = {
    name: 'wallet.view',
    async resolve(q, input) {
      return { action: 'wallet.view', subject: walletSubject(await loadWallet(q, input.walletId)) };
    },
    async run(tx, input, { actor }) {
      // Fraud flags are internal to verifiers/oversight: not for the family or the assisting agent.
      const staff = actor.kind === 'STAFF' && actor.staffRole !== 'AGENT';
      return { result: await walletView(tx, deps, input.walletId, { staff }) };
    },
  };

  const addEvidence: Command<AddEvidenceInput, EvidenceView> = {
    name: 'verification.add_evidence',
    async resolve(q, input) {
      return { action: 'verification.add_evidence', subject: walletSubject(await loadWallet(q, input.walletId)) };
    },
    async run(tx, input, { actor }) {
      if (!includes(EVIDENCE_TYPES, input.evidenceType)) throw new ValidationError('unknown evidence type');
      const w = await loadWallet(tx, input.walletId, true);
      // Frozen while a reviewer is looking at it; rejected wallets may add evidence for an appeal.
      if (w.status !== 'DRAFT' && w.status !== 'VERIFICATION_REJECTED') throw new ConflictError('WALLET_NOT_EDITABLE');
      if (!UUID.test(input.documentId)) throw new NotFoundError('document', input.documentId);
      const { rows } = await tx.query<{ class: string; linked_wallet: string | null; deleted_at: Date | null; malware_scan: string | null }>(
        'SELECT class, linked_wallet, deleted_at, malware_scan FROM document WHERE id = $1',
        [input.documentId],
      );
      const doc = rows[0];
      if (!doc || doc.deleted_at || doc.linked_wallet !== w.id) throw new NotFoundError('document', input.documentId);
      if (doc.class !== EVIDENCE_DOCUMENT_CLASS[input.evidenceType]) throw new ValidationError('document class does not match evidence type');
      let certHash: string | null = null;
      if (input.certificateNumber !== undefined) {
        if (input.evidenceType !== 'DEATH_CERTIFICATE') throw new ValidationError('certificateNumber is for DEATH_CERTIFICATE only');
        try {
          certHash = certificateNumberHash(input.certificateNumber);
        } catch {
          throw new ValidationError('certificateNumber is too short');
        }
      }
      const now = clock();
      const { rows: ins } = await tx.query<{ id: string }>(
        `INSERT INTO verification_evidence (wallet_id, document_id, evidence_type, certificate_no_hash, added_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (wallet_id, document_id) DO NOTHING RETURNING id`,
        [w.id, input.documentId, input.evidenceType, certHash, actor.personId, now],
      );
      const id = ins[0]?.id;
      if (!id) throw new ConflictError('EVIDENCE_ALREADY_ADDED');
      const flagged = await runFraud(tx, w.id);
      return {
        result: {
          id,
          documentId: input.documentId,
          evidenceType: input.evidenceType,
          scan: (doc.malware_scan as 'CLEAN' | 'INFECTED' | null) ?? 'PENDING',
          addedAt: now.toISOString(),
        },
        audit: { after: { evidenceId: id, evidenceType: input.evidenceType, fraudFlags: flagged } },
      };
    },
  };

  async function openCase(
    tx: CommandTx,
    actor: Actor,
    w: WalletRow,
    appeal: { of: string; reason: string } | null,
  ): Promise<string> {
    // Agent-assisted: the family admin must have confirmed their own identity (OTP) first (docs/05).
    if (w.created_by_kind === 'AGENT') {
      const { rows } = await tx.query(
        'SELECT 1 FROM identity_binding WHERE person_id = $1 AND verified_at IS NOT NULL AND revoked_at IS NULL',
        [w.admin_person],
      );
      if (rows.length === 0) throw new ConflictError('ADMIN_NOT_CONFIRMED');
    }
    const { evidence, mandateDocs } = await completeEvidence(tx, deps.flags, w.id);
    const now = clock();
    // The mandate under review: replaces any earlier, never-approved one.
    await tx.query('UPDATE mandate SET superseded_at = $2, updated_at = $2 WHERE wallet_id = $1 AND superseded_at IS NULL AND approved_at IS NULL', [
      w.id,
      now,
    ]);
    await tx.query('INSERT INTO mandate (wallet_id, admin_person, evidence_docs, created_at) VALUES ($1, $2, $3::uuid[], $4)', [
      w.id,
      w.admin_person,
      mandateDocs,
      now,
    ]);
    const caseId = randomUUID();
    await tx.query(
      `INSERT INTO verification_case (id, wallet_id, evidence, submitted_by, submitted_at, appeal_of, appeal_reason, created_at)
       VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7, $5)`,
      [caseId, w.id, evidence.map((e) => e.id), actor.personId, now, appeal?.of ?? null, appeal?.reason ?? null],
    );
    await setStatus(tx, actor, w, 'PENDING_VERIFICATION', now, { caseId, ...(appeal ? { reasonCode: 'APPEAL' } : {}) });
    await emit(tx, 'wallet.verification_submitted', { walletId: w.id, caseId, appeal: appeal !== null });
    await runFraud(tx, w.id);
    return caseId;
  }

  const submit: Command<{ walletId: string }, { caseId: string; status: WalletStatus }> = {
    name: 'verification.submit',
    async resolve(q, input) {
      return { action: 'verification.submit', subject: walletSubject(await loadWallet(q, input.walletId)) };
    },
    async run(tx, input, { actor }) {
      const w = await loadWallet(tx, input.walletId, true);
      if (w.status !== 'DRAFT') throw new ConflictError('WALLET_NOT_DRAFT');
      const caseId = await openCase(tx, actor, w, null);
      return { result: { caseId, status: 'PENDING_VERIFICATION' }, audit: { after: { status: 'PENDING_VERIFICATION', caseId } } };
    },
  };

  const appeal: Command<{ walletId: string; reason: string }, { caseId: string; status: WalletStatus }> = {
    name: 'verification.appeal',
    async resolve(q, input) {
      return { action: 'verification.appeal', subject: walletSubject(await loadWallet(q, input.walletId)) };
    },
    async run(tx, input, { actor }) {
      const reason = requiredNote(input.reason);
      const w = await loadWallet(tx, input.walletId, true);
      if (w.status !== 'VERIFICATION_REJECTED') throw new ConflictError('NOT_REJECTED');
      const last = await latestCase(tx, w.id);
      if (!last || last.outcome !== 'REJECTED') throw new ConflictError('NOT_REJECTED');
      const caseId = await openCase(tx, actor, w, { of: last.id, reason });
      return { result: { caseId, status: 'PENDING_VERIFICATION' }, audit: { after: { status: 'PENDING_VERIFICATION', caseId, appealOf: last.id } } };
    },
  };

  const assign: Command<{ walletId: string; verifierPersonId: string }, { walletId: string; verifierPersonId: string }> = {
    name: 'verification.assign',
    async resolve(q, input) {
      return { action: 'verification.assign', subject: walletSubject(await loadWallet(q, input.walletId)) };
    },
    async run(tx, input, { actor }) {
      if (!UUID.test(input.verifierPersonId)) throw new ValidationError('verifierPersonId must be a uuid');
      const w = await loadWallet(tx, input.walletId);
      const { rows: staff } = await tx.query(
        "SELECT 1 FROM staff_account WHERE person_id = $1 AND staff_role = 'COMMUNITY_VERIFIER' AND disabled_at IS NULL",
        [input.verifierPersonId],
      );
      if (staff.length === 0) throw new ValidationError('assignee is not an active community verifier');
      if (input.verifierPersonId === w.created_by || input.verifierPersonId === w.admin_person) throw new ConflictError('VERIFIER_IS_PARTY');
      const { rows: roles } = await tx.query('SELECT 1 FROM wallet_role WHERE wallet_id = $1 AND person_id = $2', [w.id, input.verifierPersonId]);
      if (roles.length > 0) throw new ConflictError('VERIFIER_IS_PARTY');
      const { rows: existing } = await tx.query(
        'SELECT 1 FROM staff_assignment WHERE wallet_id = $1 AND staff_person_id = $2 AND revoked_at IS NULL',
        [w.id, input.verifierPersonId],
      );
      if (existing.length === 0) {
        await tx.query('INSERT INTO staff_assignment (staff_person_id, wallet_id, assigned_by) VALUES ($1, $2, $3)', [
          input.verifierPersonId,
          w.id,
          actor.personId,
        ]);
      }
      return { result: { walletId: w.id, verifierPersonId: input.verifierPersonId }, audit: { after: { verifier: input.verifierPersonId } } };
    },
  };

  const queue: Command<Record<string, never>, QueueItem[]> = {
    name: 'verification.queue',
    async resolve(_q, _input, actor) {
      return { action: 'verification.queue', subject: { type: 'verification_queue', id: actor.personId } };
    },
    async run(tx, _input, { actor }) {
      // Verifiers see only cases assigned to them; FIDELITY_ADMIN sees all to route them.
      const mine = actor.staffRole === 'COMMUNITY_VERIFIER';
      const { rows } = await tx.query<{
        id: string;
        wallet_id: string;
        deceased_name: string;
        submitted_at: Date;
        appeal_of: string | null;
        flags: string;
        verifiers: string[] | null;
      }>(
        `SELECT c.id, c.wallet_id, w.deceased_name, c.submitted_at, c.appeal_of,
                (SELECT count(*) FROM fraud_flag f WHERE f.wallet_id = c.wallet_id AND f.reviewed_at IS NULL)::text AS flags,
                (SELECT array_agg(sa.staff_person_id::text ORDER BY sa.created_at) FROM staff_assignment sa
                   WHERE sa.wallet_id = c.wallet_id AND sa.revoked_at IS NULL) AS verifiers
           FROM verification_case c JOIN wallet w ON w.id = c.wallet_id
          WHERE c.outcome IS NULL
            AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM staff_assignment sa
                   WHERE sa.wallet_id = c.wallet_id AND sa.staff_person_id = $1 AND sa.revoked_at IS NULL))
          ORDER BY c.submitted_at, c.id`,
        [mine ? actor.personId : null],
      );
      return {
        result: rows.map((r) => ({
          caseId: r.id,
          walletId: r.wallet_id,
          deceasedName: r.deceased_name,
          submittedAt: r.submitted_at.toISOString(),
          appealOf: r.appeal_of,
          openFraudFlags: Number(r.flags),
          assignedVerifiers: r.verifiers ?? [],
        })),
      };
    },
  };

  const decide: Command<DecideInput, { caseId: string; status: WalletStatus; publicSlug: string | null }> = {
    name: 'verification.decide',
    async resolve(q, input) {
      const c = await loadCase(q, input.caseId);
      const w = await loadWallet(q, c.wallet_id);
      return {
        action: 'verification.decide',
        subject: { type: 'verification_case', id: c.id, walletId: w.id, createdByPersonId: w.created_by },
      };
    },
    async run(tx, input, { actor }) {
      if (!includes(VERIFICATION_OUTCOMES, input.outcome)) throw new ValidationError('unknown outcome');
      if (!includes(VERIFICATION_REASON_CODES, input.reasonCode)) throw new ValidationError('unknown reason code');
      if ((input.outcome === 'APPROVED') !== (input.reasonCode === 'EVIDENCE_SUFFICIENT')) {
        throw new ValidationError('EVIDENCE_SUFFICIENT is the approval reason and only the approval reason');
      }
      const checklist: Partial<Checklist> = input.checklist ?? {};
      for (const item of CHECKLIST_ITEMS) {
        const v = checklist[item];
        if (v !== 'PASS' && v !== 'FAIL') throw new ValidationError(`checklist item ${item} must be PASS or FAIL`);
      }
      if (Object.keys(checklist).some((k) => !includes(CHECKLIST_ITEMS, k))) throw new ValidationError('unknown checklist item');
      if (input.outcome === 'APPROVED' && CHECKLIST_ITEMS.some((i) => checklist[i] !== 'PASS')) throw new ConflictError('CHECKLIST_NOT_PASSED');
      const notes = input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null;
      if (input.outcome !== 'APPROVED' && !notes) throw new ValidationError('notes are required for REJECTED and MORE_INFO');

      const c = await loadCase(tx, input.caseId, true);
      if (c.outcome !== null) throw new ConflictError('CASE_CLOSED');
      const w = await loadWallet(tx, c.wallet_id, true);
      if (w.status !== 'PENDING_VERIFICATION') throw new ConflictError('WALLET_NOT_PENDING');
      // Reviewer ≠ creator ≠ agent ≠ admin (docs/05). Authz covers creator + family roles; this covers the rest.
      if (await isParty(tx, actor.personId, w, c)) throw new ForbiddenError('REVIEWER_IS_PARTY');
      // Appeal route: a different reviewer than the one who rejected.
      if (c.appeal_of) {
        const prior = await loadCase(tx, c.appeal_of);
        if (prior.reviewer === actor.personId) throw new ForbiddenError('APPEAL_SAME_REVIEWER');
      }
      if (input.outcome === 'APPROVED') {
        const { rows } = await tx.query('SELECT 1 FROM fraud_flag WHERE wallet_id = $1 AND reviewed_at IS NULL', [w.id]);
        if (rows.length > 0) throw new ConflictError('OPEN_FRAUD_FLAGS');
      }

      const now = clock();
      await tx.query(
        `UPDATE verification_case SET reviewer = $2, checklist = $3::jsonb, outcome = $4, reason_code = $5, notes = $6,
                decided_at = $7, updated_at = $7 WHERE id = $1`,
        [c.id, actor.personId, JSON.stringify(checklist), input.outcome, input.reasonCode, notes, now],
      );
      let slug: string | null = null;
      if (input.outcome === 'APPROVED') {
        slug = newPublicSlug();
        await setStatus(tx, actor, w, 'ACTIVE', now, { reasonCode: input.reasonCode, caseId: c.id, slug });
        await tx.query(
          'UPDATE mandate SET approved_by = $2, approved_at = $3, updated_at = $3 WHERE wallet_id = $1 AND superseded_at IS NULL',
          [w.id, actor.personId, now],
        );
        await emit(tx, 'wallet.verified', { walletId: w.id, caseId: c.id });
      } else if (input.outcome === 'REJECTED') {
        await setStatus(tx, actor, w, 'VERIFICATION_REJECTED', now, { reasonCode: input.reasonCode, caseId: c.id });
        await emit(tx, 'wallet.verification_rejected', { walletId: w.id, caseId: c.id, reasonCode: input.reasonCode });
      } else {
        // MORE_INFO: back to DRAFT so the family can add evidence and resubmit.
        await setStatus(tx, actor, w, 'DRAFT', now, { reasonCode: input.reasonCode, caseId: c.id });
        await emit(tx, 'wallet.verification_more_info', { walletId: w.id, caseId: c.id, reasonCode: input.reasonCode });
      }
      const status: WalletStatus = input.outcome === 'APPROVED' ? 'ACTIVE' : input.outcome === 'REJECTED' ? 'VERIFICATION_REJECTED' : 'DRAFT';
      return {
        result: { caseId: c.id, status, publicSlug: slug },
        audit: { reasonCode: input.reasonCode, before: { status: w.status }, after: { status, outcome: input.outcome } },
      };
    },
  };

  function statusChange(name: 'wallet.suspend' | 'wallet.unsuspend') {
    const cmd: Command<{ walletId: string; reasonCode?: SuspendReasonCode; note: string }, { walletId: string; status: WalletStatus }> = {
      name,
      async resolve(q, input) {
        return { action: name, subject: walletSubject(await loadWallet(q, input.walletId)) };
      },
      async run(tx, input, { actor }) {
        const note = requiredNote(input.note);
        const suspend = name === 'wallet.suspend';
        if (suspend && !includes(SUSPEND_REASON_CODES, input.reasonCode)) throw new ValidationError('a suspend reason code is required');
        const w = await loadWallet(tx, input.walletId, true);
        const from: WalletStatus = suspend ? 'ACTIVE' : 'SUSPENDED';
        const to: WalletStatus = suspend ? 'SUSPENDED' : 'ACTIVE';
        if (w.status !== from) throw new ConflictError(suspend ? 'WALLET_NOT_ACTIVE' : 'WALLET_NOT_SUSPENDED');
        const reasonCode = suspend ? (input.reasonCode as string) : 'UNSUSPENDED';
        await setStatus(tx, actor, w, to, clock(), { reasonCode, note });
        await emit(tx, suspend ? 'wallet.suspended' : 'wallet.unsuspended', { walletId: w.id, reasonCode });
        return { result: { walletId: w.id, status: to }, audit: { reasonCode, before: { status: from }, after: { status: to } } };
      },
    };
    return cmd;
  }

  const report: Command<
    { slug: string; category: ReportCategory; details?: string; reporterIpHash?: string },
    { reportId: string; caseId: string }
  > = {
    name: 'wallet.report',
    async resolve(q, input) {
      // Only reachable for a public (ACTIVE) wallet: anything else is the same 404.
      const w = await loadPublicWallet(q, input.slug);
      return { action: 'wallet.report', subject: { type: 'wallet', id: w.id } };
    },
    async run(tx, input, { actor }) {
      if (!includes(REPORT_CATEGORIES, input.category)) throw new ValidationError('unknown report category');
      const details = input.details?.trim() ? input.details.trim() : null;
      if (details && details.length > 1000) throw new ValidationError('details must be at most 1000 characters');
      const w = await loadPublicWallet(tx, input.slug);
      const now = clock();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const reporterPerson = actor.kind === 'CUSTOMER' ? actor.personId : null;
      // Abuse brake: 5 reports per hour per reporter (person or hashed IP).
      const { rows: recent } = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM wallet_report
          WHERE created_at > $1 AND (($2::uuid IS NOT NULL AND reporter_person = $2) OR ($3::text IS NOT NULL AND reporter_ip_hash = $3))`,
        [hourAgo, reporterPerson, input.reporterIpHash ?? null],
      );
      if (Number(recent[0]?.n ?? '0') >= 5) throw new RateLimitedError();
      const { rows: cases } = await tx.query<{ id: string }>(
        `INSERT INTO case_record (case_type, wallet_id, summary, opened_by, opened_at)
         VALUES ('FRAUD', $1, $2, $3, $4) RETURNING id`,
        [w.id, `Suspicious-wallet report: ${input.category}`, actorRoleLabel(actor), now],
      );
      const caseId = cases[0]?.id ?? '';
      const { rows: reps } = await tx.query<{ id: string }>(
        `INSERT INTO wallet_report (wallet_id, category, details, reporter_person, reporter_ip_hash, case_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [w.id, input.category, details, reporterPerson, input.reporterIpHash ?? null, caseId, now],
      );
      const reportId = reps[0]?.id ?? '';
      await emit(tx, 'wallet.report_received', { walletId: w.id, reportId, caseId, category: input.category });
      return { result: { reportId, caseId }, audit: { subjectId: w.id, reasonCode: input.category, after: { reportId, caseId } } };
    },
  };

  const reviewFlag: Command<{ flagId: string; outcome: 'DISMISSED' | 'CONFIRMED'; note: string }, { flagId: string }> = {
    name: 'fraud_flag.review',
    async resolve(q, input) {
      if (!UUID.test(input.flagId)) throw new NotFoundError('fraud_flag', input.flagId);
      const { rows } = await q.query<{ wallet_id: string }>('SELECT wallet_id FROM fraud_flag WHERE id = $1', [input.flagId]);
      const row = rows[0];
      if (!row) throw new NotFoundError('fraud_flag', input.flagId);
      return { action: 'fraud_flag.review', subject: { type: 'fraud_flag', id: input.flagId, walletId: row.wallet_id } };
    },
    async run(tx, input, { actor }) {
      if (input.outcome !== 'DISMISSED' && input.outcome !== 'CONFIRMED') throw new ValidationError('outcome must be DISMISSED or CONFIRMED');
      const note = requiredNote(input.note);
      const now = clock();
      // A CONFIRMED flag changes nothing by itself: a human then rejects or suspends with a reason.
      const { rows } = await tx.query(
        `UPDATE fraud_flag SET reviewed_by = $2, reviewed_at = $3, review_outcome = $4, review_note = $5, updated_at = $3
          WHERE id = $1 AND reviewed_at IS NULL RETURNING id`,
        [input.flagId, actor.personId, now, input.outcome, note],
      );
      if (rows.length !== 1) throw new ConflictError('ALREADY_REVIEWED');
      return { result: { flagId: input.flagId }, audit: { reasonCode: input.outcome } };
    },
  };

  return {
    createDraft,
    view,
    addEvidence,
    submit,
    appeal,
    assign,
    queue,
    decide,
    suspend: statusChange('wallet.suspend'),
    unsuspend: statusChange('wallet.unsuspend'),
    report,
    reviewFlag,
  };
}

export type WalletCommands = ReturnType<typeof walletCommands>;

/** Accepted DEATH evidence types (re-exported for channels/forms). */
export { DEATH_EVIDENCE_TYPES };
