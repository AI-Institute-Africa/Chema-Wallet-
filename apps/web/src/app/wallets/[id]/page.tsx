'use client';
// Wallet status. The server decides whether a badge, link or QR exists: a
// draft, pending or rejected wallet gets none of them.
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, type WalletView } from '../../../lib/api';
import { EVIDENCE_COPY, STATUS_COPY } from '../../../lib/copy';
import { FamilyNav } from '../../../lib/family-ui';
import { api } from '../../../lib/session';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:7600';

const SCAN_COPY = { CLEAN: 'received', PENDING: 'being scanned', INFECTED: 'rejected by the virus scan' } as const;

export default function WalletStatus() {
  const { id } = useParams<{ id: string }>();
  const [w, setW] = useState<WalletView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    api
      .wallet(id)
      .then(setW)
      .catch((e: unknown) =>
        setError(e instanceof ApiError && e.status === 401 ? 'Please sign in to see this wallet.' : 'This wallet is not available.'),
      );
  }, [id]);

  async function appeal() {
    try {
      await api.appeal(id, reason);
      setW(await api.wallet(id));
    } catch {
      setError('Please explain the appeal in at least 10 characters.');
    }
  }

  if (error) {
    return (
      <main>
        <p className="error">{error}</p>
      </main>
    );
  }
  if (!w) {
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  }
  const copy = STATUS_COPY[w.status];
  const reviewNote = w.latestCase?.reasonCode && w.latestCase.outcome !== 'APPROVED' ? w.latestCase.reasonCode : null;

  return (
    <main>
      <h1>{w.deceasedName}</h1>
      {w.badge && (
        <>
          <p>
            <span className="badge" title={w.badge.tooltip} aria-describedby="badge-meaning">
              ✓ {w.badge.label}
            </span>
          </p>
          <p id="badge-meaning" className="muted">
            {w.badge.tooltip}
          </p>
        </>
      )}
      <div className="card">
        <strong>{copy.title}</strong>
        <p className="muted">{copy.detail}</p>
        {reviewNote && <p>Reviewer reason: {reviewNote.replaceAll('_', ' ').toLowerCase()}</p>}
      </div>

      {w.share && w.publicSlug && (
        <div className="card">
          <h2>Share</h2>
          <p>{w.share.text}</p>
          <p>
            <a className="button" href={w.share.whatsapp}>
              WhatsApp
            </a>{' '}
            <a className="button" href={w.share.sms}>
              SMS
            </a>{' '}
            <a className="button" href={w.share.facebook}>
              Facebook
            </a>
          </p>
          <p className="muted">Link: {w.share.copy}</p>
          {/* Plain SVG served by our API; next/image adds nothing here. */}
          <img className="qr" alt="QR code for the wallet link" src={`${API_BASE}/public/wallets/${w.publicSlug}/qr.svg`} />
          <p>
            <Link href={`/w/${w.publicSlug}`}>Open the public page</Link> · <Link href={`/wallets/${w.id}/privacy`}>What the public page shows</Link>
          </p>
        </div>
      )}

      {(w.status === 'DRAFT' || w.status === 'VERIFICATION_REJECTED') && (
        <p>
          <Link href={`/wallets/${w.id}/evidence`}>Add documents</Link>
        </p>
      )}

      {w.canAppeal && (
        <div className="card">
          <h2>Appeal</h2>
          <label htmlFor="reason">What has changed or what was missed?</label>
          <textarea id="reason" rows={4} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button onClick={appeal}>Send appeal</button>
        </div>
      )}

      {(w.status === 'ACTIVE' || w.status === 'SUSPENDED' || w.status === 'CLOSING' || w.status === 'CLOSED') && <FamilyNav walletId={w.id} />}

      <div className="card">
        <h2>Documents</h2>
        <ul className="plain">
          {w.evidence.map((e) => (
            <li key={e.id}>
              {EVIDENCE_COPY[e.evidenceType]} — {SCAN_COPY[e.scan]}
            </li>
          ))}
          {w.evidence.length === 0 && <li className="muted">None yet.</li>}
        </ul>
      </div>
    </main>
  );
}
