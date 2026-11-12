// Pure helpers for the detail screens (case, payout override, mandate change,
// closure, failures). Display decisions only: the API authorises and
// validates every action, so nothing here hides a button for "security".

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v.trim());

export const CASE_OUTCOMES = ['UPHELD', 'NOT_UPHELD', 'WITHDRAWN', 'SETTLED_BY_AGREEMENT', 'REFERRED_LEGAL', 'DUPLICATE', 'OTHER'] as const;
export const MANDATE_VERIFY_REASONS = ['AUTHORITY_SHOWN', 'AUTHORITY_NOT_SHOWN', 'IDENTITY_MISMATCH', 'EVIDENCE_NOT_AUTHENTIC', 'DISPUTED', 'OTHER'] as const;
export type MandateReason = (typeof MANDATE_VERIFY_REASONS)[number];

/** The verify reason must fit the outcome (server rule, mirrored so the form offers only valid pairs). */
export function reasonsFor(outcome: 'APPROVED' | 'REJECTED'): readonly MandateReason[] {
  return outcome === 'APPROVED' ? ['AUTHORITY_SHOWN'] : MANDATE_VERIFY_REASONS.filter((r) => r !== 'AUTHORITY_SHOWN');
}

/** Override step for a payout: request (maker), wait for a different checker, then execute. */
export function overrideStep(status: string): 'REQUEST' | 'EXECUTE' | 'NONE' {
  if (status === 'RAIL_DOWN') return 'REQUEST';
  if (status === 'OVERRIDE_PENDING') return 'EXECUTE';
  return 'NONE';
}

export type Row = Record<string, unknown>;

export interface FailureGroup {
  kind: string;
  title: string;
  help: string;
  rows: Row[];
}

const FAILURE_COPY: Record<string, { title: string; help: string }> = {
  whatsapp: { title: 'WhatsApp messages not processed (FAILED / IGNORED)', help: 'Inbound messages the pipeline could not handle. Bodies are never shown here.' },
  notifications: { title: 'Undelivered notifications (DEAD)', help: 'Delivery failure never changes a transaction. Contact the person another way if needed.' },
  fidelity: { title: 'Fidelity requests given up (DEAD)', help: 'Calls to Fidelity that exhausted their retries.' },
  payouts: { title: 'Payouts stuck at the rail', help: 'RAIL_DOWN payouts can be completed outside the rail with a dual-approved override.' },
};

/** `/admin/queues/failures` → one titled group per kind, known kinds first. */
export function failureGroups(data: unknown): FailureGroup[] {
  const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const order = ['whatsapp', 'notifications', 'fidelity', 'payouts'];
  const kinds = [...order.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !order.includes(k)).sort()];
  return kinds.map((kind) => ({
    kind,
    title: FAILURE_COPY[kind]?.title ?? kind,
    help: FAILURE_COPY[kind]?.help ?? '',
    rows: Array.isArray(obj[kind]) ? (obj[kind] as Row[]) : [],
  }));
}

/** Approval rows for mandate changes (subjectType mandate_change). */
export function mandateApprovals(rows: unknown): Row[] {
  return Array.isArray(rows) ? (rows as Row[]).filter((r) => r['subjectType'] === 'mandate_change') : [];
}

/** Deep link for an approval's subject, when the portal has a screen for it. */
export function subjectHref(row: Row): string | null {
  const id = String(row['subjectId'] ?? '');
  if (!isUuid(id)) return null;
  if (row['subjectType'] === 'mandate_change') return `/mandate/${id}`;
  if (row['subjectType'] === 'payout_request') return `/payouts/${id}`;
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
