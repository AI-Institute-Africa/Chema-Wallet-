// English message catalogue (MVP-required). Every user-facing string goes here.
// Placeholders use {name}. Dignity rules: no pressure, ranking or anchoring copy.
export const en = {
  'app.name': 'Chema Wallet',
  'health.ok': 'Service is running',
  'error.not_available': 'This page is not available.',
  'error.internal': 'Something went wrong. Please try again.',
  'error.feature_disabled': 'This service is not available right now.',
  'badge.verified.label': 'Verified funeral',
  'badge.verified.tooltip': 'Funeral checks passed. This does not mean insurance cover or claim approval.',
  // Share text (docs/05 Public activation). Pronoun-neutral: we do not collect one.
  'share.message': 'Family of the late {name}: please help us give them a dignified send-off. Contribute here: {link}',
  'contribution.anonymous_name': 'Sympathetic Friend',
  'contribution.thanks': 'Thank you, {name}. Your contribution has been received.',
} as const;

export type MessageKey = keyof typeof en;
