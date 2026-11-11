// FAQ retrieval over approved static content (docs/11 Assistant row): answers
// come only from the i18n catalogue, matched by keywords. No model involved.
// The LLM assistant is an interface stub behind `ai.assistant` (default off);
// even when on it may only ROUTE (pick a menu intent or FAQ entry) — it never
// writes a reply, quotes a balance, or commits anything.
import type { MessageKey } from '@chema/shared';

export interface FaqEntry {
  id: string;
  question: MessageKey;
  answer: MessageKey;
  keywords: readonly string[];
}

export const FAQ: readonly FaqEntry[] = [
  { id: 'what', question: 'wa.faq.what.q', answer: 'wa.faq.what.a', keywords: ['what is', 'chema', 'about'] },
  { id: 'verified', question: 'wa.faq.verified.q', answer: 'wa.faq.verified.a', keywords: ['verified', 'badge', 'genuine', 'real'] },
  { id: 'fees', question: 'wa.faq.fees.q', answer: 'wa.faq.fees.a', keywords: ['fee', 'fees', 'charge', 'cost'] },
  { id: 'safe', question: 'wa.faq.safe.q', answer: 'wa.faq.safe.a', keywords: ['safe', 'pin', 'security', 'secure'] },
  { id: 'receipt', question: 'wa.faq.receipt.q', answer: 'wa.faq.receipt.a', keywords: ['receipt', 'proof'] },
  { id: 'payout', question: 'wa.faq.payout.q', answer: 'wa.faq.payout.a', keywords: ['payout', 'withdraw', 'receive money', 'paid out'] },
];

/** Best keyword match for free text, or null. Deterministic: first entry with the most hits. */
export function matchFaq(text: string): FaqEntry | null {
  const t = text.toLowerCase();
  let best: FaqEntry | null = null;
  let bestHits = 0;
  for (const e of FAQ) {
    const hits = e.keywords.filter((k) => t.includes(k)).length;
    if (hits > bestHits) {
      best = e;
      bestHits = hits;
    }
  }
  return best;
}

/** What an assistant may suggest: a menu intent or an FAQ entry. Nothing else. */
export type AssistantRoute = { intent: 'CONTRIBUTE' | 'RECEIPTS' | 'REPORT' | 'HELP' | 'HUMAN' } | { faqId: string };

/** LLM hook (stub). Called only when `ai.assistant` is on and the rules did not understand. */
export interface Assistant {
  route(text: string): Promise<AssistantRoute | null>;
}

/** Default: no model. */
export class NoAssistant implements Assistant {
  async route(): Promise<AssistantRoute | null> {
    return null;
  }
}

// ── Signals that a person should be offered (docs/09 Orchestrator) ──────────

export type HumanSignal = 'DISTRESS' | 'COMPLAINT' | 'FRAUD';

const SIGNALS: readonly [HumanSignal, RegExp][] = [
  ['DISTRESS', /\b(suicide|kill myself|end my life|can'?t cope|hopeless|desperate)\b/i],
  ['FRAUD', /\b(scam|scammer|fraud|stolen|fake (wallet|death|funeral)|hacked)\b/i],
  ['COMPLAINT', /\b(complain|complaint|unhappy|angry|useless|terrible service|not received my money)\b/i],
];

export function humanSignal(text: string): HumanSignal | null {
  for (const [signal, re] of SIGNALS) if (re.test(text)) return signal;
  return null;
}

/** Things only the staff portal may do (docs/09 portal-only list). */
export const PORTAL_ONLY = /\b(approve claim|decline claim|claim decision|release (funds|hold)|ledger adjust|adjust(ment)? ledger|override|privileged)\b/i;
