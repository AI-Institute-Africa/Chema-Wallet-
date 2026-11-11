// Contribution commands (docs/06). Every state change and every sensitive read
// runs through the CommandBus: authorised, audited, one transaction. The money
// side is @chema/payments: a contribution creates its payment in the SAME
// transaction (createPayment) and is credited only by applyConfirmation.
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PhoneE164,
  RateLimitedError,
  ValidationError,
  canonicalJson,
  enqueueOutbox,
  seal,
  sha256Hex,
  unseal,
  type Actor,
  type Command,
  type CommandTx,
  type FlagService,
} from '@chema/core';
import { enqueueNotification } from '@chema/channels';
import { createPayment, disclosureOf, type PaymentDeps, type PaymentState, type PaymentView } from '@chema/payments';
import type { NextAction } from '@chema/providers';
import { format, money, parseMinor, t, type Currency, type Money, type Queryable } from '@chema/shared';
import { loadPublicWallet, loadWallet } from '@chema/wallet';
import { linkToken, linkTokenValid, phoneHash, type ContributionKeys } from './keys';
import type { ModerationRules } from './moderation';
import { contributionLimits, raisedTotal } from './public';
import {
  CONTACT_KINDS,
  PRIVACY_KEYS,
  privacyOf,
  type ContributeInput,
  type ContributeResult,
  type ContributionReceipt,
  type ContributionView,
  type ModerationQueueItem,
  type PrivacySettings,
  type TributeStatus,
} from './types';

export interface ContributionDeps {
  flags: FlagService;
  payments: PaymentDeps;
  keys: ContributionKeys;
  /** Seals notification addresses + params (the platform data key). */
  notifyKey: Buffer;
  moderation: ModerationRules;
  publicBaseUrl: string;
  clock: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;
/** Receipt re-issues per contribution per 24 h (abuse brake on a public endpoint). */
export const REISSUE_LIMIT_24H = 5;

interface ContributionRow {
  id: string;
  wallet_id: string;
  payment_id: string;
  group_id: string | null;
  anonymous: boolean;
  display_name: string | null;
  contact_kind: 'PHONE' | 'EMAIL' | null;
  contact_sealed: string | null;
  contributor_person: string | null;
  /** Channel the contribution was made on (WEB / WHATSAPP / ...). */
  channel: string;
  request_hash: string;
  settled_state: string | null;
  created_at: Date;
}

const C_COLS = `id, wallet_id, payment_id, group_id, anonymous, display_name, contact_kind, contact_sealed, contributor_person,
  channel, request_hash, settled_state, created_at`;

/** Receipts go back the way the contributor came: WhatsApp contributions get them on WhatsApp (P08). */
const receiptChannel = (c: ContributionRow) => (c.contact_kind === 'PHONE' ? (c.channel === 'WHATSAPP' ? 'WHATSAPP' : 'SMS') : 'EMAIL');

async function loadContribution(q: Queryable, id: string, lock = false): Promise<ContributionRow> {
  if (!UUID.test(id)) throw new NotFoundError('contribution', id);
  const { rows } = await q.query<ContributionRow>(`SELECT ${C_COLS} FROM contribution WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new NotFoundError('contribution', id);
  return rows[0];
}

const subjectOf = (c: ContributionRow) => ({
  type: 'contribution',
  id: c.id,
  walletId: c.wallet_id,
  ...(c.contributor_person ? { ownerPersonId: c.contributor_person } : {}),
});

/** PUBLIC actors prove ownership with the signed link; customers pass the matrix as owner. */
function linkGuard(keys: ContributionKeys) {
  return async (_q: Queryable, input: { contributionId: string; token?: string }, actor: Actor): Promise<string | null> => {
    if (actor.kind !== 'PUBLIC') return null;
    return linkTokenValid(keys, input.contributionId, input.token) ? null : 'BAD_LINK';
  };
}

interface TributeRow {
  id: string;
  contribution_id: string;
  wallet_id: string;
  message: string | null;
  status: TributeStatus;
  flag_reasons: string[];
  appealed: boolean;
  published_at: Date | null;
}

async function tributeOf(q: Queryable, contributionId: string, lock = false): Promise<TributeRow | undefined> {
  const { rows } = await q.query<TributeRow>(
    `SELECT id, contribution_id, wallet_id, message, status, flag_reasons, appealed, published_at FROM tribute
      WHERE contribution_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [contributionId],
  );
  return rows[0];
}

async function moveTribute(
  tx: CommandTx,
  tr: TributeRow,
  to: TributeStatus,
  actor: Actor,
  reasonCode: string,
  now: Date,
  extra: { note?: string; erase?: boolean; appealed?: boolean } = {},
): Promise<void> {
  const publish = to === 'VISIBLE' && tr.published_at === null;
  await tx.query(
    `UPDATE tribute SET status = $2, updated_at = $3,
            published_at = CASE WHEN $4 THEN $3::timestamptz ELSE published_at END,
            message = CASE WHEN $5 THEN NULL ELSE message END,
            appealed = appealed OR $6
      WHERE id = $1`,
    [tr.id, to, now.toISOString(), publish, extra.erase === true, extra.appealed === true],
  );
  await tx.query(
    `INSERT INTO tribute_event (tribute_id, from_status, to_status, actor_id, actor_role, reason_code, note, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tr.id, tr.status, to, actor.personId, actor.kind === 'STAFF' ? (actor.staffRole ?? 'STAFF') : actor.kind, reasonCode, extra.note ?? null, now.toISOString()],
  );
}

interface PaymentBits {
  state: PaymentState;
  rail: string;
  currency: Currency;
  gross_minor: string;
  fee_minor: string;
  net_minor: string;
  fee_payer: 'CONTRIBUTOR' | 'WALLET' | null;
  fx_rate: string | null;
  next_action: NextAction | null;
  receipt_id: string | null;
}

async function paymentBits(q: Queryable, paymentId: string): Promise<PaymentBits> {
  const { rows } = await q.query<PaymentBits>(
    `SELECT state, rail, currency, gross_minor::text AS gross_minor, fee_minor::text AS fee_minor, net_minor::text AS net_minor,
            fee_payer, fx_rate, next_action, receipt_id FROM payment WHERE id = $1`,
    [paymentId],
  );
  if (!rows[0]) throw new NotFoundError('payment', paymentId);
  return rows[0];
}

function disclosure(p: PaymentBits) {
  const m = (v: string): Money => money(parseMinor(v), p.currency);
  return disclosureOf({ gross: m(p.gross_minor), fee: m(p.fee_minor), net: m(p.net_minor), feePayer: p.fee_payer, fxRate: p.fx_rate });
}

/** What the contributor gave (net when they paid the fee on top, gross when the wallet bore it). */
function giftOf(r: { amount: Money; net: Money }, feePayer: PaymentBits['fee_payer']): Money {
  return feePayer === 'CONTRIBUTOR' ? r.net : r.amount;
}

async function loadReceipt(q: Queryable, c: ContributionRow): Promise<ContributionReceipt | null> {
  const { rows } = await q.query<{
    receipt_no: string;
    rail: string;
    currency: Currency;
    gross_minor: string;
    fee_minor: string;
    net_minor: string;
    provider_ref: string;
    issued_at: Date;
    fx_rate: string | null;
    deceased_name: string;
  }>(
    `SELECT r.receipt_no, r.rail, r.currency, r.gross_minor::text AS gross_minor, r.fee_minor::text AS fee_minor,
            r.net_minor::text AS net_minor, r.provider_ref, r.issued_at, p.fx_rate, w.deceased_name
       FROM receipt r JOIN payment p ON p.id = r.payment_id JOIN wallet w ON w.id = r.wallet_id
      WHERE r.payment_id = $1`,
    [c.payment_id],
  );
  const r = rows[0];
  if (!r) return null;
  const m = (v: string): Money => money(parseMinor(v), r.currency);
  return {
    receiptNo: r.receipt_no,
    funeralName: r.deceased_name,
    walletRef: walletRef(c.wallet_id),
    paymentRef: r.provider_ref,
    rail: r.rail,
    amount: m(r.gross_minor),
    fee: m(r.fee_minor),
    net: m(r.net_minor),
    fxRate: r.fx_rate,
    issuedAt: new Date(r.issued_at).toISOString(),
  };
}

export const walletRef = (walletId: string) => `W-${walletId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

export function contributionCommands(deps: ContributionDeps) {
  const { keys, clock } = deps;
  const guardLink = linkGuard(keys);
  const sealText = (value: string, aad: string) => seal(keys.data, Buffer.from(value, 'utf8'), aad).toString('base64');
  const openText = (value: string, aad: string) => unseal(keys.data, Buffer.from(value, 'base64'), aad).toString('utf8');
  const statusLink = (id: string) => `${deps.publicBaseUrl.replace(/\/+$/, '')}/c/${id}#t=${linkToken(keys, id)}`;

  async function buildView(q: Queryable, c: ContributionRow): Promise<ContributionView> {
    const p = await paymentBits(q, c.payment_id);
    const tr = await tributeOf(q, c.id);
    const { rows: w } = await q.query<{ deceased_name: string }>('SELECT deceased_name FROM wallet WHERE id = $1', [c.wallet_id]);
    let groupName: string | null = null;
    if (c.group_id) {
      const { rows } = await q.query<{ name: string }>('SELECT name FROM contribution_group WHERE id = $1', [c.group_id]);
      groupName = rows[0]?.name ?? null;
    }
    return {
      id: c.id,
      walletId: c.wallet_id,
      funeralName: w[0]?.deceased_name ?? '',
      state: p.state,
      disclosure: disclosure(p),
      next: p.state === 'INITIATED' || p.state === 'PENDING_UNKNOWN' ? p.next_action : null,
      anonymous: c.anonymous,
      displayName: c.display_name,
      groupName,
      tribute: tr ? { status: tr.status, message: tr.message, flagReasons: tr.flag_reasons, appealed: tr.appealed } : null,
      receipt: await loadReceipt(q, c),
      createdAt: new Date(c.created_at).toISOString(),
    };
  }

  // ── Contribute (no account needed) ─────────────────────────────────────────
  const create: Command<ContributeInput, ContributeResult & { needsSubmission: boolean; payerMsisdn: string; paymentView: PaymentView }> = {
    name: 'contribution.create',
    async resolve(q, input) {
      const w = await loadPublicWallet(q, input.slug);
      return { action: 'contribution.create', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async guard(q, input, actor, subject) {
      if (input.groupId === undefined) return null;
      if (!UUID.test(input.groupId)) return 'NOT_GROUP_REPRESENTATIVE';
      const { rows } = await q.query<{ representative_person: string; wallet_id: string }>(
        'SELECT representative_person, wallet_id FROM contribution_group WHERE id = $1',
        [input.groupId],
      );
      const g = rows[0];
      // Only the group's authorised representative pays in the group's name.
      if (!g || g.wallet_id !== subject.walletId || actor.kind !== 'CUSTOMER' || g.representative_person !== actor.personId) {
        return 'NOT_GROUP_REPRESENTATIVE';
      }
      return null;
    },
    async run(tx, input, ctx) {
      const now = clock();
      const w = await loadPublicWallet(tx, input.slug);
      const payerName = input.payerName.trim();
      if (payerName.length < 2 || payerName.length > 120) throw new ValidationError('payer name required');
      const phone = PhoneE164.safeParse(input.payerPhone);
      if (!phone.success) throw new ValidationError('payer phone required');
      const displayName = input.anonymous ? null : (input.displayName ?? '').trim();
      if (displayName !== null && (displayName.length < 1 || displayName.length > 60)) throw new ValidationError('display name required');
      const tribute = input.tribute?.trim() ? input.tribute.trim() : null;
      if (tribute && tribute.length > 500) throw new ValidationError('tribute too long');
      if (input.contact) {
        if (!(CONTACT_KINDS as readonly string[]).includes(input.contact.kind)) throw new ValidationError('bad contact');
        const ok = input.contact.kind === 'PHONE' ? PhoneE164.safeParse(input.contact.value).success : EMAIL.test(input.contact.value);
        if (!ok) throw new ValidationError('bad contact');
      }

      // Money rules (docs/06 Contribute 1; docs/13): limits from config, never hard-coded.
      if (input.amount.ccy !== w.currency) throw new ConflictError('CURRENCY_NOT_ACCEPTED');
      const limits = await contributionLimits(tx, deps.flags, w.currency);
      if (limits.max === null) throw new ConflictError('CONTRIBUTION_LIMITS_NOT_CONFIGURED');
      if (input.amount.minor < limits.min.minor) throw new ConflictError('AMOUNT_BELOW_MINIMUM');
      if (input.amount.minor > limits.max.minor) throw new ConflictError('AMOUNT_ABOVE_MAXIMUM');
      // Light KYC only up to the ceiling; above it full KYC would be needed, which is not built.
      const light = await deps.flags.getIn(tx, 'kyc.contributor_light_max_minor');
      if (light !== null && input.amount.minor > light) throw new ConflictError('FULL_KYC_REQUIRED');
      if (input.groupId !== undefined && !(await deps.flags.getIn(tx, 'feature.group_contributions'))) {
        throw new ForbiddenError('GROUP_CONTRIBUTIONS_DISABLED');
      }

      const requestHash = sha256Hex(
        canonicalJson({
          slug: input.slug,
          rail: input.rail,
          amount: input.amount.minor,
          ccy: input.amount.ccy,
          payer: ctx.actor.personId,
          payerName,
          payerPhone: phone.data,
          anonymous: input.anonymous,
          displayName,
          tribute,
          contact: input.contact ?? null,
          group: input.groupId ?? null,
        }),
      );

      const pay = await createPayment(tx, deps.payments, ctx.actor, {
        walletId: w.id,
        rail: input.rail,
        amount: input.amount,
        idempotencyKey: input.idempotencyKey,
        // Mobile money prompts this handset; card checkout ignores it. Never a PIN.
        payerMsisdn: phone.data,
        ...(input.groupId ? { groupId: input.groupId } : {}),
      });
      const view = { id: pay.payment.id, state: pay.payment.state, disclosure: pay.payment.disclosure, next: pay.payment.next };

      if (pay.replayed) {
        const { rows } = await tx.query<{ id: string; request_hash: string }>('SELECT id, request_hash FROM contribution WHERE payment_id = $1', [pay.payment.id]);
        const prior = rows[0];
        if (!prior || prior.request_hash !== requestHash) throw new ConflictError('IDEMPOTENCY_KEY_REUSED');
        return {
          result: { contributionId: prior.id, accessToken: linkToken(keys, prior.id), payment: view, replayed: true, needsSubmission: pay.needsSubmission, payerMsisdn: phone.data, paymentView: pay.payment },
          audit: { subjectId: prior.id, reasonCode: 'REPLAY', txnRef: `payment:${pay.payment.id}` },
        };
      }

      const id = randomUUID();
      const kyc = sealText(JSON.stringify({ name: payerName, phone: phone.data }), `contribution:kyc:${id}`);
      await tx.query(
        `INSERT INTO contribution (id, wallet_id, payment_id, group_id, anonymous, display_name, kyc_sealed, payer_phone_hash,
                                   contact_kind, contact_sealed, contributor_person, channel, request_hash, created_at)
         VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13, $14)`,
        [
          id,
          w.id,
          pay.payment.id,
          input.groupId ?? null,
          input.anonymous,
          displayName,
          kyc,
          phoneHash(keys, phone.data),
          input.contact?.kind ?? null,
          input.contact ? sealText(input.contact.value, `contribution:contact:${id}`) : null,
          ctx.actor.kind === 'CUSTOMER' ? ctx.actor.personId : null,
          ctx.actor.channel === 'SYSTEM' ? 'WEB' : ctx.actor.channel,
          requestHash,
          now.toISOString(),
        ],
      );
      if (tribute) {
        // Rules run now; the verdict applies when the payment succeeds (nothing is public before).
        const reasons = deps.moderation.evaluate(tribute);
        await tx.query(
          `INSERT INTO tribute (contribution_id, wallet_id, message, flag_reasons, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
          [id, w.id, tribute, reasons, now.toISOString()],
        );
      }
      await enqueueOutbox(tx, 'contribution.initiated', { contributionId: id, walletId: w.id });
      return {
        result: { contributionId: id, accessToken: linkToken(keys, id), payment: view, replayed: false, needsSubmission: pay.needsSubmission, payerMsisdn: phone.data, paymentView: pay.payment },
        audit: { subjectId: id, txnRef: `payment:${pay.payment.id}`, after: { anonymous: input.anonymous, tribute: tribute !== null } },
      };
    },
  };

  // ── Contributor: own contribution, receipt, tribute ────────────────────────
  const view: Command<{ contributionId: string; token?: string }, ContributionView> = {
    name: 'contribution.view',
    async resolve(q, input) {
      return { action: 'contribution.view_own', subject: subjectOf(await loadContribution(q, input.contributionId)) };
    },
    guard: guardLink,
    async run(tx, input) {
      return { result: await buildView(tx, await loadContribution(tx, input.contributionId)) };
    },
  };

  /** Contributions of the logged-in customer (WhatsApp/web lookup of own transactions). */
  const listMine: Command<Record<string, never>, ContributionView[]> = {
    name: 'contribution.list_own',
    async resolve(_q, _input, actor) {
      return { action: 'contribution.view_own', subject: { type: 'contribution', id: '*', ownerPersonId: actor.personId } };
    },
    async run(tx, _input, ctx) {
      if (ctx.actor.kind !== 'CUSTOMER') return { result: [] };
      const { rows } = await tx.query<ContributionRow>(
        `SELECT ${C_COLS} FROM contribution WHERE contributor_person = $1 ORDER BY created_at DESC LIMIT 50`,
        [ctx.actor.personId],
      );
      const out: ContributionView[] = [];
      for (const c of rows) out.push(await buildView(tx, c));
      return { result: out };
    },
  };

  const reissueReceipt: Command<{ contributionId: string; token?: string }, ContributionReceipt> = {
    name: 'receipt.reissue',
    async resolve(q, input) {
      return { action: 'receipt.reissue', subject: subjectOf(await loadContribution(q, input.contributionId)) };
    },
    guard: guardLink,
    async run(tx, input, ctx) {
      const now = clock();
      const c = await loadContribution(tx, input.contributionId, true);
      const receipt = await loadReceipt(tx, c);
      const p = await paymentBits(tx, c.payment_id);
      if (!receipt || !p.receipt_id) throw new ConflictError('NO_RECEIPT_YET');
      const { rows } = await tx.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM receipt_issue WHERE contribution_id = $1 AND kind = 'REISSUE' AND ts > $2",
        [c.id, new Date(now.getTime() - 86_400_000).toISOString()],
      );
      const n = Number(rows[0]?.n ?? '0');
      if (n >= REISSUE_LIMIT_24H) throw new RateLimitedError();
      await tx.query(
        "INSERT INTO receipt_issue (receipt_id, contribution_id, kind, actor_id, channel, ts) VALUES ($1, $2, 'REISSUE', $3, $4, $5)",
        [p.receipt_id, c.id, ctx.actor.personId, ctx.actor.channel, now.toISOString()],
      );
      if (c.contact_kind && c.contact_sealed) {
        await enqueueNotification(
          tx,
          deps.notifyKey,
          {
            template: 'notify.receipt',
            channel: receiptChannel(c),
            to: { address: openText(c.contact_sealed, `contribution:contact:${c.id}`) },
            params: { receiptNo: receipt.receiptNo, amount: format(receipt.amount), name: receipt.funeralName, link: statusLink(c.id) },
            dedupeKey: `receipt:${p.receipt_id}:reissue:${now.getTime()}`,
            walletId: c.wallet_id,
          },
          now,
        );
      }
      // Same content as the original: the receipt row is append-only.
      return { result: receipt, audit: { txnRef: `payment:${c.payment_id}`, reasonCode: 'REISSUE' } };
    },
  };

  const manageTribute: Command<{ contributionId: string; token?: string; op: 'REMOVE' | 'APPEAL'; reason?: string }, { status: TributeStatus }> = {
    name: 'tribute.manage_own',
    async resolve(q, input) {
      return { action: 'tribute.manage_own', subject: subjectOf(await loadContribution(q, input.contributionId)) };
    },
    guard: guardLink,
    async run(tx, input, ctx) {
      const now = clock();
      const tr = await tributeOf(tx, input.contributionId, true);
      if (!tr) throw new NotFoundError('tribute', input.contributionId);
      if (input.op === 'REMOVE') {
        // Public content only: the contribution, payment and receipt stay (docs/06, docs/10).
        if (tr.status === 'REMOVED' || tr.status === 'VOID') return { result: { status: tr.status }, audit: { reasonCode: 'ALREADY_FINAL' } };
        await moveTribute(tx, tr, 'REMOVED', ctx.actor, 'CONTRIBUTOR_REMOVED', now, { erase: true });
        return { result: { status: 'REMOVED' }, audit: { subjectId: tr.id, reasonCode: 'CONTRIBUTOR_REMOVED' } };
      }
      if (tr.status !== 'REJECTED') throw new ConflictError('NOTHING_TO_APPEAL');
      if (tr.appealed) throw new ConflictError('ALREADY_APPEALED');
      const note = input.reason?.trim();
      if (note && note.length > 1000) throw new ValidationError('reason too long');
      await moveTribute(tx, tr, 'HIDDEN', ctx.actor, 'APPEAL', now, { appealed: true, ...(note ? { note } : {}) });
      return { result: { status: 'HIDDEN' }, audit: { subjectId: tr.id, reasonCode: 'APPEAL' } };
    },
  };

  // ── SYSTEM: settle on the payment's final state (worker) ───────────────────
  const settle: Command<{ paymentId: string }, { outcome: string }> = {
    name: 'contribution.settle',
    async resolve(_q, input) {
      if (!UUID.test(input.paymentId)) throw new NotFoundError('payment', input.paymentId);
      return { action: 'contribution.settle', subject: { type: 'payment', id: input.paymentId } };
    },
    async run(tx, input, ctx) {
      const now = clock();
      const { rows } = await tx.query<ContributionRow>(`SELECT ${C_COLS} FROM contribution WHERE payment_id = $1 FOR UPDATE`, [input.paymentId]);
      const c = rows[0];
      if (!c) return { result: { outcome: 'NO_CONTRIBUTION' } };
      if (c.settled_state) return { result: { outcome: 'ALREADY_SETTLED' } };
      const p = await paymentBits(tx, c.payment_id);
      const tr = await tributeOf(tx, c.id, true);

      // Credited ⇔ a receipt exists (a later refund/chargeback does not undo "it succeeded").
      if (p.receipt_id) {
        await tx.query("UPDATE contribution SET settled_state = 'SUCCEEDED', settled_at = $2 WHERE id = $1", [c.id, now.toISOString()]);
        await tx.query(
          "INSERT INTO receipt_issue (receipt_id, contribution_id, kind, actor_id, channel, ts) VALUES ($1, $2, 'ORIGINAL', $3, 'SYSTEM', $4)",
          [p.receipt_id, c.id, ctx.actor.personId, now.toISOString()],
        );
        const receipt = await loadReceipt(tx, c);
        if (!receipt) throw new Error('receipt vanished');
        const gift = giftOf(receipt, p.fee_payer);

        let publicMessage: string | null = null;
        if (tr && tr.status === 'AWAITING_PAYMENT') {
          if (tr.flag_reasons.length > 0) {
            await moveTribute(tx, tr, 'HIDDEN', ctx.actor, 'RULES_FLAGGED', now, { note: tr.flag_reasons.join(',') });
            await enqueueOutbox(tx, 'tribute.flagged', { tributeId: tr.id, walletId: c.wallet_id, reasons: tr.flag_reasons });
          } else {
            await moveTribute(tx, tr, 'VISIBLE', ctx.actor, 'PUBLISHED', now);
            publicMessage = tr.message;
          }
        }

        // Receipt to the contact the contributor gave (optional). Delivery can fail; the receipt stays retrievable.
        if (c.contact_kind && c.contact_sealed) {
          await enqueueNotification(
            tx,
            deps.notifyKey,
            {
              template: 'notify.receipt',
              channel: receiptChannel(c),
              to: { address: openText(c.contact_sealed, `contribution:contact:${c.id}`) },
              params: { receiptNo: receipt.receiptNo, amount: format(receipt.amount), name: receipt.funeralName, link: statusLink(c.id) },
              dedupeKey: `receipt:${p.receipt_id}:original`,
              walletId: c.wallet_id,
            },
            now,
          );
        }

        // Family notice. The contributor's anonymity holds here too; a flagged message is not forwarded.
        const w = await loadWallet(tx, c.wallet_id);
        let name = t('contribution.anonymous_name');
        if (c.group_id) {
          const { rows: g } = await tx.query<{ name: string }>('SELECT name FROM contribution_group WHERE id = $1', [c.group_id]);
          name = g[0]?.name ?? name;
        } else if (!c.anonymous && c.display_name) {
          name = c.display_name;
        }
        const familyParams = publicMessage
          ? { template: 'notify.family.contribution' as const, params: { name, amount: format(gift), message: publicMessage } }
          : { template: 'notify.family.contribution_plain' as const, params: { name, amount: format(gift) } };
        for (const channel of ['WEB', 'SMS'] as const) {
          await enqueueNotification(
            tx,
            deps.notifyKey,
            { ...familyParams, channel, to: { personId: w.admin_person }, dedupeKey: `family:${c.id}:${channel}`, walletId: c.wallet_id },
            now,
          );
        }

        // target.reached: once per wallet, derived from the ledger.
        if (w.target_minor) {
          const raised = await raisedTotal(tx, c.wallet_id, w.currency);
          if (raised.minor >= parseMinor(w.target_minor)) {
            const { rows: m } = await tx.query(
              "INSERT INTO wallet_milestone (wallet_id, kind, reached_at) VALUES ($1, 'TARGET_REACHED', $2) ON CONFLICT DO NOTHING RETURNING id",
              [c.wallet_id, now.toISOString()],
            );
            if (m.length > 0) {
              await enqueueOutbox(tx, 'target.reached', { walletId: c.wallet_id });
              await enqueueNotification(
                tx,
                deps.notifyKey,
                { template: 'notify.family.target_reached', channel: 'SMS', to: { personId: w.admin_person }, params: { name: w.deceased_name }, dedupeKey: `target:${c.wallet_id}`, walletId: c.wallet_id },
                now,
              );
            }
          }
        }
        await enqueueOutbox(tx, 'contribution.succeeded', { contributionId: c.id, walletId: c.wallet_id });
        return { result: { outcome: 'SUCCEEDED' }, audit: { subjectId: c.id, txnRef: `payment:${c.payment_id}`, reasonCode: 'SUCCEEDED' } };
      }

      if (p.state === 'FAILED' || p.state === 'EXPIRED') {
        await tx.query('UPDATE contribution SET settled_state = $2, settled_at = $3 WHERE id = $1', [c.id, p.state, now.toISOString()]);
        if (tr && tr.status === 'AWAITING_PAYMENT') await moveTribute(tx, tr, 'VOID', ctx.actor, `PAYMENT_${p.state}`, now);
        await enqueueOutbox(tx, 'contribution.failed', { contributionId: c.id, walletId: c.wallet_id, state: p.state });
        return { result: { outcome: p.state }, audit: { subjectId: c.id, txnRef: `payment:${c.payment_id}`, reasonCode: p.state } };
      }
      return { result: { outcome: 'NOT_FINAL' } };
    },
  };

  // ── Moderation (human review) ──────────────────────────────────────────────
  const moderationQueue: Command<Record<string, never>, ModerationQueueItem[]> = {
    name: 'tribute.queue',
    async resolve() {
      return { action: 'tribute.moderate', subject: { type: 'tribute', id: '*' } };
    },
    async run(tx) {
      const { rows } = await tx.query<TributeRow & { updated_at: Date }>(
        `SELECT id, contribution_id, wallet_id, message, status, flag_reasons, appealed, published_at, updated_at FROM tribute
          WHERE status = 'HIDDEN' ORDER BY updated_at, id LIMIT 200`,
      );
      return {
        result: rows.map((r) => ({
          tributeId: r.id,
          walletId: r.wallet_id,
          message: r.message ?? '',
          flagReasons: r.flag_reasons,
          appealed: r.appealed,
          status: r.status,
          updatedAt: new Date(r.updated_at).toISOString(),
        })),
      };
    },
  };

  const moderate: Command<{ tributeId: string; outcome: 'APPROVE' | 'REJECT' | 'HIDE'; note?: string }, { status: TributeStatus }> = {
    name: 'tribute.moderate',
    async resolve(q, input) {
      if (!UUID.test(input.tributeId)) throw new NotFoundError('tribute', input.tributeId);
      const { rows } = await q.query<{ wallet_id: string }>('SELECT wallet_id FROM tribute WHERE id = $1', [input.tributeId]);
      if (!rows[0]) throw new NotFoundError('tribute', input.tributeId);
      return { action: 'tribute.moderate', subject: { type: 'tribute', id: input.tributeId, walletId: rows[0].wallet_id } };
    },
    async run(tx, input, ctx) {
      const now = clock();
      const { rows } = await tx.query<TributeRow>(
        'SELECT id, contribution_id, wallet_id, message, status, flag_reasons, appealed, published_at FROM tribute WHERE id = $1 FOR UPDATE',
        [input.tributeId],
      );
      const tr = rows[0];
      if (!tr) throw new NotFoundError('tribute', input.tributeId);
      const note = input.note?.trim();
      // Adverse moderation is a human decision with a written reason (docs/11).
      if ((input.outcome === 'REJECT' || input.outcome === 'HIDE') && (!note || note.length < 10)) throw new ValidationError('note of at least 10 characters required');
      const to: TributeStatus = input.outcome === 'APPROVE' ? 'VISIBLE' : input.outcome === 'REJECT' ? 'REJECTED' : 'HIDDEN';
      const allowed: Record<typeof input.outcome, TributeStatus[]> = { APPROVE: ['HIDDEN'], REJECT: ['HIDDEN'], HIDE: ['VISIBLE'] };
      if (!allowed[input.outcome].includes(tr.status)) throw new ConflictError('TRIBUTE_NOT_REVIEWABLE');
      await moveTribute(tx, tr, to, ctx.actor, `MODERATOR_${input.outcome}`, now, note ? { note } : {});
      return { result: { status: to }, audit: { reasonCode: `MODERATOR_${input.outcome}` } };
    },
  };

  // ── Family: privacy + photo ────────────────────────────────────────────────
  const viewPrivacy: Command<{ walletId: string }, PrivacySettings & { photo: boolean }> = {
    name: 'wallet.privacy.view',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.view', subject: { type: 'wallet', id: w.id, walletId: w.id, createdByPersonId: w.created_by } };
    },
    async run(tx, input) {
      const { rows } = await tx.query<{ privacy: unknown; photo_doc: string | null }>('SELECT privacy, photo_doc FROM wallet WHERE id = $1', [input.walletId]);
      return { result: { ...privacyOf(rows[0]?.privacy), photo: rows[0]?.photo_doc != null } };
    },
  };

  const updatePrivacy: Command<{ walletId: string; settings: Partial<PrivacySettings> }, PrivacySettings> = {
    name: 'wallet.privacy.update',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.privacy.update', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input) {
      for (const [k, v] of Object.entries(input.settings)) {
        if (!(PRIVACY_KEYS as readonly string[]).includes(k) || typeof v !== 'boolean') throw new ValidationError('unknown privacy setting');
      }
      const { rows } = await tx.query<{ privacy: unknown }>('SELECT privacy FROM wallet WHERE id = $1 FOR UPDATE', [input.walletId]);
      const before = privacyOf(rows[0]?.privacy);
      const after: PrivacySettings = { ...before, ...input.settings };
      await tx.query('UPDATE wallet SET privacy = $2::jsonb, updated_at = $3 WHERE id = $1', [input.walletId, JSON.stringify(after), clock().toISOString()]);
      return { result: after, audit: { before, after } };
    },
  };

  /** Set (documentId) or clear (null) the memorial photo. Setting records the admin's PHOTO consent. */
  const setPhoto: Command<{ walletId: string; documentId: string | null }, { photo: boolean }> = {
    name: 'wallet.photo.set',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.photo.set', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input, ctx) {
      const w = await loadWallet(tx, input.walletId, true);
      if (input.documentId === null) {
        await tx.query('UPDATE wallet SET photo_doc = NULL, photo_consent_id = NULL, updated_at = $2 WHERE id = $1', [w.id, clock().toISOString()]);
        return { result: { photo: false }, audit: { reasonCode: 'PHOTO_CLEARED' } };
      }
      if (!UUID.test(input.documentId)) throw new NotFoundError('document', input.documentId);
      const { rows } = await tx.query<{ class: string; linked_wallet: string | null; malware_scan: string | null; deleted_at: Date | null; owner_person: string }>(
        'SELECT class, linked_wallet, malware_scan, deleted_at, owner_person FROM document WHERE id = $1',
        [input.documentId],
      );
      const d = rows[0];
      if (!d || d.deleted_at || d.linked_wallet !== w.id) throw new NotFoundError('document', input.documentId);
      if (d.class !== 'PHOTO') throw new ConflictError('NOT_A_PHOTO');
      if (d.malware_scan !== 'CLEAN') throw new ConflictError('DOCUMENT_NOT_AVAILABLE');
      // Consent to show the photo publicly, given by the wallet admin for this wallet (docs/10).
      const { rows: live } = await tx.query<{ id: string }>(
        "SELECT id FROM consent_record WHERE subject_person = $1 AND purpose = 'PHOTO' AND wallet_id = $2 AND withdrawn_at IS NULL",
        [ctx.actor.personId, w.id],
      );
      let consentId = live[0]?.id;
      if (!consentId) {
        const { rows: c } = await tx.query<{ id: string }>(
          "INSERT INTO consent_record (subject_person, purpose, wallet_id, given_by, channel) VALUES ($1, 'PHOTO', $2, $1, $3) RETURNING id",
          [ctx.actor.personId, w.id, ctx.actor.channel],
        );
        consentId = c[0]?.id;
      }
      await tx.query('UPDATE wallet SET photo_doc = $2, photo_consent_id = $3, updated_at = $4 WHERE id = $1', [w.id, input.documentId, consentId, clock().toISOString()]);
      return { result: { photo: true }, audit: { reasonCode: 'PHOTO_SET', after: { documentId: input.documentId, consentId } } };
    },
  };

  // ── Groups (feature.group_contributions, default OFF) ──────────────────────
  const createGroup: Command<{ slug: string; name: string }, { groupId: string; name: string }> = {
    name: 'group.create',
    async resolve(q, input) {
      const w = await loadPublicWallet(q, input.slug);
      return { action: 'group.create', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input, ctx) {
      if (!(await deps.flags.getIn(tx, 'feature.group_contributions'))) throw new ForbiddenError('GROUP_CONTRIBUTIONS_DISABLED');
      const w = await loadPublicWallet(tx, input.slug);
      const name = input.name.trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 120) throw new ValidationError('group name required');
      const id = randomUUID();
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO contribution_group (id, wallet_id, name, name_norm, representative_person, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (wallet_id, name_norm) DO NOTHING RETURNING id`,
        [id, w.id, name, name.toLowerCase(), ctx.actor.personId, clock().toISOString()],
      );
      if (!rows[0]) throw new ConflictError('GROUP_EXISTS');
      return { result: { groupId: id, name }, audit: { subjectId: id } };
    },
  };

  return { create, view, listMine, reissueReceipt, manageTribute, settle, moderationQueue, moderate, viewPrivacy, updatePrivacy, setPhoto, createGroup };
}

export type ContributionCommands = ReturnType<typeof contributionCommands>;
