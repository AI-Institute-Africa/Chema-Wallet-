'use client';
// Secure hand-off page for WhatsApp links (`/h#<token>`). The token is read
// from the fragment, dropped from the address bar at once, and kept only in
// memory. The only thing typed here is the one-time code we send.
import { t } from '@chema/shared/i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError } from '../../lib/api';
import { payoutStatusLabel, purposeLabel } from '../../lib/family';
import { createHandoffClient, handoffDestination, handoffToken, type HandoffSummary } from '../../lib/handoff';
import { getToken } from '../../lib/session';

const client = createHandoffClient({ baseUrl: process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:7600', token: getToken });

type View = { kind: 'checking' } | { kind: 'none' } | { kind: 'invalid' } | { kind: 'ready'; info: HandoffSummary } | { kind: 'done'; text: string };

export default function Handoff() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'checking' });
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const tok = handoffToken(window.location.hash);
    // Remove the token from the address bar and history straight away.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    if (!tok) {
      setView({ kind: 'none' });
      return;
    }
    setToken(tok);
    client
      .describe(tok)
      .then((info) => setView({ kind: 'ready', info }))
      .catch(() => setView({ kind: 'invalid' }));
  }, []);

  async function sendCode() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setChallengeId((await client.otp(token)).challengeId);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('handoff.session_ended') : e instanceof ApiError && e.status === 404 ? t('handoff.invalid') : t('error.internal'));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!token || !challengeId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.confirm(token, challengeId, code.trim());
      setCode('');
      setView({ kind: 'done', text: r.purpose === 'LOGIN' ? t('handoff.login.done') : t('handoff.payout.done', { status: payoutStatusLabel(r.status ?? 'AWAITING_APPROVAL') }) });
      setToken(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? t('handoff.invalid') : e instanceof ApiError && e.status === 403 ? t('handoff.session_ended') : t('handoff.code_failed'));
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.open(token);
      setToken(null);
      router.push(handoffDestination(r.purpose, r.walletId));
    } catch {
      setError(t('handoff.invalid'));
      setBusy(false);
    }
  }

  return (
    <main className="public">
      <h1>{t('handoff.title')}</h1>
      {view.kind === 'checking' && <p className="muted">{t('handoff.checking')}</p>}
      {view.kind === 'none' && <p>{t('handoff.no_token')}</p>}
      {view.kind === 'invalid' && (
        <p className="error" role="alert">
          {t('handoff.invalid')}
        </p>
      )}
      {view.kind === 'done' && (
        <p className="card" role="status">
          {view.text}
        </p>
      )}
      {view.kind === 'ready' && (
        <div className="card">
          {view.info.purpose === 'LOGIN' && (
            <>
              <h2>{t('handoff.login.title')}</h2>
              <p>{t('handoff.login.detail', { phone: view.info.summary['phone'] ?? '' })}</p>
            </>
          )}
          {view.info.purpose === 'PAYOUT_REQUEST' && (
            <>
              <h2>{t('handoff.payout.title')}</h2>
              <p className="big">
                {t('handoff.payout.detail', {
                  amount: view.info.summary['amount'] ?? '',
                  payee: view.info.summary['payee'] ?? '',
                  purpose: purposeLabel(view.info.summary['purpose'] ?? 'OTHER_APPROVED'),
                })}
              </p>
            </>
          )}
          {(view.info.purpose === 'LOGIN' || view.info.purpose === 'PAYOUT_REQUEST') &&
            (challengeId ? (
              <>
                <label htmlFor="code">{t('handoff.code')}</label>
                <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                <button className="big" onClick={() => void confirm()} disabled={busy || code.length !== 6}>
                  {t('handoff.confirm')}
                </button>
              </>
            ) : (
              <button className="big" onClick={() => void sendCode()} disabled={busy}>
                {t('handoff.send_code')}
              </button>
            ))}
          {(view.info.purpose === 'EVIDENCE' || view.info.purpose === 'PORTAL') && (
            <>
              <h2>{view.info.purpose === 'EVIDENCE' ? t('handoff.open.evidence') : t('handoff.open.portal')}</h2>
              <p>{t('handoff.open.detail')}</p>
              <button className="big" onClick={() => void open()} disabled={busy}>
                {t('handoff.open.continue')}
              </button>
            </>
          )}
          <p className="muted small">{t('handoff.expires', { time: new Date(view.info.expiresAt).toLocaleTimeString() })}</p>
          <p className="muted small">{t('handoff.never')}</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
