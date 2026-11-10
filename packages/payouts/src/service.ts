// PayoutService: the one entry point channels use for P07. Like
// PaymentService and ClaimsService it sequences bus commands and provider
// calls so that no provider call ever runs inside a database transaction.
import {
  SYSTEM_ACTOR,
  decideApproval,
  escalateApproval,
  loadApproval,
  openString,
  type Actor,
  type Command,
  type CommandBus,
  type FlagService,
} from '@chema/core';
import type { RailRegistry } from '@chema/payments';
import { ProviderRejectedError, ProviderTimeoutError, ProviderUnavailableError } from '@chema/providers';
import type { SqlClient } from '@chema/shared';
import { closureCommands } from './closure';
import { governanceCommands } from './governance';
import { mandateCommands } from './mandate';
import { payeeCommands, type AddPayeeInput } from './payees';
import { payoutCommands, type RequestPlanInput } from './payouts';
import { destinationAad, type PayoutDeps, type PayoutKeys } from './store';

export interface PayoutServiceDeps {
  db: SqlClient;
  bus: CommandBus;
  flags: FlagService;
  rails: RailRegistry;
  keys: PayoutKeys;
  clock?: () => Date;
}

export class PayoutService {
  readonly deps: PayoutDeps;
  readonly payees: ReturnType<typeof payeeCommands>;
  readonly payouts: ReturnType<typeof payoutCommands>;
  readonly governance: ReturnType<typeof governanceCommands>;
  readonly mandate: ReturnType<typeof mandateCommands>;
  readonly closure: ReturnType<typeof closureCommands>;
  readonly escalate: ReturnType<typeof escalateApproval>;
  private readonly db: SqlClient;
  private readonly bus: CommandBus;

  constructor(d: PayoutServiceDeps) {
    this.db = d.db;
    this.bus = d.bus;
    this.deps = { flags: d.flags, rails: d.rails, keys: d.keys, clock: d.clock ?? (() => new Date()) };
    this.payees = payeeCommands(this.deps);
    this.payouts = payoutCommands(this.deps);
    this.governance = governanceCommands(this.deps);
    this.mandate = mandateCommands(this.deps);
    this.closure = closureCommands(this.deps);
    this.escalate = escalateApproval(this.deps.clock);
  }

  private system<I, O>(cmd: Command<I, O>, input: I): Promise<O> {
    return this.bus.execute(cmd, input, { actor: SYSTEM_ACTOR });
  }

  run<I, O>(actor: Actor, cmd: Command<I, O>, input: I, stepUpToken?: string): Promise<O> {
    return this.bus.execute(cmd, input, { actor, ...(stepUpToken ? { stepUpToken } : {}) });
  }

  // ── Payees ───────────────────────────────────────────────────────────────

  async addPayee(actor: Actor, input: AddPayeeInput, stepUpToken?: string) {
    const r = await this.run(actor, this.payees.add, input, stepUpToken);
    await this.verifyPayee(r.payee.id);
    const now = (await this.run(actor, this.payees.list, { walletId: input.walletId }).catch(() => [])).find((p) => p.id === r.payee.id);
    return { ...r, payee: now ?? r.payee };
  }

  /** Provider name check (no tx around the call), then try to activate. */
  async verifyPayee(payeeId: string): Promise<void> {
    const { rows } = await this.db.query<{ rail: string; destination_sealed: string; status: string }>(
      'SELECT rail, destination_sealed, status FROM payee WHERE id = $1',
      [payeeId],
    );
    const p = rows[0];
    if (!p || p.status !== 'PENDING') return;
    const adapter = this.deps.rails.adapter(p.rail);
    let registeredName: string | null = null;
    let unavailable = false;
    try {
      if (!adapter) throw new ProviderUnavailableError('no adapter');
      const destination = openString(this.deps.keys.destination, p.destination_sealed, destinationAad(payeeId));
      registeredName = (await adapter.lookupAccountName(destination)).name;
    } catch {
      unavailable = true;
    }
    await this.system(this.payees.recordVerification, { payeeId, registeredName, unavailable });
    await this.system(this.payees.advance, { payeeId });
  }

  // ── Approvals (checker side) ─────────────────────────────────────────────

  /** Checker decision, then move whatever waited on it. */
  async decide(actor: Actor, approvalId: string, decision: 'APPROVED' | 'REJECTED', reasonCode?: string) {
    const r = await this.bus.execute(decideApproval, { approvalId, decision, ...(reasonCode ? { reasonCode } : {}) }, { actor });
    await this.afterDecision(approvalId);
    return r;
  }

  private async afterDecision(approvalId: string): Promise<void> {
    const a = await loadApproval(this.db, approvalId);
    if (!a) return;
    if (a.action === 'payout.request') {
      await this.system(this.payouts.advance, { approvalId });
      const { rows } = await this.db.query<{ id: string }>(`SELECT id FROM payout_request WHERE approval_id = $1 AND status = 'APPROVED'`, [approvalId]);
      for (const r of rows) await this.submit(r.id);
    } else if (a.action === 'wallet.change_payout_destination') {
      await this.system(this.payees.advance, { payeeId: a.subject_id });
    }
  }

  escalateApproval(actor: Actor, approvalId: string, reason: string) {
    return this.run(actor, this.escalate, { approvalId, reason });
  }

  // ── Payouts ──────────────────────────────────────────────────────────────

  async requestPayout(actor: Actor, input: RequestPlanInput, stepUpToken?: string) {
    const r = await this.run(actor, this.payouts.request, input, stepUpToken);
    for (const p of r.payouts) if (p.status === 'APPROVED') await this.submit(p.id);
    return r;
  }

  /** One submission attempt. Never throws for a provider failure (it is recorded). */
  async submit(payoutId: string, opts: { force?: boolean } = {}): Promise<string> {
    const plan = await this.system(this.payouts.claimSubmit, { payoutId, ...(opts.force ? { force: true } : {}) });
    if (plan.kind === 'SKIP') return `SKIP:${plan.reason}`;
    const adapter = this.deps.rails.adapter(plan.rail);
    let outcome: { ok: true; providerRef: string } | { ok: false; kind: 'TIMEOUT' | 'UNAVAILABLE' | 'REJECTED'; reason: string };
    try {
      if (!adapter) throw new ProviderUnavailableError('no adapter');
      const res = await adapter.payout({ reference: plan.reference, amount: plan.amount, destination: plan.destination });
      outcome = { ok: true, providerRef: res.providerRef };
    } catch (err) {
      if (err instanceof ProviderTimeoutError) outcome = { ok: false, kind: 'TIMEOUT', reason: 'timeout' };
      else if (err instanceof ProviderRejectedError) outcome = { ok: false, kind: 'REJECTED', reason: err.message };
      else outcome = { ok: false, kind: 'UNAVAILABLE', reason: err instanceof Error ? err.message : 'unavailable' };
    }
    return (await this.system(this.payouts.recordSubmit, { payoutId, outcome })).status;
  }

  /** Ask the provider about one submitted (or confirmed) payout and apply the answer. */
  async poll(payoutId: string): Promise<string> {
    const { rows } = await this.db.query<{ rail: string; provider_ref: string | null }>('SELECT rail, provider_ref FROM payout_request WHERE id = $1', [payoutId]);
    const row = rows[0];
    if (!row) return 'UNKNOWN';
    const adapter = this.deps.rails.adapter(row.rail);
    let status: Parameters<typeof this.payouts.applyStatus.run>[1]['status'];
    try {
      if (!adapter) throw new ProviderUnavailableError('no adapter');
      status = await adapter.queryPayout({ reference: payoutId, ...(row.provider_ref ? { providerRef: row.provider_ref } : {}) });
    } catch {
      status = { state: 'UNREACHABLE' };
    }
    return (await this.system(this.payouts.applyStatus, { payoutId, status })).status;
  }

  /** Worker handler for `payout.event` (a provider callback is a trigger only). */
  async processEvent(e: { rail: string; providerRef: string; reference?: string }): Promise<string> {
    const { payoutId } = await this.system(this.payouts.findByProvider, e);
    return payoutId ? this.poll(payoutId) : 'UNKNOWN_PAYOUT';
  }

  /**
   * Worker loop: decisions made elsewhere, due submissions and retries, due
   * polls, pending payee checks. Each step is idempotent.
   */
  async runDue(limit = 50): Promise<{ advanced: number; submitted: number; polled: number; payees: number }> {
    const now = this.deps.clock().toISOString();
    const out = { advanced: 0, submitted: 0, polled: 0, payees: 0 };
    const { rows: decided } = await this.db.query<{ id: string }>(
      `SELECT DISTINCT a.id FROM approval a JOIN payout_request r ON r.approval_id = a.id
        WHERE r.status = 'AWAITING_APPROVAL' AND a.decision IS NOT NULL LIMIT $1`,
      [limit],
    );
    for (const a of decided) {
      await this.afterDecision(a.id);
      out.advanced++;
    }
    const { rows: due } = await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM payout_request
        WHERE (status IN ('APPROVED', 'RETRY', 'SUBMITTED') AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
           OR (status = 'SUBMITTING' AND lease_until < $1)
        ORDER BY next_attempt_at NULLS FIRST LIMIT $2`,
      [now, limit],
    );
    for (const r of due) {
      if (r.status === 'SUBMITTED') {
        await this.poll(r.id);
        out.polled++;
      } else if (r.status === 'SUBMITTING') {
        // Lease expired mid-call: the provider may have it. Record it as a timeout and ask.
        await this.system(this.payouts.recordSubmit, { payoutId: r.id, outcome: { ok: false, kind: 'TIMEOUT', reason: 'lease expired' } });
      } else {
        await this.submit(r.id);
        out.submitted++;
      }
    }
    const { rows: payees } = await this.db.query<{ id: string; verification: string | null }>(
      `SELECT p.id, p.verification FROM payee p JOIN approval a ON a.id = p.approval_id
        WHERE p.status = 'PENDING' AND (p.verification IS NULL OR p.verification = 'UNAVAILABLE' OR a.decision IS NOT NULL) LIMIT $1`,
      [limit],
    );
    for (const p of payees) {
      if (p.verification === null || p.verification === 'UNAVAILABLE') await this.verifyPayee(p.id);
      else await this.system(this.payees.advance, { payeeId: p.id });
      out.payees++;
    }
    return out;
  }

  /** Worker: case + recon-exception ageing/escalation. */
  sweep() {
    return this.system(this.governance.sweep, {});
  }
}
