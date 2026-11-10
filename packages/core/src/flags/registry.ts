// Every config key from docs/13 (+ docs/11 AI flags) with its SAFEST default.
// Rule: unresolved decision ⇒ feature disabled/blocked. A missing DB row means
// the default applies. Change a default only with a recorded decision.
import { z } from 'zod';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type FlagSource = 'env' | 'db' | 'default';

export interface FlagDef<T> {
  readonly description: string;
  readonly decision?: string;
  /** Financial flags change only through dual approval (approval service: P01/P09). */
  readonly financial: boolean;
  /** Locked flags can never leave their default from any source. */
  readonly locked?: boolean;
  readonly default: T;
  decode(raw: unknown, source: Exclude<FlagSource, 'default'>): T;
  encode(value: T): JsonValue;
}

interface Meta {
  description: string;
  decision?: string;
  financial: boolean;
  locked?: boolean;
}

function withMeta<T>(meta: Meta, def: Omit<FlagDef<T>, keyof Meta>): FlagDef<T> {
  return { ...def, ...meta } as FlagDef<T>;
}

const nullish = (raw: unknown) => raw === null || raw === '' || raw === 'null';

function bool(meta: Meta): FlagDef<boolean> {
  return withMeta(meta, {
    default: false,
    decode(raw, source) {
      if (source === 'env') return z.enum(['true', 'false']).parse(raw) === 'true';
      return z.boolean().parse(raw);
    },
    encode: (v) => v,
  });
}

/** Minor-unit money amount (bigint). Unset ⇒ null ⇒ the blocking/safest behaviour. */
function minor(meta: Meta): FlagDef<bigint | null> {
  return withMeta(meta, {
    default: null,
    decode(raw) {
      if (nullish(raw)) return null;
      return BigInt(z.string().regex(/^(0|[1-9]\d*)$/).parse(raw));
    },
    encode: (v) => (v === null ? null : v.toString()),
  });
}

function int(meta: Meta): FlagDef<number | null> {
  return withMeta(meta, {
    default: null,
    decode(raw, source) {
      if (nullish(raw)) return null;
      const n = source === 'env' ? Number(z.string().regex(/^\d+$/).parse(raw)) : raw;
      return z.number().int().nonnegative().parse(n);
    },
    encode: (v) => v,
  });
}

function text(meta: Meta): FlagDef<string | null> {
  return withMeta(meta, {
    default: null,
    decode: (raw) => (nullish(raw) ? null : z.string().min(1).max(200).parse(raw)),
    encode: (v) => v,
  });
}

function list<const O extends readonly [string, ...string[]]>(
  meta: Meta,
  options: O,
  dflt: O[number][],
  refine?: (v: O[number][]) => boolean,
): FlagDef<O[number][]> {
  const schema = z
    .array(z.enum(options))
    .min(1)
    .refine((v) => new Set(v).size === v.length, 'duplicate entries')
    .refine((v) => (refine ? refine(v) : true), 'invalid combination');
  return withMeta(meta, {
    default: dflt,
    decode(raw, source) {
      const value = source === 'env' ? String(raw).split(',').map((s) => s.trim()) : raw;
      return schema.parse(value);
    },
    encode: (v) => [...v],
  });
}

const RAILS = ['ecocash', 'onemoney', 'card'] as const;
const CCYS = ['usd', 'zwg'] as const;

function reconTolerances() {
  const out: Record<string, FlagDef<bigint | null>> = {};
  for (const rail of RAILS) {
    for (const ccy of CCYS) {
      out[`recon.tolerance.${rail}.${ccy}`] = minor({
        description: `Recon tolerance (minor units) for ${rail}/${ccy.toUpperCase()}; unset ⇒ zero tolerance, exception raised (no blanket freeze).`,
        decision: 'D09',
        financial: true,
      });
    }
  }
  return out as Record<`recon.tolerance.${(typeof RAILS)[number]}.${(typeof CCYS)[number]}`, FlagDef<bigint | null>>;
}

export const FLAGS = {
  // ── Global kill switches ──────────────────────────────────────────────
  'live_funds.enabled': bool({ description: 'Hard gate: real money. Off ⇒ sandbox/mock adapters only.', decision: 'D01/D02', financial: true }),
  'contributions.enabled': bool({ description: 'Kill switch for accepting contributions.', financial: true }),
  'payouts.enabled': bool({ description: 'Kill switch for payouts.', financial: true }),
  'fees.enabled': bool({ description: 'Fee charging. Off ⇒ no fee, no fee copy.', decision: 'D08', financial: true }),
  'commissions.enabled': bool({ description: 'Never used in MVP. Locked off.', financial: true, locked: true }),
  'marketing.enabled': bool({ description: 'Marketing/cross-sell use of data. Needs lawful basis + consent.', financial: false }),

  // ── Rails (D06/D07) ───────────────────────────────────────────────────
  'rail.ecocash': bool({ description: 'EcoCash rail (mock until certified).', decision: 'D06', financial: true }),
  'rail.onemoney': bool({ description: 'OneMoney rail (mock until certified).', decision: 'D06', financial: true }),
  'rail.card': bool({ description: 'Card rail (needs acquirer approval).', decision: 'D07', financial: true }),

  // ── Channels (D16) ────────────────────────────────────────────────────
  'channel.whatsapp': bool({ description: 'Real WhatsApp provider. Off ⇒ local simulator only.', decision: 'D16', financial: false }),
  'channel.sms': bool({ description: 'SMS fallback for receipts/OTP.', decision: 'D16', financial: false }),

  // ── Features ──────────────────────────────────────────────────────────
  'fidelity.claims_link': bool({ description: 'Fidelity policy/claims link and benefit sub-ledger.', decision: 'D14', financial: true }),
  'feature.group_contributions': bool({ description: 'Group (church/burial society) contributions.', financial: true }),
  'settlement.direct_parlour': bool({ description: 'Direct parlour settlement. Off ⇒ manual payee only.', decision: 'D17', financial: true }),
  'data.cross_border': bool({ description: 'Cross-border data transfer.', decision: 'D13', financial: false }),

  // ── Pilot (D19) ───────────────────────────────────────────────────────
  'pilot.enabled': bool({ description: 'Pilot go switch. Off ⇒ no pilot traffic.', decision: 'D19', financial: true }),
  'pilot.max_wallets': int({ description: 'Pilot wallet cap; unset ⇒ pilot blocked.', decision: 'D19', financial: true }),
  'pilot.max_amount_minor': minor({ description: 'Pilot amount cap; unset ⇒ pilot blocked.', decision: 'D19', financial: true }),

  // ── Approvals / KYC / claims ──────────────────────────────────────────
  'approvals.payout_high_value_minor': minor({ description: 'Payout dual-approval threshold; unset ⇒ ALL payouts dual-approved.', decision: 'D04', financial: true }),
  'kyc.contributor_light_max_minor': minor({ description: 'Light-KYC ceiling; unset ⇒ phone+name always required.', financial: true }),
  // Contribution amount limits (docs/06 "min/max config"). Unset minimum ⇒ any
  // positive amount (every amount honoured); unset maximum ⇒ contributions in
  // that currency are refused, because no ceiling has been agreed.
  'contribution.min_minor.usd': minor({ description: 'Smallest USD contribution (minor units); unset ⇒ any positive amount.', financial: true }),
  'contribution.min_minor.zwg': minor({ description: 'Smallest ZWG contribution (minor units); unset ⇒ any positive amount.', financial: true }),
  'contribution.max_minor.usd': minor({ description: 'Largest USD contribution (minor units); unset ⇒ USD contributions refused.', financial: true }),
  'contribution.max_minor.zwg': minor({ description: 'Largest ZWG contribution (minor units); unset ⇒ ZWG contributions refused.', financial: true }),
  'claims.auto_approve_limit_minor': minor({ description: 'Straight-through claim limit; unset ⇒ all claims manual.', decision: 'D10', financial: true }),

  // ── Verification (D05) ────────────────────────────────────────────────
  'verification.evidence_types': list(
    { description: 'Accepted death evidence (any ONE + admin ID + mandate); reviewer decides.', decision: 'D05', financial: false },
    ['DEATH_CERTIFICATE', 'PARLOUR_CONFIRMATION', 'BURIAL_ORDER'],
    ['DEATH_CERTIFICATE', 'PARLOUR_CONFIRMATION', 'BURIAL_ORDER'],
  ),
  'verification.sla_hours': int({ description: 'Verification SLA; unset ⇒ no SLA promised in UI.', decision: 'D05', financial: false }),
  // Fraud rules only raise review tasks (never adverse action), so the unset
  // default is the stricter built-in limit (3 drafts per creator per 24 h).
  'fraud.velocity_max_drafts_24h': int({ description: 'Drafts per creator per 24 h before a velocity review flag; unset ⇒ 3.', financial: false }),

  // ── Recon (D09) ───────────────────────────────────────────────────────
  ...reconTolerances(),

  // ── Closure / refunds (D11) ───────────────────────────────────────────
  'closure.excess_funds_policy': text({ description: 'Residual-funds policy; unset ⇒ closure blocked if residual > 0.', decision: 'D11', financial: true }),
  'refund.policy': text({ description: 'Refund policy; unset ⇒ every refund is a manual case.', decision: 'D11', financial: true }),

  // ── Retention (D12) ───────────────────────────────────────────────────
  'retention.financial_years': int({ description: 'Financial record retention; unset ⇒ retain, never auto-delete (7y is planning only).', decision: 'D12', financial: false }),

  // ── Languages (D15) ───────────────────────────────────────────────────
  'i18n.enabled_locales': list(
    { description: 'Locales offered to users. English always on.', decision: 'D15', financial: false },
    ['en', 'sn', 'nd'],
    ['en'],
    (v) => v.includes('en'),
  ),

  // ── AI (docs/11): assistive only, all off ─────────────────────────────
  'ai.ocr': bool({ description: 'OCR/extraction assist.', financial: false }),
  'ai.fraud_model': bool({ description: 'Model-based fraud flags (rules run regardless).', financial: false }),
  'ai.claim_triage': bool({ description: 'Claim queue triage suggestions.', financial: false }),
  'ai.assistant': bool({ description: 'LLM assistant on WhatsApp/web.', financial: false }),
  'ai.moderation_model': bool({ description: 'Model-based tribute moderation.', financial: false }),
  'ai.insights': bool({ description: 'Target suggestions from cost data.', financial: false }),
} as const;

export type Flags = typeof FLAGS;
export type FlagKey = keyof Flags;
export type FlagValue<K extends FlagKey> = Flags[K] extends FlagDef<infer T> ? T : never;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

export function isFlagKey(key: string): key is FlagKey {
  return Object.prototype.hasOwnProperty.call(FLAGS, key);
}

export function envVarFor(key: FlagKey): string {
  return `CHEMA_FLAG_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}
