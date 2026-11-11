'use client';
// Staff sign-in: password + authenticator code in one step (no session ever
// exists without MFA). Lockout and audit are server-side.
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, explain, setToken } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.post<{ token: string }>('/staff/auth/login', { login: login.trim(), password, totp: totp.trim() });
      setToken(s.token);
      router.replace('/');
    } catch (err) {
      setError(explain(err).startsWith('Your session') ? 'Sign-in failed. Check your details and authenticator code.' : explain(err));
      setTotp('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Staff sign-in</h1>
      <p className="muted">Chema Wallet operations portal. Authorised staff only; every action is recorded.</p>
      <form onSubmit={submit} className="card">
        <label htmlFor="login">Login</label>
        <input id="login" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <label htmlFor="totp">Authenticator code</label>
        <input id="totp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} required />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
