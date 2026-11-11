// Deterministic WhatsApp orchestrator (docs/09 Orchestrator). One inbound text
// → one turn: a state machine over menus and forms. Every business action
// calls the SAME service/command the web uses, as the bound person (or a
// PUBLIC visitor); the core re-checks identity, authority, rules and state.
// Nothing here moves money or decides anything. Sensitive steps (sign in,
// payout request, evidence upload) leave chat through a single-use secure
// hand-off link; codes are only ever typed on that page.
import { createHmac, randomUUID } from 'node:crypto';
import {
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  SYSTEM_ACTOR,
  ValidationError,
  publicActor,
  randomToken,
  type Actor,
  type AuthService,
  type CommandBus,
  type FlagService,
} from '@chema/core';
import { linkToken, type ContributionService } from '@chema/contributions';
import type { ClaimsService } from '@chema/fidelity';
import { PAYOUT_PURPOSES, type PayoutPurpose, type PayoutService } from '@chema/payouts';
import { format, money, t, type Currency, type Locale, type MessageKey, type SqlClient } from '@chema/shared';
import { REPORT_CATEGORIES, type ReportCategory, type WalletCommands } from '@chema/wallet';
import { FAQ, PORTAL_ONLY, humanSignal, matchFaq, type Assistant } from './faq';
import type { ConvData, Conversation, OfferReason } from './store';
import { isNo, isYes, maskPhone, parseAmount, parseDate, parseSlug, pick } from './util';

/** Not in spec — safest short defaults (PROGRESS.md Assumptions). */
export const WA_LIMITS = {
  /** A half-filled form is dropped after this long without a message. */
  formIdleMs: 30 * 60_000,
  /** Hand-off links: single use, short-lived. */
  handoffTtlMs: 10 * 60_000,
  /** Misunderstood messages in a row before a person is offered. */
  misunderstoodBeforeHuman: 3,
  /** Contribution ids remembered per conversation. */
  rememberedContributions: 20,
} as const;

export type HandoffPurpose = 'LOGIN' | 'PAYOUT_REQUEST' | 'EVIDENCE' | 'PORTAL';
export type EscalationReason = 'USER' | OfferReason | 'INTEGRATION_DOWN';

export interface HandoffDraft {
  id: string;
  token: string;
  purpose: HandoffPurpose;
  context: Record<string, string>;
  authSessionId: string | null;
}

export interface TurnInput {
  inboundId: string;
  text: string;
  kind: 'TEXT' | 'MEDIA' | 'OTHER';
  redacted: boolean;
  conv: Conversation;
  /** The bound person's live session actor (channel WHATSAPP), or null. */
  actor: Actor | null;
  /** The binding was dropped this turn (session ended / number changed). */
  signedOut: boolean;
  now: Date;
}

export interface TurnResult {
  text: string;
  state: string;
  data: ConvData;
  locale: Locale;
  misunderstood: number;
  handoffs: HandoffDraft[];
  escalate: EscalationReason | null;
  unbind: boolean;
  outcome: string;
}

export interface OrchestratorDeps {
  db: SqlClient;
  bus: CommandBus;
  flags: FlagService;
  auth: AuthService;
  contributions: ContributionService;
  wallets: WalletCommands;
  payouts: PayoutService;
  claims?: ClaimsService;
  assistant: Assistant;
  /** Public web app (wallet pages, hand-off page). */
  publicBaseUrl: string;
  /** Staff portal, for portal-only actions. */
  portalUrl: string;
  /** Keyed hash for anonymous reporters (abuse brake without storing numbers). */
  reportKey: Buffer;
}

// ── Menu ─────────────────────────────────────────────────────────────────────

type MenuItem =
  | 'CONTRIBUTE'
  | 'RECEIPTS'
  | 'REPORT'
  | 'HELP'
  | 'HUMAN'
  | 'LANGUAGE'
  | 'SIGNIN'
  | 'MY_WALLETS'
  | 'CREATE_DRAFT'
  | 'PAYOUT'
  | 'PAYOUT_STATUS'
  | 'SIGNOUT';

const MENU_LABEL: Record<MenuItem, MessageKey> = {
  CONTRIBUTE: 'wa.menu.contribute',
  RECEIPTS: 'wa.menu.receipts',
  REPORT: 'wa.menu.report',
  HELP: 'wa.menu.help',
  HUMAN: 'wa.menu.human',
  LANGUAGE: 'wa.menu.language',
  SIGNIN: 'wa.menu.signin',
  MY_WALLETS: 'wa.menu.my_wallets',
  CREATE_DRAFT: 'wa.menu.create_draft',
  PAYOUT: 'wa.menu.payout',
  PAYOUT_STATUS: 'wa.menu.payout_status',
  SIGNOUT: 'wa.menu.signout',
};

const PUBLIC_MENU: MenuItem[] = ['CONTRIBUTE', 'RECEIPTS', 'REPORT', 'HELP', 'HUMAN', 'LANGUAGE', 'SIGNIN'];
const FAMILY_MENU: MenuItem[] = ['CONTRIBUTE', 'RECEIPTS', 'REPORT', 'HELP', 'HUMAN', 'LANGUAGE', 'MY_WALLETS', 'CREATE_DRAFT', 'PAYOUT', 'PAYOUT_STATUS', 'SIGNOUT'];

const REPORT_LABEL: Record<ReportCategory, MessageKey> = {
  FAKE_DEATH: 'wa.report.fake_death',
  NOT_FAMILY: 'wa.report.not_family',
  DUPLICATE: 'wa.report.duplicate',
  SCAM: 'wa.report.scam',
  OTHER: 'wa.report.other',
};

const PURPOSE_LABEL: Record<PayoutPurpose, MessageKey> = {
  PARLOUR: 'payout.purpose.parlour',
  TRANSPORT: 'payout.purpose.transport',
  FOOD: 'payout.purpose.food',
  CHURCH: 'payout.purpose.church',
  FAMILY_BENEFICIARY: 'payout.purpose.family_beneficiary',
  OTHER_APPROVED: 'payout.purpose.other_approved',
};

/** States whose next input is an amount (bare digits are expected there, not redacted). */
export const AMOUNT_STATES: ReadonlySet<string> = new Set(['C_AMOUNT', 'P_AMOUNT']);

const LOCALE_BY_PICK: Locale[] = ['en', 'sn', 'nd'];

// ── Turn ─────────────────────────────────────────────────────────────────────

class Turn {
  lines: string[] = [];
  state: string;
  data: ConvData;
  locale: Locale;
  misunderstood: number;
  handoffs: HandoffDraft[] = [];
  escalate: EscalationReason | null = null;
  unbind = false;
  outcome = 'OK';

  constructor(readonly input: TurnInput) {
    this.state = input.conv.state;
    this.data = { ...input.conv.data };
    this.locale = input.conv.locale;
    this.misunderstood = input.conv.misunderstood;
  }

  tr(key: MessageKey, params: Record<string, string> = {}): string {
    return t(key, params, this.locale);
  }

  say(key: MessageKey, params: Record<string, string> = {}): void {
    this.lines.push(this.tr(key, params));
  }

  raw(line: string): void {
    this.lines.push(line);
  }

  list(items: string[]): void {
    this.lines.push(items.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  }

  go(state: string, data: Partial<ConvData> = {}): void {
    this.state = state;
    const keep = this.data.contribs ? { contribs: this.data.contribs } : {};
    this.data = { ...keep, ...data, stateAt: this.input.now.toISOString() };
  }

  form(): Record<string, string> {
    return this.data.form ?? {};
  }

  setForm(state: string, patch: Record<string, string>, options?: string[]): void {
    this.go(state, { form: { ...this.form(), ...patch }, ...(options ? { options } : {}) });
  }

  result(): TurnResult {
    return {
      text: this.lines.join('\n\n'),
      state: this.state,
      data: this.data,
      locale: this.locale,
      misunderstood: this.misunderstood,
      handoffs: this.handoffs,
      escalate: this.escalate,
      unbind: this.unbind,
      outcome: this.outcome,
    };
  }
}

const GREETING = /^(hi|hello|hey|menu|start|0|mhoro|salibonani|sawubona)$/i;
const CANCEL = /^(cancel|stop|back|quit)$/i;
const HUMAN = /^(human|agent|person|help me|talk to (a )?person)$/i;
const HELP = /^(help|faq|questions?)$/i;
const LANGUAGE = /^(lang|language|mutauro|ulimi)$/i;
const SIGNOUT = /^(sign ?out|log ?out)$/i;

export class Orchestrator {
  constructor(private readonly d: OrchestratorDeps) {}

  async handle(input: TurnInput): Promise<TurnResult> {
    const turn = new Turn(input);
    try {
      await this.dispatch(turn);
    } catch (err) {
      this.fail(turn, err);
    }
    return turn.result();
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  private async dispatch(turn: Turn): Promise<void> {
    const { input } = turn;
    const text = input.text.trim();

    if (input.signedOut) turn.say('wa.signin_expired');

    if (input.redacted) {
      turn.say('wa.never_share');
      turn.outcome = 'SENSITIVE_REDACTED';
      return;
    }
    if (input.kind !== 'TEXT') {
      turn.say('wa.media');
      turn.outcome = 'NON_TEXT';
      return;
    }

    // Idle form ⇒ expired session: start again.
    const stateAt = turn.data.stateAt ? Date.parse(turn.data.stateAt) : null;
    if (turn.state !== 'MENU' && stateAt !== null && input.now.getTime() - stateAt > WA_LIMITS.formIdleMs) {
      turn.say('wa.expired');
      turn.go('MENU');
      this.menu(turn);
      turn.outcome = 'EXPIRED';
      return;
    }

    if (GREETING.test(text)) return this.menu(turn, true);
    if (CANCEL.test(text)) {
      turn.say('wa.cancelled');
      return this.menu(turn, true);
    }
    if (HUMAN.test(text)) return this.escalate(turn, 'USER');
    if (HELP.test(text)) return this.start(turn, 'HELP');
    if (LANGUAGE.test(text)) return this.start(turn, 'LANGUAGE');
    if (SIGNOUT.test(text) && input.actor) return this.start(turn, 'SIGNOUT');

    switch (turn.state) {
      case 'MENU':
        return this.onMenu(turn, text);
      case 'OFFER_HUMAN':
        if (isYes(text)) return this.escalate(turn, turn.data.offer ?? 'USER');
        return this.menu(turn, true);
      case 'LANGUAGE': {
        const i = pick(text, LOCALE_BY_PICK.length);
        if (i === null) return this.reask(turn, 'wa.language.prompt');
        turn.locale = LOCALE_BY_PICK[i] ?? 'en';
        turn.say('wa.language.set');
        return this.menu(turn, true);
      }
      case 'FAQ': {
        const i = pick(text, FAQ.length);
        const e = i === null ? matchFaq(text) : FAQ[i];
        if (!e) return this.reask(turn, 'wa.choose_number');
        turn.say(e.answer);
        turn.go('MENU');
        turn.outcome = `FAQ_${e.id.toUpperCase()}`;
        return;
      }
      case 'C_WALLET':
      case 'C_AMOUNT':
      case 'C_RAIL':
      case 'C_NAME':
      case 'C_ANON':
      case 'C_TRIBUTE':
      case 'C_CONFIRM':
        return this.contribute(turn, text);
      case 'R_WALLET':
      case 'R_CATEGORY':
        return this.report(turn, text);
      case 'D_NAME':
      case 'D_DOD':
      case 'D_FUNERAL':
      case 'D_LOCATION':
      case 'D_CONFIRM':
        return this.draft(turn, text);
      case 'P_WALLET':
      case 'P_PAYEE':
      case 'P_AMOUNT':
      case 'P_PURPOSE':
      case 'P_CONFIRM':
        return this.payout(turn, text);
      case 'PS_WALLET':
        return this.payoutStatus(turn, text);
      default:
        turn.go('MENU');
        return this.menu(turn);
    }
  }

  private menuItems(turn: Turn): MenuItem[] {
    return turn.input.actor ? FAMILY_MENU : PUBLIC_MENU;
  }

  private menu(turn: Turn, reset = false): void {
    if (reset) turn.misunderstood = 0;
    turn.go('MENU');
    turn.say('wa.menu.title');
    turn.list(this.menuItems(turn).map((m) => turn.tr(MENU_LABEL[m])));
    turn.say('wa.menu.footer');
  }

  private reask(turn: Turn, key: MessageKey): void {
    turn.say(key);
    turn.outcome = 'REASK';
  }

  private async onMenu(turn: Turn, text: string): Promise<void> {
    const items = this.menuItems(turn);
    const i = pick(text, items.length);
    if (i !== null) {
      turn.misunderstood = 0;
      return this.start(turn, items[i] ?? 'HELP');
    }
    // A pasted share link goes straight to contributing.
    const slug = parseSlug(text);
    if (slug) {
      turn.misunderstood = 0;
      turn.go('C_WALLET');
      return this.contribute(turn, slug);
    }
    if (PORTAL_ONLY.test(text)) {
      turn.say('wa.portal_only', { link: this.d.portalUrl });
      turn.outcome = 'PORTAL_ONLY';
      return;
    }
    const signal = humanSignal(text);
    if (signal) return this.offerHuman(turn, signal);
    const faq = matchFaq(text);
    if (faq) {
      turn.misunderstood = 0;
      turn.say(faq.answer);
      turn.outcome = `FAQ_${faq.id.toUpperCase()}`;
      return;
    }
    if (await this.d.flags.get('ai.assistant')) {
      const route = await this.d.assistant.route(text);
      if (route && 'faqId' in route) {
        const e = FAQ.find((f) => f.id === route.faqId);
        if (e) {
          turn.say(e.answer);
          turn.outcome = `FAQ_${e.id.toUpperCase()}`;
          return;
        }
      } else if (route) {
        return this.start(turn, route.intent);
      }
    }
    turn.misunderstood += 1;
    if (turn.misunderstood >= WA_LIMITS.misunderstoodBeforeHuman) {
      turn.misunderstood = 0;
      turn.say('wa.misunderstood');
      return this.offerHuman(turn, 'MISUNDERSTOOD');
    }
    turn.say('wa.misunderstood');
    this.menu(turn);
    turn.outcome = 'MISUNDERSTOOD';
  }

  private offerHuman(turn: Turn, reason: OfferReason): void {
    turn.go('OFFER_HUMAN', { offer: reason });
    turn.say('wa.offer_human');
    turn.outcome = `OFFER_HUMAN_${reason}`;
  }

  private escalate(turn: Turn, reason: EscalationReason): void {
    turn.escalate = reason;
    turn.go('MENU');
    turn.outcome = `ESCALATED_${reason}`;
    // The reference is added to the reply when the escalation row is written.
  }

  private needActor(turn: Turn): Actor | null {
    if (turn.input.actor) return turn.input.actor;
    turn.say('wa.signin_required');
    turn.go('MENU');
    turn.outcome = 'SIGNIN_REQUIRED';
    return null;
  }

  private async start(turn: Turn, item: MenuItem): Promise<void> {
    switch (item) {
      case 'CONTRIBUTE':
        turn.go('C_WALLET');
        turn.say('wa.wallet.ask');
        return;
      case 'RECEIPTS':
        return this.receipts(turn);
      case 'REPORT':
        turn.go('R_WALLET');
        turn.say('wa.wallet.ask');
        return;
      case 'HELP':
        turn.go('FAQ');
        turn.say('wa.faq.title');
        turn.list(FAQ.map((f) => turn.tr(f.question)));
        return;
      case 'HUMAN':
        return this.escalate(turn, 'USER');
      case 'LANGUAGE':
        turn.go('LANGUAGE');
        turn.say('wa.language.prompt');
        return;
      case 'SIGNIN': {
        const h = this.handoff(turn, 'LOGIN', {}, null);
        turn.say('wa.signin.link', { minutes: String(WA_LIMITS.handoffTtlMs / 60_000), link: h });
        turn.go('MENU');
        turn.outcome = 'HANDOFF_LOGIN';
        return;
      }
      case 'SIGNOUT': {
        const actor = turn.input.actor;
        if (actor) await this.d.auth.logout(actor);
        turn.unbind = true;
        turn.say('wa.signout.done');
        turn.go('MENU');
        turn.outcome = 'SIGNED_OUT';
        return;
      }
      case 'MY_WALLETS':
        return this.myWallets(turn);
      case 'CREATE_DRAFT': {
        if (!this.needActor(turn)) return;
        turn.setForm('D_NAME', {});
        turn.say('wa.draft.name');
        return;
      }
      case 'PAYOUT':
        return this.payoutStart(turn);
      case 'PAYOUT_STATUS':
        return this.payoutStatusStart(turn);
    }
  }

  /** Mint a single-use hand-off; the row is written with the turn. Returns the link. */
  private handoff(turn: Turn, purpose: HandoffPurpose, context: Record<string, string>, authSessionId: string | null): string {
    const token = randomToken();
    turn.handoffs.push({ id: randomUUID(), token, purpose, context, authSessionId });
    // Fragment, not path or query: never sent to a server or in a Referer.
    return `${this.d.publicBaseUrl.replace(/\/+$/, '')}/h#${token}`;
  }

  // ── Contributor: contribute ────────────────────────────────────────────────

  private async contribute(turn: Turn, text: string): Promise<void> {
    const f = turn.form();
    switch (turn.state) {
      case 'C_WALLET': {
        const slug = parseSlug(text);
        if (!slug) return this.reask(turn, 'wa.wallet.not_found');
        let page;
        try {
          page = await this.d.contributions.page(slug, turn.locale);
        } catch (err) {
          if (err instanceof NotFoundError) return this.reask(turn, 'wa.wallet.not_found');
          throw err;
        }
        if (page.closed) {
          turn.say('wa.contribute.closed');
          turn.go('MENU');
          turn.outcome = 'WALLET_CLOSED';
          return;
        }
        const c = page.contribute;
        turn.setForm(
          'C_AMOUNT',
          { slug, name: page.deceasedName, ccy: c.currency, min: c.min.minor.toString(), max: c.max ? c.max.minor.toString() : '' },
          c.rails,
        );
        turn.say('wa.contribute.found', { name: page.deceasedName, badge: turn.tr('badge.verified.label') });
        turn.say('wa.contribute.amount', { ccy: c.currency });
        return;
      }
      case 'C_AMOUNT': {
        const ccy = (f['ccy'] ?? 'USD') as Currency;
        const amount = parseAmount(text, ccy);
        const min = BigInt(f['min'] ?? '1');
        const max = f['max'] ? BigInt(f['max']) : null;
        if (!amount || amount.minor < min || (max !== null && amount.minor > max)) {
          turn.say('wa.contribute.amount_invalid', { min: format(money(min, ccy)), max: max === null ? '—' : format(money(max, ccy)) });
          turn.outcome = 'REASK';
          return;
        }
        const rails = turn.data.options ?? [];
        turn.setForm('C_RAIL', { amount: amount.minor.toString() }, rails);
        turn.say('wa.contribute.rail');
        turn.list(rails);
        return;
      }
      case 'C_RAIL': {
        const rails = turn.data.options ?? [];
        const i = pick(text, rails.length);
        if (i === null) return this.reask(turn, 'wa.choose_number');
        turn.setForm('C_NAME', { rail: rails[i] ?? '' });
        turn.say('wa.contribute.name');
        return;
      }
      case 'C_NAME': {
        const name = text.replace(/\s+/g, ' ').trim();
        if (name.length < 2 || name.length > 100) return this.reask(turn, 'wa.contribute.name');
        turn.setForm('C_ANON', { payerName: name });
        turn.say('wa.contribute.anonymous');
        return;
      }
      case 'C_ANON': {
        const i = pick(text, 2);
        if (i === null) return this.reask(turn, 'wa.contribute.anonymous');
        turn.setForm('C_TRIBUTE', { anonymous: i === 1 ? 'true' : 'false' });
        turn.say('wa.contribute.tribute');
        return;
      }
      case 'C_TRIBUTE': {
        const tribute = /^skip$/i.test(text) ? '' : text.slice(0, 500);
        turn.setForm('C_CONFIRM', { tribute });
        const g = turn.form();
        const ccy = (g['ccy'] ?? 'USD') as Currency;
        const q = await this.d.contributions.quote(g['slug'] ?? '', g['rail'] ?? '', money(BigInt(g['amount'] ?? '0'), ccy));
        turn.say('disclosure.total', { amount: format(q.totalCharged) });
        if (q.feePayer !== null) {
          turn.say('disclosure.fee', {
            amount: format(q.providerFee),
            payer: turn.tr(q.feePayer === 'CONTRIBUTOR' ? 'disclosure.fee_payer.contributor' : 'disclosure.fee_payer.wallet'),
          });
        }
        if (q.fxRate) turn.say('disclosure.fx', { rate: q.fxRate });
        turn.say('disclosure.credit', { amount: format(q.expectedCredit) });
        turn.say('contribute.no_pin');
        turn.say('wa.contribute.confirm');
        return;
      }
      case 'C_CONFIRM': {
        if (isNo(text)) {
          turn.say('wa.cancelled');
          return this.menu(turn);
        }
        if (!isYes(text)) return this.reask(turn, 'wa.contribute.confirm');
        const ccy = (f['ccy'] ?? 'USD') as Currency;
        const anonymous = f['anonymous'] === 'true';
        const phone = turn.input.conv.phone;
        const actor = turn.input.actor ?? publicActor({ channel: 'WHATSAPP', requestRef: turn.input.inboundId });
        const r = await this.d.contributions.contribute(actor, {
          slug: f['slug'] ?? '',
          rail: f['rail'] ?? '',
          amount: money(BigInt(f['amount'] ?? '0'), ccy),
          // Same message ⇒ same contribution (a re-processed message replays).
          idempotencyKey: `wa:${turn.input.inboundId}`,
          payerName: f['payerName'] ?? '',
          payerPhone: phone,
          anonymous,
          ...(anonymous ? {} : { displayName: f['payerName'] ?? '' }),
          ...(f['tribute'] ? { tribute: f['tribute'] } : {}),
          contact: { kind: 'PHONE', value: phone },
        });
        const contribs = [...(turn.data.contribs ?? []).filter((id) => id !== r.contributionId), r.contributionId].slice(-WA_LIMITS.rememberedContributions);
        turn.data.contribs = contribs;
        turn.go('MENU');
        const next = r.payment.next;
        if (next?.type === 'REDIRECT') turn.say('wa.contribute.checkout', { link: next.url });
        else if (next?.type === 'PROMPT') turn.say('wa.contribute.prompt', { message: next.message });
        else if (r.payment.state === 'FAILED') turn.say('status.failed');
        else turn.say('status.pending');
        turn.say('contribute.no_pin');
        turn.say('wa.contribute.status', { link: this.statusLink(r.contributionId, r.accessToken) });
        turn.outcome = r.replayed ? 'CONTRIBUTION_REPLAYED' : 'CONTRIBUTION_STARTED';
        return;
      }
    }
  }

  private statusLink(id: string, token: string): string {
    return `${this.d.publicBaseUrl.replace(/\/+$/, '')}/c/${id}#t=${token}`;
  }

  // ── Contributor: receipts ──────────────────────────────────────────────────

  private async receipts(turn: Turn): Promise<void> {
    turn.go('MENU');
    const actor = turn.input.actor;
    const views = new Map<string, Awaited<ReturnType<ContributionService['view']>>>();
    if (actor) {
      for (const v of await this.d.bus.execute(this.d.contributions.commands.listMine, {}, { actor })) views.set(v.id, v);
    }
    // Only ids started in THIS conversation get a capability: a typed or
    // forwarded id never does (no reaching another person's receipt).
    const guest = publicActor({ channel: 'WHATSAPP', requestRef: turn.input.inboundId });
    for (const id of [...(turn.data.contribs ?? [])].reverse()) {
      if (views.has(id)) continue;
      views.set(id, await this.d.contributions.view(guest, id, linkToken(this.d.contributions.keys, id)));
    }
    const list = [...views.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
    if (list.length === 0) {
      turn.say('wa.receipts.none');
      turn.outcome = 'RECEIPTS_NONE';
      return;
    }
    const lines = list.map((v) => {
      const state: MessageKey =
        v.state === 'SUCCEEDED' ? 'wa.state.succeeded' : v.state === 'INITIATED' || v.state === 'PENDING_UNKNOWN' ? 'wa.state.pending' : 'wa.state.failed';
      const head = turn.tr('wa.receipts.item', {
        amount: format(v.receipt?.amount ?? v.disclosure.totalCharged),
        name: v.funeralName,
        state: turn.tr(state),
      });
      const receipt = v.receipt ? `\n${turn.tr('wa.receipts.receipt', { receiptNo: v.receipt.receiptNo })}` : '';
      return `${head}${receipt}\n${this.statusLink(v.id, linkToken(this.d.contributions.keys, v.id))}`;
    });
    turn.list(lines);
    turn.outcome = 'RECEIPTS';
  }

  // ── Contributor: report a suspicious wallet ────────────────────────────────

  private async report(turn: Turn, text: string): Promise<void> {
    if (turn.state === 'R_WALLET') {
      const slug = parseSlug(text);
      if (!slug) return this.reask(turn, 'wa.wallet.not_found');
      turn.setForm('R_CATEGORY', { slug });
      turn.say('wa.report.category');
      turn.list(REPORT_CATEGORIES.map((c) => turn.tr(REPORT_LABEL[c])));
      return;
    }
    const i = pick(text, REPORT_CATEGORIES.length);
    if (i === null) return this.reask(turn, 'wa.choose_number');
    const category = REPORT_CATEGORIES[i] ?? 'OTHER';
    // Signed-in people report as themselves; others like the public web button: SYSTEM + keyed hash.
    const actor = turn.input.actor ?? { ...SYSTEM_ACTOR, channel: 'WHATSAPP' as const };
    const reporterIpHash = createHmac('sha256', this.d.reportKey).update(`wa:${turn.input.conv.phone}`).digest('hex');
    try {
      await this.d.bus.execute(this.d.wallets.report, { slug: turn.form()['slug'] ?? '', category, reporterIpHash }, { actor });
    } catch (err) {
      if (err instanceof NotFoundError) {
        turn.go('MENU');
        return this.reask(turn, 'wa.wallet.not_found');
      }
      throw err;
    }
    turn.say('wa.report.received');
    turn.go('MENU');
    turn.outcome = 'REPORTED';
  }

  // ── Family: wallets, drafts, payouts ───────────────────────────────────────

  private async familyWallets(actor: Actor, roles: readonly string[]): Promise<{ id: string; role: string }[]> {
    const { rows } = await this.d.db.query<{ wallet_id: string; role: string }>(
      `SELECT wallet_id, role FROM wallet_role WHERE person_id = $1 AND revoked_at IS NULL AND role = ANY($2::text[]) ORDER BY created_at`,
      [actor.personId, roles],
    );
    return rows.map((r) => ({ id: r.wallet_id, role: r.role }));
  }

  private async myWallets(turn: Turn): Promise<void> {
    const actor = this.needActor(turn);
    if (!actor) return;
    turn.go('MENU');
    const mine = await this.familyWallets(actor, ['ADMIN', 'APPROVER']);
    if (mine.length === 0) {
      turn.say('wa.wallets.none');
      turn.outcome = 'WALLETS_NONE';
      return;
    }
    const out: string[] = [];
    for (const m of mine.slice(0, 5)) {
      // Same command (and authorisation) as the web wallet screen.
      const v = await this.d.bus.execute(this.d.wallets.view, { walletId: m.id }, { actor });
      const lines = [turn.tr('wa.wallets.item', { name: v.deceasedName, status: v.status })];
      if (this.d.claims && v.status !== 'DRAFT') {
        try {
          const funds = await this.d.claims.funds(actor, m.id);
          for (const l of funds.lines) {
            lines.push(turn.tr('wa.wallets.funds', { label: turn.tr(l.labelKey as MessageKey), available: format(l.available), pending: format(l.pending) }));
          }
        } catch (err) {
          if (!(err instanceof ForbiddenError)) throw err;
        }
      }
      if (v.publicSlug) lines.push(turn.tr('wa.wallets.link', { link: `${this.d.publicBaseUrl.replace(/\/+$/, '')}/w/${v.publicSlug}` }));
      out.push(lines.join('\n'));
    }
    turn.list(out);
    turn.outcome = 'WALLETS';
  }

  private async draft(turn: Turn, text: string): Promise<void> {
    const actor = this.needActor(turn);
    if (!actor) return;
    const value = text.replace(/\s+/g, ' ').trim();
    switch (turn.state) {
      case 'D_NAME':
        if (value.length < 2 || value.length > 120) return this.reask(turn, 'wa.draft.name');
        turn.setForm('D_DOD', { deceasedName: value });
        turn.say('wa.draft.dod');
        return;
      case 'D_DOD': {
        const d = parseDate(value);
        if (!d) return this.reask(turn, 'wa.draft.invalid_date');
        turn.setForm('D_FUNERAL', { dateOfDeath: d });
        turn.say('wa.draft.funeral_date');
        return;
      }
      case 'D_FUNERAL': {
        if (/^skip$/i.test(value)) {
          turn.setForm('D_LOCATION', {});
        } else {
          const d = parseDate(value);
          if (!d) return this.reask(turn, 'wa.draft.invalid_date');
          turn.setForm('D_LOCATION', { funeralDate: d });
        }
        turn.say('wa.draft.location');
        return;
      }
      case 'D_LOCATION':
        if (value.length < 2 || value.length > 200) return this.reask(turn, 'wa.draft.location');
        turn.setForm('D_CONFIRM', { funeralLocation: value });
        turn.say('wa.draft.confirm', { name: turn.form()['deceasedName'] ?? '' });
        return;
      case 'D_CONFIRM': {
        if (isNo(text)) {
          turn.say('wa.cancelled');
          return this.menu(turn);
        }
        if (!isYes(text)) return this.reask(turn, 'wa.yes_no');
        const f = turn.form();
        const v = await this.d.bus.execute(
          this.d.wallets.createDraft,
          {
            deceasedName: f['deceasedName'] ?? '',
            dateOfDeath: f['dateOfDeath'] ?? '',
            ...(f['funeralDate'] ? { funeralDate: f['funeralDate'] } : {}),
            funeralLocation: f['funeralLocation'] ?? '',
            currency: 'USD',
          },
          { actor },
        );
        const link = this.handoff(turn, 'EVIDENCE', { walletId: v.id }, actor.sessionId ?? null);
        turn.go('MENU');
        turn.say('wa.draft.created', { name: v.deceasedName, minutes: String(WA_LIMITS.handoffTtlMs / 60_000), link });
        turn.outcome = 'DRAFT_CREATED';
        return;
      }
    }
  }

  private async activeAdminWallets(actor: Actor): Promise<{ id: string; name: string; ccy: Currency }[]> {
    const out: { id: string; name: string; ccy: Currency }[] = [];
    for (const m of await this.familyWallets(actor, ['ADMIN'])) {
      const v = await this.d.bus.execute(this.d.wallets.view, { walletId: m.id }, { actor });
      if (v.status === 'ACTIVE' || v.status === 'CLOSING') out.push({ id: v.id, name: v.deceasedName, ccy: v.currency });
    }
    return out;
  }

  private async payoutStart(turn: Turn): Promise<void> {
    const actor = this.needActor(turn);
    if (!actor) return;
    const wallets = await this.activeAdminWallets(actor);
    if (wallets.length === 0) {
      turn.say('wa.payout.no_wallets');
      turn.go('MENU');
      turn.outcome = 'PAYOUT_NO_WALLET';
      return;
    }
    if (wallets.length === 1) {
      const w = wallets[0];
      if (w) return this.payoutPayees(turn, actor, w.id, w.ccy);
    }
    turn.setForm('P_WALLET', {}, wallets.map((w) => `${w.id}|${w.ccy}`));
    turn.say('wa.wallets.choose');
    turn.list(wallets.map((w) => w.name));
  }

  private async payoutPayees(turn: Turn, actor: Actor, walletId: string, ccy: Currency): Promise<void> {
    const payees = (await this.d.payouts.run(actor, this.d.payouts.payees.list, { walletId })).filter((p) => p.status === 'ACTIVE');
    if (payees.length === 0) {
      turn.say('wa.payout.no_payees');
      turn.go('MENU');
      turn.outcome = 'PAYOUT_NO_PAYEE';
      return;
    }
    turn.setForm('P_PAYEE', { walletId, ccy }, payees.map((p) => `${p.id}|${p.label}`));
    turn.say('wa.payout.payee');
    // Masked destination only (docs/09 minimum data).
    turn.list(payees.map((p) => `${p.label} (${p.destination})`));
  }

  private async payout(turn: Turn, text: string): Promise<void> {
    const actor = this.needActor(turn);
    if (!actor) return;
    const options = turn.data.options ?? [];
    const f = turn.form();
    switch (turn.state) {
      case 'P_WALLET': {
        const i = pick(text, options.length);
        if (i === null) return this.reask(turn, 'wa.choose_number');
        const [walletId = '', ccy = 'USD'] = (options[i] ?? '').split('|');
        return this.payoutPayees(turn, actor, walletId, ccy as Currency);
      }
      case 'P_PAYEE': {
        const i = pick(text, options.length);
        if (i === null) return this.reask(turn, 'wa.choose_number');
        const [payeeId = '', label = ''] = (options[i] ?? '').split('|');
        turn.setForm('P_AMOUNT', { payeeId, payeeLabel: label });
        turn.say('wa.payout.amount', { ccy: f['ccy'] ?? 'USD' });
        return;
      }
      case 'P_AMOUNT': {
        const amount = parseAmount(text, (f['ccy'] ?? 'USD') as Currency);
        if (!amount) return this.reask(turn, 'wa.payout.amount_invalid');
        turn.setForm('P_PURPOSE', { amount: amount.minor.toString() }, [...PAYOUT_PURPOSES]);
        turn.say('wa.payout.purpose');
        turn.list(PAYOUT_PURPOSES.map((p) => turn.tr(PURPOSE_LABEL[p])));
        return;
      }
      case 'P_PURPOSE': {
        const i = pick(text, PAYOUT_PURPOSES.length);
        if (i === null) return this.reask(turn, 'wa.choose_number');
        const purpose = PAYOUT_PURPOSES[i] ?? 'OTHER_APPROVED';
        turn.setForm('P_CONFIRM', { purpose });
        const g = turn.form();
        turn.say('wa.payout.confirm', {
          amount: format(money(BigInt(g['amount'] ?? '0'), (g['ccy'] ?? 'USD') as Currency)),
          payee: g['payeeLabel'] ?? '',
          purpose: turn.tr(PURPOSE_LABEL[purpose]),
        });
        return;
      }
      case 'P_CONFIRM': {
        if (isNo(text)) {
          turn.say('wa.cancelled');
          return this.menu(turn);
        }
        if (!isYes(text)) return this.reask(turn, 'wa.yes_no');
        // Nothing is requested from chat: the request + its step-up OTP happen
        // on the secure page, bound to this session.
        const link = this.handoff(
          turn,
          'PAYOUT_REQUEST',
          {
            walletId: f['walletId'] ?? '',
            payeeId: f['payeeId'] ?? '',
            payeeLabel: f['payeeLabel'] ?? '',
            amountMinor: f['amount'] ?? '0',
            currency: f['ccy'] ?? 'USD',
            purpose: f['purpose'] ?? 'OTHER_APPROVED',
          },
          actor.sessionId ?? null,
        );
        turn.go('MENU');
        turn.say('wa.payout.link', { minutes: String(WA_LIMITS.handoffTtlMs / 60_000), link });
        turn.outcome = 'HANDOFF_PAYOUT';
        return;
      }
    }
  }

  private async payoutStatusStart(turn: Turn): Promise<void> {
    const actor = this.needActor(turn);
    if (!actor) return;
    const mine = await this.familyWallets(actor, ['ADMIN', 'APPROVER']);
    if (mine.length === 0) {
      turn.say('wa.wallets.none');
      turn.go('MENU');
      return;
    }
    if (mine.length === 1 && mine[0]) return this.showPayouts(turn, actor, mine[0].id);
    const names: string[] = [];
    for (const m of mine) names.push((await this.d.bus.execute(this.d.wallets.view, { walletId: m.id }, { actor })).deceasedName);
    turn.setForm('PS_WALLET', {}, mine.map((m) => m.id));
    turn.say('wa.wallets.choose');
    turn.list(names);
  }

  private async payoutStatus(turn: Turn, text: string): Promise<void> {
    const actor = this.needActor(turn);
    if (!actor) return;
    const options = turn.data.options ?? [];
    const i = pick(text, options.length);
    if (i === null) return this.reask(turn, 'wa.choose_number');
    return this.showPayouts(turn, actor, options[i] ?? '');
  }

  private async showPayouts(turn: Turn, actor: Actor, walletId: string): Promise<void> {
    turn.go('MENU');
    const payouts = await this.d.payouts.run(actor, this.d.payouts.payouts.list, { walletId });
    if (payouts.length === 0) {
      turn.say('wa.payout.none');
      turn.outcome = 'PAYOUTS_NONE';
      return;
    }
    const payees = new Map((await this.d.payouts.run(actor, this.d.payouts.payees.list, { walletId })).map((p) => [p.id, p.label]));
    turn.list(
      payouts
        .slice(-5)
        .reverse()
        .map((p) => turn.tr('wa.payout.item', { amount: format(p.amount), payee: payees.get(p.payeeId) ?? '—', status: p.status })),
    );
    turn.outcome = 'PAYOUTS';
  }

  // ── Fallbacks ──────────────────────────────────────────────────────────────

  private fail(turn: Turn, err: unknown): void {
    turn.go('MENU');
    if (err instanceof ForbiddenError || err instanceof AuthenticationError) {
      turn.say('wa.error.denied');
      turn.outcome = 'DENIED';
    } else if (err instanceof NotFoundError) {
      turn.say('wa.error.denied');
      turn.outcome = 'NOT_FOUND';
    } else if (err instanceof RateLimitedError) {
      turn.say('wa.rate_limited');
      turn.outcome = 'RATE_LIMITED';
    } else if (err instanceof ValidationError || err instanceof ConflictError) {
      turn.say('wa.error.invalid');
      turn.outcome = 'INVALID';
    } else {
      // Integration down: say so, point at the web, keep nothing half-done.
      turn.say('wa.down', { link: this.d.publicBaseUrl });
      turn.outcome = 'INTEGRATION_DOWN';
    }
  }
}

export { maskPhone };
