// Family "one wallet" view (docs/07 §7, docs/04 §2): source-labelled lines,
// each with its own pending / held / available. A view only: the community,
// group and benefit sub-ledgers are never merged or netted.
import { NotFoundError, type Command } from '@chema/core';
import { getBalances, type SubLedgerBalance } from '@chema/ledger';
import { paymentPendingSource } from '@chema/payments';
import { money, type Money, type Queryable } from '@chema/shared';
import { claimView, type ClaimView } from './commands';
import { linkByWallet, loadWallet, type LinkRow } from './store';

export type BenefitStatus =
  | 'NOT_LINKED'
  | 'LINK_PENDING'
  | 'DUPLICATE_CLAIM'
  | 'LINK_REJECTED'
  | 'CLAIM_SUBMITTED'
  | 'CLAIM_IN_REVIEW'
  | 'CLAIM_MORE_INFO'
  | 'CLAIM_DECLINED'
  | 'ROUTE_PENDING'
  | 'ROUTE_BLOCKED'
  | 'PAYMENT_PENDING'
  | 'CREDITED'
  | 'PAID_DIRECT';

export interface FundsLine {
  source: 'COMMUNITY' | 'GROUP' | 'FIDELITY_BENEFIT';
  /** i18n key for the label shown to the family. */
  labelKey: string;
  groupId: string | null;
  settled: Money;
  pending: Money;
  held: Money;
  available: Money;
  paid: Money;
}

export interface FundsView {
  walletId: string;
  lines: FundsLine[];
  benefit: { status: BenefitStatus; reason: string | null; statusUpdating: boolean };
}

export function benefitStatus(c: ClaimView): BenefitStatus {
  if (c.linkState === 'NONE') return 'NOT_LINKED';
  if (c.linkState === 'QUEUED') return 'LINK_PENDING';
  if (c.linkState === 'DUPLICATE_CLAIM') return 'DUPLICATE_CLAIM';
  if (c.linkState === 'REJECTED') return 'LINK_REJECTED';
  if (c.benefit.credited) return 'CREDITED';
  switch (c.claimStatus) {
    case 'DECLINED':
      return 'CLAIM_DECLINED';
    case 'MORE_INFO':
      return 'CLAIM_MORE_INFO';
    case 'IN_REVIEW':
      return 'CLAIM_IN_REVIEW';
    case 'APPROVED':
      break;
    default:
      return 'CLAIM_SUBMITTED';
  }
  if (c.routeStatus === 'BLOCKED_MISMATCH') return 'ROUTE_BLOCKED';
  if (c.routeStatus !== 'APPROVED') return 'ROUTE_PENDING';
  if (c.routeKind === 'DIRECT') return 'PAID_DIRECT';
  return 'PAYMENT_PENDING';
}

/** Approved-but-not-yet-credited benefit (never spendable). */
function benefitPending(link: LinkRow | undefined): bigint {
  if (!link || link.benefit_journal_id || link.benefit_minor === null) return 0n;
  if (link.claim_status_mirror !== 'APPROVED' || link.route_kind === 'DIRECT') return 0n;
  if (link.benefit_payment_status === 'FAILED') return 0n;
  return BigInt(link.benefit_minor);
}

function line(b: SubLedgerBalance, pendingExtra: bigint): FundsLine {
  const kind = b.account.kind as FundsLine['source'];
  return {
    source: kind,
    labelKey: kind === 'FIDELITY_BENEFIT' ? 'funds.source.fidelity_benefit' : kind === 'GROUP' ? 'funds.source.group' : 'funds.source.community',
    groupId: kind === 'GROUP' ? b.account.qualifier : null,
    settled: b.settled,
    pending: money(b.pending.minor + pendingExtra, b.pending.ccy),
    held: b.held,
    available: b.available,
    paid: b.paid,
  };
}

export async function fundsView(q: Queryable, walletId: string): Promise<FundsView> {
  await loadWallet(q, walletId);
  const link = await linkByWallet(q, walletId);
  const balances = await getBalances(q, walletId, { pending: paymentPendingSource });
  const extra = benefitPending(link);
  const lines = balances.map((b) =>
    line(b, b.account.kind === 'FIDELITY_BENEFIT' && link?.benefit_currency === b.account.currency ? extra : 0n),
  );
  const c = await claimView(q, walletId, link);
  return { walletId, lines, benefit: { status: benefitStatus(c), reason: c.claimReason, statusUpdating: c.statusUpdating } };
}

export function viewCommands() {
  /** Funds for the family / assigned staff (same audience as the ledger view). */
  const funds: Command<{ walletId: string }, FundsView> = {
    name: 'wallet.funds',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId).catch(() => {
        throw new NotFoundError('wallet', String(input.walletId));
      });
      return { action: 'wallet.view_ledger', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input) {
      return { result: await fundsView(tx, input.walletId) };
    },
  };
  return { funds };
}
