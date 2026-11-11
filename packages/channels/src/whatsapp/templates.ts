// WhatsApp template registry (docs/09 Notifications, D16). Proactive messages
// (outside a conversation the person started) need a provider-approved
// template. None is approved yet: every entry is a placeholder that records
// what will need approval. In-conversation replies use `wa.reply`.
import type { MessageKey } from '@chema/shared';

export type WaTemplateCategory = 'UTILITY' | 'AUTHENTICATION' | 'SERVICE';

export interface WaTemplate {
  category: WaTemplateCategory;
  /** Provider template name once approved (D16). null ⇒ not approved: only usable inside a service window. */
  providerName: string | null;
}

export const WA_TEMPLATES: Readonly<Partial<Record<MessageKey, WaTemplate>>> = {
  // Reply inside a conversation the person opened (service window).
  'wa.reply': { category: 'SERVICE', providerName: null },
  'notify.receipt': { category: 'UTILITY', providerName: null },
  'notify.family.contribution': { category: 'UTILITY', providerName: null },
  'notify.family.contribution_plain': { category: 'UTILITY', providerName: null },
  'notify.family.target_reached': { category: 'UTILITY', providerName: null },
  'payout.notice.confirmed': { category: 'UTILITY', providerName: null },
  'payout.notice.failed': { category: 'UTILITY', providerName: null },
  'closure.thank_you': { category: 'UTILITY', providerName: null },
  'wa.notice.payout_requested': { category: 'UTILITY', providerName: null },
  'wa.notice.signed_in': { category: 'UTILITY', providerName: null },
};

export function isWaTemplate(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(WA_TEMPLATES, key);
}
