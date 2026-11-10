'use client';
// Contribution status + receipt, opened from the signed link `/c/<id>#t=<token>`.
// The token stays in the fragment (never sent to a server as a URL) and goes
// to the API as a header. Works even if the receipt message never arrived.
import { t } from '@chema/shared/i18n';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API_BASE, createPublicClient, formatMoney, tokenFromHash, type ContributionView } from '../../../lib/public';

const client = createPublicClient({ baseUrl: API_BASE });
const OPEN = new Set(['INITIATED', 'PENDING_UNKNOWN']);

export default function ContributionStatus() {
  const { id } = useParams<{ id: string }>();
  const [token, setToken] = useState<string | null>(null);
  const [v, setV] = useState<ContributionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const tok = tokenFromHash(window.location.hash);
    if (!tok) {
      setError(t('error.not_available'));
      return;
    }
    setToken(tok);
    let stop = false;
    let delay = 3_000;
    const tick = async () => {
      try {
        const view = await client.contribution(id, tok);
        if (stop) return;
        setV(view);
        if (!OPEN.has(view.state)) return;
      } catch {
        if (!stop) setError(t('error.not_available'));
        return;
      }
      delay = Math.min(delay * 1.5, 30_000);
      setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [id]);

  async function reissue() {
    if (!token) return;
    await client.reissue(id, token).then(() => setNote('Receipt sent again.')).catch(() => setNote(t('error.internal')));
  }
  async function remove() {
    if (!token || !confirm('Remove your message from the page? Your contribution stays.')) return;
    await client.removeTribute(id, token);
    setV(await client.contribution(id, token));
  }

  if (error) return <main><p className="error">{error}</p></main>;
  if (!v) return <main><p className="muted">Loading…</p></main>;
  const r = v.receipt;

  return (
    <main className="public">
      <h1>{v.funeralName}</h1>
      {OPEN.has(v.state) && (
        <div className="card" aria-live="polite">
          <p>{t('status.pending')}</p>
          {v.next?.type === 'PROMPT' && <p className="muted">{v.next.message}</p>}
          {v.next?.type === 'REDIRECT' && <a className="button" href={v.next.url}>Continue to checkout</a>}
        </div>
      )}
      {(v.state === 'FAILED' || v.state === 'EXPIRED') && <p className="error">{t('status.failed')}</p>}
      {r && (
        <div className="card receipt">
          <p className="big">{t('status.succeeded')}</p>
          <h2>{t('receipt.title', { receiptNo: r.receiptNo })}</h2>
          <dl>
            <dt>Funeral</dt>
            <dd>{r.funeralName}</dd>
            <dt>Wallet ref</dt>
            <dd>{r.walletRef}</dd>
            <dt>Amount</dt>
            <dd>{formatMoney(r.amount)}</dd>
            <dt>Fee</dt>
            <dd>{formatMoney(r.fee)}</dd>
            <dt>Received by the family</dt>
            <dd>{formatMoney(r.net)}</dd>
            <dt>Exchange rate</dt>
            <dd>{r.fxRate ?? 'none'}</dd>
            <dt>Payment ref</dt>
            <dd>{r.paymentRef}</dd>
            <dt>Date</dt>
            <dd>{r.issuedAt.slice(0, 16).replace('T', ' ')}</dd>
          </dl>
          <button className="secondary" onClick={() => void reissue()}>
            Send receipt again
          </button>
          <button className="secondary" onClick={() => window.print()}>
            Print
          </button>
          {note && <p className="muted">{note}</p>}
        </div>
      )}
      {v.tribute && v.tribute.status !== 'VOID' && (
        <div className="card">
          {v.tribute.message && <p>“{v.tribute.message}”</p>}
          {v.tribute.status === 'HIDDEN' && <p className="muted">{t('tribute.hidden')}</p>}
          {v.tribute.status === 'REMOVED' && <p className="muted">{t('tribute.removed')}</p>}
          {v.tribute.status !== 'REMOVED' && (
            <button className="secondary" onClick={() => void remove()}>
              Remove my message
            </button>
          )}
        </div>
      )}
      <p className="muted small">Keep this link: it is the only way to open this receipt without an account.</p>
    </main>
  );
}
