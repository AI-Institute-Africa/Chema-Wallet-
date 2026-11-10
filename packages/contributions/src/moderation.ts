// Tribute moderation (docs/06 Tribute wall, docs/11 AI limits): transparent,
// deterministic rules. A flag only HIDES the tribute pending human review; it
// never rejects it and never touches the contribution or its money.
// `ai.moderation_model` (off) would add model flags on top of these rules.

export const MODERATION_REASONS = ['LINK', 'CONTACT_DETAILS', 'SHOUTING', 'REPETITION', 'ABUSIVE_LANGUAGE', 'MONEY_REQUEST'] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];

export interface ModerationRules {
  /** Empty ⇒ publish. Any reason ⇒ HIDDEN pending review. */
  evaluate(message: string): ModerationReason[];
}

// Kept short and published with the rules. Matched as whole words, case-insensitive.
const ABUSIVE = ['idiot', 'idiots', 'stupid', 'liar', 'liars', 'thief', 'thieves', 'fraud', 'frauds', 'scam', 'scammer', 'scammers', 'useless', 'hate'];

export class DeterministicModerationRules implements ModerationRules {
  evaluate(message: string): ModerationReason[] {
    const m = message.normalize('NFKC');
    const out: ModerationReason[] = [];
    if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|co|zw|info|io|xyz|link)\b)/i.test(m)) out.push('LINK');
    // A phone number or an email in a public message is spam bait or exposes someone.
    if (/(\+?\d[\d\s-]{7,}\d)|([^\s@]+@[^\s@]+\.[a-z]{2,})/i.test(m)) out.push('CONTACT_DETAILS');
    const letters = m.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8) out.push('SHOUTING');
    if (/(.)\1{9,}/.test(m) || /\b(\w+)\b(?:\W+\1\b){4,}/i.test(m)) out.push('REPETITION');
    const words = new Set(m.toLowerCase().split(/[^a-z']+/).filter(Boolean));
    if (ABUSIVE.some((w) => words.has(w))) out.push('ABUSIVE_LANGUAGE');
    // Tributes are not a place to ask for money elsewhere.
    if (/\b(send|pay|transfer)\b.{0,30}\b(to|me|my)\b.{0,30}\b(ecocash|onemoney|number|account)\b/i.test(m)) out.push('MONEY_REQUEST');
    return out;
  }
}
