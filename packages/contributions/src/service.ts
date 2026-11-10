// ContributionService: the entry point channels use (web now, WhatsApp in P08).
// It sequences command → provider → command so no provider call runs inside a
// database transaction (same rule as PaymentService).
import { SYSTEM_ACTOR, type Actor, type CommandBus, type FlagService, type Secrets } from '@chema/core';
import type { PaymentService } from '@chema/payments';
import type { Locale, Money, SqlClient } from '@chema/shared';
import { contributionCommands, type ContributionCommands } from './commands';
import { contributionKeys, type ContributionKeys } from './keys';
import { DeterministicModerationRules, type ModerationRules } from './moderation';
import { publicPage, publicPhotoDoc, publicQuote, publicTotal, publicTributesBySlug } from './public';
import type { ContributeInput, ContributeResult } from './types';

export interface ContributionServiceDeps {
  db: SqlClient;
  bus: CommandBus;
  flags: FlagService;
  payments: PaymentService;
  secrets: Secrets;
  publicBaseUrl: string;
  moderation?: ModerationRules;
  clock?: () => Date;
}

export class ContributionService {
  readonly commands: ContributionCommands;
  readonly keys: ContributionKeys;
  private readonly clock: () => Date;

  constructor(private readonly d: ContributionServiceDeps) {
    this.clock = d.clock ?? (() => new Date());
    this.keys = contributionKeys(d.secrets);
    this.commands = contributionCommands({
      flags: d.flags,
      payments: d.payments.deps,
      keys: this.keys,
      notifyKey: d.secrets.dataKey,
      moderation: d.moderation ?? new DeterministicModerationRules(),
      publicBaseUrl: d.publicBaseUrl,
      clock: this.clock,
    });
  }

  /** Create the contribution + payment (one tx), then send it to the provider. */
  async contribute(actor: Actor, input: ContributeInput): Promise<ContributeResult> {
    const r = await this.d.bus.execute(this.commands.create, input, { actor });
    const { needsSubmission, payerMsisdn, paymentView, ...result } = r;
    if (!needsSubmission) return result;
    const submitted = await this.d.payments.submit(paymentView, payerMsisdn);
    return { ...result, payment: { id: submitted.id, state: submitted.state, disclosure: submitted.disclosure, next: submitted.next } };
  }

  /** Worker handler for `payment.succeeded` / `payment.failed`. Idempotent. */
  settle(paymentId: string) {
    return this.d.bus.execute(this.commands.settle, { paymentId }, { actor: SYSTEM_ACTOR });
  }

  view(actor: Actor, contributionId: string, token?: string) {
    return this.d.bus.execute(this.commands.view, { contributionId, ...(token ? { token } : {}) }, { actor });
  }

  reissueReceipt(actor: Actor, contributionId: string, token?: string) {
    return this.d.bus.execute(this.commands.reissueReceipt, { contributionId, ...(token ? { token } : {}) }, { actor });
  }

  removeTribute(actor: Actor, contributionId: string, token?: string) {
    return this.d.bus.execute(this.commands.manageTribute, { contributionId, op: 'REMOVE', ...(token ? { token } : {}) }, { actor });
  }

  appealTribute(actor: Actor, contributionId: string, reason: string | undefined, token?: string) {
    return this.d.bus.execute(
      this.commands.manageTribute,
      { contributionId, op: 'APPEAL', ...(reason ? { reason } : {}), ...(token ? { token } : {}) },
      { actor },
    );
  }

  private get publicDeps() {
    return { flags: this.d.flags, rails: this.d.payments.deps.rails, publicBaseUrl: this.d.publicBaseUrl };
  }

  page(slug: string, locale: Locale = 'en') {
    return publicPage(this.d.db, this.publicDeps, slug, locale);
  }

  quote(slug: string, rail: string, amount: Money) {
    return publicQuote(this.d.db, this.publicDeps, slug, rail, amount, this.clock());
  }

  total(slug: string) {
    return publicTotal(this.d.db, slug);
  }

  tributes(slug: string, opts: { before?: Date; limit?: number } = {}) {
    return publicTributesBySlug(this.d.db, slug, opts);
  }

  photoDocument(slug: string) {
    return publicPhotoDoc(this.d.db, slug);
  }
}
