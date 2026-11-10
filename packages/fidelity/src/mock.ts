// MockFidelity: an in-memory Fidelity Claims module for development and tests.
// Policies are seeded per scenario (docs/07: no policy, inactive, covered-life
// mismatch, arrears, duplicate claim, pending, declined, approved, beneficiary
// mismatch, benefit payment not settled); claim decisions, routes and benefit
// payments are driven explicitly by the test/dev operator, the way a Fidelity
// officer would act. Callbacks are signed with the shared HMAC scheme.
import { randomUUID } from 'node:crypto';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, WebhookRejectedError, sign, verifySignature } from '@chema/providers';
import type { Money } from '@chema/shared';
import {
  DuplicateClaimError,
  FIDELITY_EVENT_TYPES,
  FidelityUnavailableError,
  type BenefitPayment,
  type BenefitSettlementRow,
  type ClaimRequest,
  type ClaimStatus,
  type ClaimStatusReport,
  type FidelityAdapter,
  type FidelityEvent,
  type FidelityEventType,
  type PolicyIdentifier,
  type PolicyRecord,
  type RecipientRoute,
  type Requester,
} from './adapter';

export const MOCK_SCENARIOS = [
  'APPROVED',
  'NO_POLICY',
  'INACTIVE',
  'COVERED_LIFE_MISMATCH',
  'ARREARS',
  'DUPLICATE_CLAIM',
  'PENDING',
  'DECLINED',
  'BENEFICIARY_MISMATCH',
  'NOT_SETTLED',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

interface MockClaim {
  claimRef: string;
  key: string;
  walletRef: string;
  policyNo: string;
  deceasedName: string;
  status: ClaimStatusReport;
  evidence: string[];
  route: RecipientRoute | null;
  payment: BenefitPayment | null;
}

export interface SignedCallback {
  headers: Record<string, string>;
  body: string;
}

const norm = (s: string) => s.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();

export interface MockFidelityOptions {
  webhookSecret: string;
  clock?: () => Date;
}

export class MockFidelity implements FidelityAdapter {
  readonly name = 'MOCK_FIDELITY';
  /** true ⇒ every call fails with FidelityUnavailableError (outage drill). */
  down = false;
  /** Every call made, in order (tests assert idempotency on it). */
  readonly calls: { op: string; arg: unknown }[] = [];
  private readonly policies = new Map<string, PolicyRecord>();
  private readonly byNationalId = new Map<string, string>();
  private readonly claims = new Map<string, MockClaim>();
  private readonly claimsByKey = new Map<string, string>();
  /** policyNo|deceased ⇒ a claim lodged outside this Chema wallet (duplicate drill). */
  private readonly foreignClaims = new Set<string>();
  private readonly outbox: SignedCallback[] = [];
  private readonly clock: () => Date;

  constructor(private readonly opts: MockFidelityOptions) {
    this.clock = opts.clock ?? (() => new Date());
  }

  // ── Seeding ────────────────────────────────────────────────────────────────
  addPolicy(p: PolicyRecord): void {
    this.policies.set(p.policyNo, p);
    for (const l of p.coveredLives) if (l.nationalId) this.byNationalId.set(l.nationalId, p.policyNo);
  }

  /**
   * Seed a policy for one doc 07 scenario covering `deceased`. Returns the
   * policy number (NO_POLICY returns an unknown number). Decisions are still
   * driven explicitly: see `approve`, `decline`, `routeTo`, `pay`.
   */
  seed(scenario: MockScenario, deceased: { name: string; nationalId?: string }): string {
    const policyNo = `POL-${randomUUID().slice(0, 8).toUpperCase()}`;
    if (scenario === 'NO_POLICY') return policyNo;
    const life = { lifeRef: `L-${randomUUID().slice(0, 6)}`, name: deceased.name, ...(deceased.nationalId ? { nationalId: deceased.nationalId } : {}) };
    const other = { lifeRef: `L-${randomUUID().slice(0, 6)}`, name: 'Someone Else Entirely' };
    this.addPolicy({
      policyNo,
      status: scenario === 'INACTIVE' ? 'LAPSED' : 'ACTIVE',
      premiumStatus: scenario === 'ARREARS' ? 'ARREARS' : 'UP_TO_DATE',
      coveredLives: scenario === 'COVERED_LIFE_MISMATCH' ? [other] : [life],
    });
    if (scenario === 'DUPLICATE_CLAIM') this.foreignClaims.add(`${policyNo}|${norm(deceased.name)}`);
    return policyNo;
  }

  // ── Adapter ────────────────────────────────────────────────────────────────
  private guard(op: string, arg: unknown): void {
    this.calls.push({ op, arg });
    if (this.down) throw new FidelityUnavailableError('mock outage');
  }

  private claim(claimRef: string): MockClaim {
    const c = this.claims.get(claimRef);
    if (!c) throw new Error(`mock: unknown claim ${claimRef}`);
    return c;
  }

  async lookupPolicy(identifier: PolicyIdentifier, requester: Requester): Promise<PolicyRecord | null> {
    this.guard('lookupPolicy', { identifier, requester });
    const policyNo = identifier.policyNo ?? (identifier.nationalId ? this.byNationalId.get(identifier.nationalId) : undefined);
    return (policyNo && this.policies.get(policyNo)) || null;
  }

  async createOrLinkClaim(req: ClaimRequest): Promise<{ claimRef: string }> {
    this.guard('createOrLinkClaim', req);
    const existing = this.claimsByKey.get(req.idempotencyKey);
    if (existing) return { claimRef: existing };
    const deceasedKey = `${req.policyNo}|${norm(req.deceased.name)}`;
    if (this.foreignClaims.has(deceasedKey)) throw new DuplicateClaimError();
    const claimRef = `CLM-${randomUUID().slice(0, 12).toUpperCase()}`;
    this.claims.set(claimRef, {
      claimRef,
      key: req.idempotencyKey,
      walletRef: req.walletRef,
      policyNo: req.policyNo,
      deceasedName: req.deceased.name,
      status: { status: 'SUBMITTED' },
      evidence: [...req.evidenceRefs],
      route: null,
      payment: null,
    });
    this.claimsByKey.set(req.idempotencyKey, claimRef);
    // A second wallet for the same deceased is a duplicate from now on.
    this.foreignClaims.add(deceasedKey);
    return { claimRef };
  }

  async getClaimStatus(claimRef: string): Promise<ClaimStatusReport> {
    this.guard('getClaimStatus', claimRef);
    return { ...this.claim(claimRef).status };
  }

  async submitEvidence(claimRef: string, docRefs: readonly string[]): Promise<void> {
    this.guard('submitEvidence', { claimRef, docRefs });
    const c = this.claim(claimRef);
    for (const d of docRefs) if (!c.evidence.includes(d)) c.evidence.push(d);
  }

  verifyWebhook(headers: Readonly<Record<string, string | undefined>>, rawBody: string, now: Date): FidelityEvent {
    verifySignature(this.opts.webhookSecret, headers, rawBody, now);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookRejectedError('MALFORMED');
    }
    const e = parsed as Partial<FidelityEvent>;
    if (
      typeof e.eventId !== 'string' || e.eventId.length < 1 || e.eventId.length > 128 ||
      typeof e.claimRef !== 'string' || e.claimRef.length < 1 || e.claimRef.length > 128 ||
      !(FIDELITY_EVENT_TYPES as readonly string[]).includes(String(e.type))
    ) {
      throw new WebhookRejectedError('MALFORMED');
    }
    return { eventId: e.eventId, type: e.type as FidelityEventType, claimRef: e.claimRef };
  }

  async getApprovedRecipientRoute(claimRef: string): Promise<RecipientRoute | null> {
    this.guard('getApprovedRecipientRoute', claimRef);
    const r = this.claim(claimRef).route;
    return r ? { ...r, recipient: { ...r.recipient }, approvedBy: [...r.approvedBy] } : null;
  }

  async getBenefitPayment(claimRef: string): Promise<BenefitPayment | null> {
    this.guard('getBenefitPayment', claimRef);
    const p = this.claim(claimRef).payment;
    return p ? { ...p } : null;
  }

  async benefitSettlements(date: string): Promise<readonly BenefitSettlementRow[]> {
    this.guard('benefitSettlements', date);
    const out: BenefitSettlementRow[] = [];
    for (const c of this.claims.values()) {
      const p = c.payment;
      if (p?.status === 'SETTLED' && p.settledOn === date) {
        out.push({ paymentRef: p.paymentRef, claimRef: c.claimRef, walletRef: c.walletRef, amount: p.amount, settledOn: date });
      }
    }
    return out;
  }

  // ── Operator drivers (a Fidelity officer acting in Fidelity's system) ─────
  claimRefs(): string[] {
    return [...this.claims.keys()];
  }

  evidenceOf(claimRef: string): readonly string[] {
    return [...this.claim(claimRef).evidence];
  }

  setStatus(claimRef: string, status: ClaimStatus, reasonCode?: string): void {
    this.claim(claimRef).status = { status, ...(reasonCode ? { reasonCode } : {}) };
    const type: FidelityEventType = status === 'APPROVED' ? 'claim.approved' : status === 'DECLINED' ? 'claim.declined' : 'claim.status_changed';
    this.emit(type, claimRef);
  }

  approve(claimRef: string): void {
    this.setStatus(claimRef, 'APPROVED');
  }

  decline(claimRef: string, reasonCode = 'POLICY_EXCLUSION'): void {
    this.setStatus(claimRef, 'DECLINED', reasonCode);
  }

  /** Record the approved recipient route (Claims/Finance/Legal) for the claim. */
  routeTo(claimRef: string, recipientIdNumber: string, opts: { route?: 'WALLET' | 'DIRECT'; approvedBy?: string[] } = {}): void {
    this.claim(claimRef).route = {
      routeRef: `RTE-${randomUUID().slice(0, 8).toUpperCase()}`,
      route: opts.route ?? 'WALLET',
      recipient: { idNumber: recipientIdNumber },
      approvedBy: opts.approvedBy ?? ['CLAIMS', 'FINANCE', 'LEGAL'],
    };
    this.emit('route.decided', claimRef);
  }

  /** Record the benefit payment. `settledOn` (YYYY-MM-DD) defaults to the clock's day when SETTLED. */
  pay(claimRef: string, amount: Money, status: BenefitPayment['status'] = 'SETTLED', settledOn?: string): void {
    const c = this.claim(claimRef);
    const paymentRef = c.payment?.paymentRef ?? `BEN-${randomUUID().slice(0, 10).toUpperCase()}`;
    c.payment = {
      paymentRef,
      amount,
      status,
      ...(status === 'SETTLED' ? { settledOn: settledOn ?? this.clock().toISOString().slice(0, 10) } : {}),
    };
    this.emit('benefit.paid', claimRef);
  }

  /** Signed callbacks waiting to be delivered (drained). */
  takeWebhooks(): SignedCallback[] {
    return this.outbox.splice(0);
  }

  /** Build a signed callback (tests: forged / replayed variants). */
  signed(body: string, at: Date = this.clock()): SignedCallback {
    const ts = (BigInt(at.getTime()) / 1000n).toString();
    return {
      headers: { [SIGNATURE_HEADER]: sign(this.opts.webhookSecret, ts, body), [TIMESTAMP_HEADER]: ts, 'content-type': 'application/json' },
      body,
    };
  }

  private emit(type: FidelityEventType, claimRef: string): void {
    this.outbox.push(this.signed(JSON.stringify({ eventId: `EVT-${randomUUID()}`, type, claimRef })));
  }
}
