'use client';
// The family's wallet (UI redesign 2026-11-11): the SAME memorial page the
// public sees, with an owner bar on top and owner tools (photo, target) in
// place. A verified wallet loads the real public page data, so what the family
// sees is exactly what contributors see. Before verification it is a private
// preview. The server decides badge, link and QR; nothing here grants access.
import { t } from '@chema/shared/i18n';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type WalletView } from '../../../lib/api';
import { EVIDENCE_COPY, STATUS_COPY } from '../../../lib/copy';
import { NAV } from '../../../lib/family-ui';
import { API_BASE, createPublicClient, type Privacy, type PublicPage } from '../../../lib/public';
import { api, getToken } from '../../../lib/session';
import Memorial from '../../w/[slug]/memorial';
import { PhotoControl, TargetEditor } from './owner-tools';

const publicClient = createPublicClient({ baseUrl: API_BASE, token: getToken });

const SCAN_COPY = { CLEAN: 'received', PENDING: 'being scanned', INFECTED: 'rejected by the virus scan' } as const;
const LIVE = new Set(['ACTIVE', 'CLOSING', 'CLOSED']);

/** A private preview built from the wallet itself (no public page exists yet). */
function previewPage(w: WalletView): PublicPage {
  const ccy = w.currency;
  return {
    slug: '',
    deceasedName: w.deceasedName,
    dateOfDeath: w.dateOfDeath,
    funeralDate: w.funeralDate,
    funeralLocation: w.funeralLocation,
    badge: { label: '', tooltip: '' },
    share: { text: '', url: '', whatsapp: '', sms: '', facebook: '', copy: '' },
    photoPath: null,
    totals: { raised: { minor: '0', ccy }, target: w.targetMinor ? { minor: w.targetMinor, ccy } : null },
    closed: false,
    usage: null,
    tributes: null,
    contribute: { currency: ccy, rails: [], min: { minor: '1', ccy }, max: null, groupsEnabled: false },
  };
}

export default function WalletHome() {
  const { id } = useParams<{ id: string }>();
  const [w, setW] = useState<WalletView | null>(null);
  const [page, setPage] = useState<PublicPage | null>(null);
  const [privacy, setPrivacy] = useState<(Privacy & { photo: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [reason, setReason] = useState('');
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const view = await api.wallet(id);
        // Load everything before rendering, so the page never flashes the preview first.
        const [p, pr] = await Promise.all([
          view.publicSlug && LIVE.has(view.status) ? publicClient.page(view.publicSlug).catch(() => null) : Promise.resolve(null),
          publicClient.privacy(id).catch(() => null),
        ]);
        if (cancelled) return;
        setPage(p);
        setPrivacy(pr);
        setW(view);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError && e.status === 401 ? 'Please sign in to see this wallet.' : 'This wallet is not available.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, n]);

  async function toggle(key: keyof Privacy, value: boolean) {
    try {
      setPrivacy({ ...(await publicClient.setPrivacy(id, { [key]: value })), photo: privacy?.photo ?? false });
      reload();
    } catch {
      setMsg('Only the wallet administrator can change what the public page shows.');
    }
  }

  async function appeal() {
    try {
      await api.appeal(id, reason);
      reload();
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

  const live = page !== null;
  const shown = page ?? previewPage(w);
  const copy = STATUS_COPY[w.status];
  const reviewNote = w.latestCase?.reasonCode && w.latestCase.outcome !== 'APPROVED' ? w.latestCase.reasonCode : null;
  const manage = privacy !== null; // the API only answers privacy to the family admin/approver
  const editable = w.status === 'DRAFT' || w.status === 'PENDING_VERIFICATION' || w.status === 'ACTIVE';
  const target = w.targetMinor ? { minor: w.targetMinor, ccy: w.currency } : null;

  const banner = (
    <section className="owner-bar panel" data-testid="owner-bar" aria-label="Wallet administration">
      <div className="ob-head">
        <span className="chip">{copy.title}</span>
        <p>{live ? t('memorial.owner.note') : t('memorial.preview')}</p>
      </div>
      {!live && <p className="ob-msg muted">{copy.detail}</p>}
      {reviewNote && <p className="ob-msg">Reviewer reason: {reviewNote.replaceAll('_', ' ').toLowerCase()}</p>}
      <div className="ob-actions">
        {live && w.publicSlug && (
          <Link className="pill dark" href={`/w/${w.publicSlug}`}>
            Open the public page
          </Link>
        )}
        <Link className="pill" href={`/wallets/${w.id}/privacy`}>
          What the public page shows
        </Link>
        {manage && live && (
          <button type="button" className="pill" onClick={() => void toggle('showPolicyNumber', !privacy.showPolicyNumber)}>
            {privacy.showPolicyNumber ? 'Hide policy number' : 'Show policy number'}
          </button>
        )}
        {manage && live && !privacy.showPhoto && (
          <button type="button" className="pill" onClick={() => void toggle('showPhoto', true)}>
            Show the photo publicly
          </button>
        )}
        {manage && live && !privacy.showTotal && (
          <button type="button" className="pill" onClick={() => void toggle('showTotal', true)}>
            Show the total and target
          </button>
        )}
        {(w.status === 'DRAFT' || w.status === 'VERIFICATION_REJECTED') && (
          <Link className="pill dark" href={`/wallets/${w.id}/evidence`}>
            Add documents
          </Link>
        )}
      </div>
      {msg && (
        <p className="ob-msg" role="status">
          {msg}
        </p>
      )}
      {(w.status === 'ACTIVE' || w.status === 'SUSPENDED' || w.status === 'CLOSING' || w.status === 'CLOSED') && (
        <nav aria-label={t('fam.nav.title')}>
          {NAV.map(([path, key]) => (
            <Link key={path} href={`/wallets/${w.id}/${path}`}>
              {t(key)}
            </Link>
          ))}
        </nav>
      )}
    </section>
  );

  const footer = (
    <div className="m-footer">
      {w.canAppeal && (
        <div className="card">
          <h2>Appeal</h2>
          <label htmlFor="reason">What has changed or what was missed?</label>
          <textarea id="reason" rows={4} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button onClick={() => void appeal()}>Send appeal</button>
        </div>
      )}
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
    </div>
  );

  return (
    <Memorial
      page={shown}
      mode={live ? 'owner' : 'preview'}
      banner={banner}
      footer={footer}
      photoControl={
        manage && live ? <PhotoControl walletId={w.id} name={w.deceasedName} hasPhoto={shown.photoPath !== null} onDone={(m) => { setMsg(m); reload(); }} /> : undefined
      }
      targetEditor={manage && editable ? <TargetEditor walletId={w.id} target={target} currency={w.currency} onSaved={reload} /> : undefined}
    />
  );
}
