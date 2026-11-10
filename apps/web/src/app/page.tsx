'use client';
// Sign in with a one-time code, then start a funeral wallet.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { api, getToken, setToken } from '../lib/session';

export default function Home() {
  const [phone, setPhone] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read the session after hydration (the page is prerendered without one).
  useEffect(() => setSignedIn(getToken() !== null), []);

  async function start() {
    setError(null);
    try {
      setChallengeId((await api.startOtp(phone)).challengeId);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? 'Too many attempts. Please wait a few minutes.' : 'Please check the phone number (e.g. +263771234567).');
    }
  }

  async function verify() {
    if (!challengeId) return;
    setError(null);
    try {
      setToken((await api.verifyOtp(challengeId, code)).token);
      setSignedIn(true);
    } catch {
      setError('That code did not work. Please try again.');
    }
  }

  return (
    <main>
      <h1>Chema Wallet</h1>
      <p className="muted">Collect support for a funeral from family and friends, safely and in one place.</p>
      {signedIn ? (
        <div className="card">
          <p>You are signed in.</p>
          <Link className="button" href="/new">
            Start a funeral wallet
          </Link>
        </div>
      ) : (
        <div className="card">
          <label htmlFor="phone">Your phone number</label>
          <input id="phone" inputMode="tel" autoComplete="tel" placeholder="+263771234567" value={phone} onChange={(e) => setPhone(e.target.value)} />
          {challengeId ? (
            <>
              <label htmlFor="code">Code we sent you</label>
              <input id="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button onClick={verify}>Sign in</button>
            </>
          ) : (
            <button onClick={start}>Send me a code</button>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </main>
  );
}
