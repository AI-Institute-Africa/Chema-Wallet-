'use client';
// Audit explorer (docs/12, docs/14): a wallet's history rebuilt from the
// hash-chained audit log + the append-only ledger, with cross-checks; and the
// whole-chain verifier.
import { useState } from 'react';
import { api, explain } from '../../lib/api';
import { Shell, Table } from '../../lib/ui';

interface Recon {
  ok: boolean;
  events: Record<string, unknown>[];
  checks: {
    journals: number;
    unexplainedJournals: string[];
    balancesReplayed: Record<string, unknown>[];
    balancesOk: boolean;
    chain: { ok: boolean; count: number; head?: string; seq?: string; problem?: string };
  };
}

export default function AuditPage() {
  const [walletId, setWalletId] = useState('');
  const [r, setR] = useState<Recon | null>(null);
  const [chain, setChain] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <Shell title="Audit explorer">
      <div className="card">
        <button
          onClick={() =>
            void api
              .post<Recon['checks']['chain']>('/admin/audit/verify')
              .then((c) => setChain(c.ok ? `Chain intact: ${c.count} rows, head ${c.head?.slice(0, 16)}…` : `CHAIN BROKEN at seq ${c.seq} (${c.problem}). Treat as a data incident (runbook 05).`))
              .catch((e: unknown) => setChain(explain(e)))
          }
        >
          Verify audit chain
        </button>
        {chain && <p className={chain.startsWith('Chain intact') ? 'ok' : 'error'}>{chain}</p>}
      </div>
      <div className="row">
        <div><label>Wallet id</label><input value={walletId} onChange={(e) => setWalletId(e.target.value)} /></div>
        <div>
          <button onClick={() => void api.get<Recon>(`/admin/audit/wallets/${walletId.trim()}`).then((x) => { setR(x); setMsg(null); }).catch((e: unknown) => setMsg(explain(e)))}>
            Reconstruct
          </button>
        </div>
      </div>
      {msg && <p className="error">{msg}</p>}
      {r && (
        <>
          <p className={r.ok ? 'ok' : 'error'}>
            {r.ok
              ? `Reconstruction consistent: ${r.checks.journals} journals, every one explained by an audited action; balances replay; chain intact.`
              : `Mismatch: ${r.checks.unexplainedJournals.length} unexplained journal(s); balances ${r.checks.balancesOk ? 'ok' : 'DIFFER'}; chain ${r.checks.chain.ok ? 'ok' : 'BROKEN'}.`}
          </p>
          {r.checks.unexplainedJournals.length > 0 && <p className="error">Unexplained: {r.checks.unexplainedJournals.join(', ')}</p>}
          <h2>Balances replayed from journals</h2>
          <Table rows={r.checks.balancesReplayed} />
          <h2>Timeline</h2>
          <Table
            rows={r.events.map((e) => ({ ...e, entries: Array.isArray(e['entries']) ? (e['entries'] as unknown[]).length : undefined }))}
            columns={['at', 'source', 'action', 'actorRole', 'channel', 'subjectType', 'authz', 'reasonCode', 'approvalRef', 'txnRef', 'entries', 'explainedBy']}
          />
        </>
      )}
    </Shell>
  );
}
