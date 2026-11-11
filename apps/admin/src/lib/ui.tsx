'use client';
// Shared portal pieces: session gate + role-gated nav, a generic table, and
// a hook for loading data. Keep business logic out of here.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, explain, setToken, type Me } from './api';

export const SECTION_LABELS: Record<string, { label: string; href: string }> = {
  verification: { label: 'Verification', href: '/q/verification' },
  claims: { label: 'Claims mirror', href: '/q/claims' },
  approvals: { label: 'Approvals', href: '/q/approvals' },
  cases: { label: 'Cases', href: '/q/cases' },
  recon: { label: 'Recon exceptions', href: '/q/recon' },
  moderation: { label: 'Moderation', href: '/q/moderation' },
  fraud: { label: 'Fraud flags', href: '/q/fraud' },
  holds: { label: 'Holds register', href: '/q/holds' },
  config: { label: 'Config & flags', href: '/config' },
  staff: { label: 'Staff & roles', href: '/staff' },
  ledger: { label: 'Ledger adjustment', href: '/ledger' },
  reports: { label: 'Reports', href: '/reports' },
  management: { label: 'Management KPIs', href: '/reports#management' },
  agent: { label: 'Agent report', href: '/reports#agent' },
  audit: { label: 'Audit explorer', href: '/audit' },
  support: { label: 'Support hand-offs', href: '/q/support' },
  failures: { label: 'Failures', href: '/q/failures' },
};

export function useLoad<T>(path: string | null): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setError(null);
    api
      .get<T>(path)
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(explain(e)));
    return () => {
      live = false;
    };
  }, [path, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api
      .get<Me>('/admin/me')
      .then(setMe)
      .catch(() => router.replace('/login'));
  }, [router]);
  if (!me) return <main className="wide"><p className="muted">Loading…</p></main>;
  return (
    <div className="layout">
      <nav className="side">
        <strong>Chema · Staff</strong>
        <p className="small muted">{me.role.replace(/_/g, ' ').toLowerCase()}</p>
        <ul className="plain">
          <li><Link href="/">Home</Link></li>
          {me.sections.map((s) => SECTION_LABELS[s] && (
            <li key={s}><Link href={SECTION_LABELS[s].href}>{SECTION_LABELS[s].label}</Link></li>
          ))}
        </ul>
        <button
          className="secondary"
          onClick={() => {
            void api.post('/auth/logout').catch(() => undefined);
            setToken(null);
            router.replace('/login');
          }}
        >
          Sign out
        </button>
      </nav>
      <main className="wide">
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function Table({
  rows,
  columns,
  actions,
}: {
  rows: Record<string, unknown>[];
  columns?: string[];
  actions?: (row: Record<string, unknown>) => ReactNode;
}) {
  if (rows.length === 0) return <p className="muted">Nothing here.</p>;
  const cols = columns ?? Object.keys(rows[0] ?? {});
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            {cols.map((c) => <th key={c}>{c}</th>)}
            {actions && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={String(r['id'] ?? i)}>
              {cols.map((c) => <td key={c}>{cell(r[c])}</td>)}
              {actions && <td className="actions">{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ask for a written reason (10+ chars) before a human decision. */
export function askReason(what: string): string | null {
  const v = window.prompt(`${what}\n\nWritten reason (at least 10 characters):`);
  if (v === null) return null;
  if (v.trim().length < 10) {
    window.alert('A reason of at least 10 characters is required.');
    return null;
  }
  return v.trim();
}
