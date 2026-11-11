'use client';
// Shared pieces for the family screens: load hook, wallet nav, the OTP
// step-up box. Step-up only ever asks for the one-time code we send; nothing
// else (no PIN, password or card) is collected.
import { t } from '@chema/shared/i18n';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { explainError, type StepUpTarget } from './family';
import { family } from './session';

export function useLoad<T>(load: (() => Promise<T>) | null, deps: readonly unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!load) return;
    let live = true;
    setError(null);
    load()
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(explainError(e)));
    return () => {
      live = false;
    };
  }, [...deps, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

export const NAV = [
  ['funds', 'fam.nav.funds'],
  ['claim', 'fam.nav.claim'],
  ['payees', 'fam.nav.payees'],
  ['payouts', 'fam.nav.payouts'],
  ['cases', 'fam.nav.cases'],
  ['closure', 'fam.nav.closure'],
] as const;

export function FamilyNav({ walletId }: { walletId: string }) {
  return (
    <nav aria-label={t('fam.nav.title')} className="card">
      <strong>{t('fam.nav.title')}</strong>
      <ul className="plain">
        {NAV.map(([path, key]) => (
          <li key={path}>
            <Link href={`/wallets/${walletId}/${path}`}>{t(key)}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Page({ title, walletId, intro, children }: { title: string; walletId: string; intro?: string; children: ReactNode }) {
  return (
    <main>
      <p className="small">
        <Link href={`/wallets/${walletId}`}>{t('fam.back')}</Link>
      </p>
      <h1>{title}</h1>
      {intro && <p className="muted">{intro}</p>}
      {children}
    </main>
  );
}

export function Status({ error, message }: { error?: string | null; message?: string | null }) {
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="card" role="status">
          {message}
        </p>
      )}
    </>
  );
}

/**
 * One-time-code confirmation for a step-up action. Calls `onToken` with the
 * short-lived step-up token; the caller sends it as `x-step-up-token`.
 */
export function StepUp({ target, onToken, onCancel }: { target: StepUpTarget; onToken: (token: string) => void; onCancel: () => void }) {
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      setChallengeId((await family.stepUpStart(target)).challengeId);
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      const g = await family.stepUpVerify(challengeId, code.trim());
      setCode('');
      onToken(g.stepUpToken);
    } catch {
      setError(t('stepup.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" role="group" aria-labelledby="stepup-title">
      <h2 id="stepup-title">{t('stepup.title')}</h2>
      <p className="muted">{t('stepup.explain')}</p>
      {challengeId ? (
        <>
          <label htmlFor="stepup-code">{t('stepup.code')}</label>
          <input id="stepup-code" inputMode="numeric" autoComplete="one-time-code" maxLength={12} value={code} onChange={(e) => setCode(e.target.value)} />
          <button onClick={() => void confirm()} disabled={busy || code.trim().length < 4}>
            {t('stepup.confirm')}
          </button>
        </>
      ) : (
        <button onClick={() => void send()} disabled={busy}>
          {t('stepup.send')}
        </button>
      )}{' '}
      <button className="secondary" onClick={onCancel} disabled={busy}>
        {t('stepup.cancel')}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
