// Display copy for the family-facing screens. Plain, calm wording; no pressure.
import type { EvidenceType, WalletStatus } from './api';

export const STATUS_COPY: Record<WalletStatus, { title: string; detail: string }> = {
  DRAFT: {
    title: 'Draft — private',
    detail: 'Only you can see this wallet. Add the documents below, then send it for checks. It has no public link yet.',
  },
  PENDING_VERIFICATION: {
    title: 'Being checked',
    detail: 'A community verifier is reviewing the documents. The wallet stays private until the checks pass.',
  },
  ACTIVE: { title: 'Verified and shareable', detail: 'Funeral checks passed. You can share the link and QR code below.' },
  VERIFICATION_REJECTED: {
    title: 'Checks not passed',
    detail: 'The verifier could not confirm the details. You can add documents and appeal.',
  },
  SUSPENDED: { title: 'Paused', detail: 'This wallet is paused while something is looked into. Our team will contact you.' },
  CLOSING: { title: 'Closing', detail: 'This wallet is being closed.' },
  CLOSED: { title: 'Closed', detail: 'This wallet is closed.' },
};

export const EVIDENCE_COPY: Record<EvidenceType, string> = {
  DEATH_CERTIFICATE: 'Death certificate',
  PARLOUR_CONFIRMATION: 'Funeral parlour confirmation',
  BURIAL_ORDER: 'Burial order',
  ADMIN_ID: 'Your ID (wallet administrator)',
  MANDATE: 'Family mandate (who may manage the wallet)',
  OTHER: 'Other supporting document',
};

/** Turn a server `missing` entry into a readable line. */
export function missingLine(code: string): string {
  const [what, why] = code.split(':');
  const label = what?.startsWith('DEATH_EVIDENCE')
    ? 'One proof of death (certificate, parlour confirmation or burial order)'
    : what === 'ADMIN_ID'
      ? EVIDENCE_COPY.ADMIN_ID
      : what === 'MANDATE'
        ? EVIDENCE_COPY.MANDATE
        : (what ?? code);
  return why === 'SCAN_PENDING' ? `${label} — still being scanned, try again shortly` : label;
}
