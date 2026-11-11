'use client';
// Closure checks for one wallet (evaluated by the API from the database each
// time), the finalise action and the generated statements.
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, explain, fmtMoney } from '../../../lib/api';
import { Shell, Table, useLoad } from '../../../lib/ui';

interface ClosureCheck {
  walletId: string;
  status: string;
  blockers: string[];
  residual: { source: string; currency: string; amount: { minor: string; ccy: string } }[];
}

interface Statement {
  kind: string;
  contentHash: string;
  generatedAt: string;
  content: unknown;
}

export default function ClosureView() {
  const { walletId } = useParams<{ walletId: string }>();
  const check = useLoad<ClosureCheck>(`/wallets/${walletId}/closure`);
  const statements = useLoad<Statement[]>(`/wallets/${walletId}/statements`);
  const [msg, setMsg] = useState<string | null>(null);
  const c = check.data;

  async function finalise() {
    setMsg(null);
    try {
      await api.post(`/wallets/${walletId}/close/finalise`);
      setMsg('Wallet closed; statements generated.');
      check.reload();
      statements.reload();
    } catch (e) {
      setMsg(explain(e));
    }
  }

  return (
    <Shell title="Closure checks">
      <p className="small">
        <Link href="/closure">← Another wallet</Link>
      </p>
      {check.error && <p className="error">{check.error}</p>}
      {msg && <p className="card" role="status">{msg}</p>}
      {c && (
        <div className="card">
          <p>
            Wallet <code>{c.walletId}</code>: <strong>{c.status}</strong>
          </p>
          {c.blockers.length === 0 ? (
            <p className="ok">No blockers: the wallet can be finalised.</p>
          ) : (
            <>
              <p>Blockers (each must clear before closing):</p>
              <ul>
                {c.blockers.map((b) => (
                  <li key={b}>
                    <code>{b}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h2>Residual balances</h2>
          <Table rows={c.residual.map((r) => ({ source: r.source, amount: fmtMoney(r.amount.minor, r.amount.ccy) }))} />
          <button className="secondary small" onClick={check.reload}>
            Re-check
          </button>{' '}
          {c.status === 'CLOSING' && (
            <button disabled={c.blockers.length > 0} onClick={() => void finalise()}>
              Finalise closure
            </button>
          )}
        </div>
      )}
      <h2>Statements</h2>
      {statements.error && <p className="muted small">{statements.error}</p>}
      {statements.data && (
        <Table rows={statements.data.map((s) => ({ kind: s.kind, generatedAt: s.generatedAt, contentHash: s.contentHash }))} />
      )}
    </Shell>
  );
}
