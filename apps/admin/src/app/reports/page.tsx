'use client';
// Reports (docs/12). KPIs that need data the platform does not hold are shown
// as "not measured" with the reason, never estimated. Money stays per currency.
import { useState } from 'react';
import { api, download, explain, fmtMoney, type Me } from '../../lib/api';
import { Shell, Table, useLoad } from '../../lib/ui';

interface Kpi {
  id: string;
  group: string;
  label: string;
  definition: string;
  measured: boolean;
  value: number | null;
  unit: string;
  breakdown?: Record<string, unknown>;
  note?: string;
}

function show(k: Kpi): string {
  if (!k.measured) return 'not measured';
  if (k.unit === 'minor_by_currency') {
    const parts = Object.entries(k.breakdown ?? {}).map(([ccy, v]) => fmtMoney(String(v), ccy));
    return parts.length ? parts.join(' · ') : '0';
  }
  if (k.unit === 'breakdown') return JSON.stringify(k.breakdown ?? {});
  if (k.value === null) return '—';
  if (k.unit === 'ratio') return `${(k.value * 100).toFixed(1)}%`;
  return `${k.value}${k.unit === 'hours' ? ' h' : k.unit === 'minutes' ? ' min' : ''}`;
}

export default function ReportsPage() {
  const { data: me } = useLoad<Me>('/admin/me');
  const has = (s: string) => me?.sections.includes(s) ?? false;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = [from && `from=${new Date(from).toISOString()}`, to && `to=${new Date(to).toISOString()}`].filter(Boolean).join('&');
  const mgmt = useLoad<{ kpis: Kpi[] }>(has('management') ? `/admin/reports/management${q ? `?${q}` : ''}` : null);
  const fin = useLoad<Record<string, unknown>>(has('reports') ? `/admin/reports/finance${q ? `?${q}` : ''}` : null);
  const agent = useLoad<Record<string, unknown>[]>(has('agent') ? '/admin/reports/agent' : null);
  const [walletId, setWalletId] = useState('');
  const [family, setFamily] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <Shell title="Reports">
      <div className="row">
        <div><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <p className="muted small">Default period: the last 30 days.</p>
      {msg && <p className="card">{msg}</p>}

      {mgmt.data && (
        <section id="management">
          <h2>Fidelity management dashboard</h2>
          <p className="muted small">Activity and financial outcomes are separate; no figure implies cause. No revenue or forecast figures.</p>
          <div className="grid">
            {mgmt.data.kpis.map((k) => (
              <div key={k.id} className="card kpi" title={k.definition}>
                <div className="small muted">{k.group.replace('_', ' ')}</div>
                <div>{k.label}</div>
                <div className="value">{show(k)}</div>
                <div className="small muted">{k.definition}</div>
                {k.note && <div className="small">{k.note}</div>}
              </div>
            ))}
          </div>
          {has('management') && (
            <button className="secondary small" onClick={() => void api.text(`/admin/reports/regulator?format=csv${q ? `&${q}` : ''}`).then((t) => download('regulator-export.csv', t)).catch((e: unknown) => setMsg(explain(e)))}>
              Regulator export (generic CSV; format pending D18)
            </button>
          )}
        </section>
      )}

      {fin.data && (
        <section>
          <h2>Finance: reconciliation, ageing, fees, settlements</h2>
          <h3>Exceptions ageing</h3>
          <Table rows={fin.data['exceptionAgeing'] as Record<string, unknown>[]} />
          <h3>Recon runs</h3>
          <Table rows={fin.data['reconRuns'] as Record<string, unknown>[]} />
          <h3>Balances (system accounts)</h3>
          <Table rows={['feesCollectedBalance', 'suspenseUnmatchedBalance', 'reconDiffBalance'].map((k) => ({ account: k, ...(fin.data?.[k] as object) }))} />
          <h3>Settlements</h3>
          <Table rows={fin.data['settlements'] as Record<string, unknown>[]} />
        </section>
      )}

      {agent.data && (
        <section id="agent">
          <h2>Agent activity</h2>
          <Table rows={agent.data} columns={['login', 'walletsCreated', 'walletsVerified', 'claimsAssisted']} />
        </section>
      )}

      <section>
        <h2>Family statement</h2>
        <div className="row">
          <div><label>Wallet id</label><input value={walletId} onChange={(e) => setWalletId(e.target.value)} /></div>
          <div>
            <button onClick={() => void api.get<Record<string, unknown>>(`/admin/reports/family/${walletId.trim()}`).then(setFamily).catch((e: unknown) => setMsg(explain(e)))}>Load</button>
          </div>
        </div>
        {family && (
          <>
            <Table rows={[family['wallet'] as Record<string, unknown>]} />
            <h3>Balances</h3>
            <Table rows={family['balances'] as Record<string, unknown>[]} />
            <h3>Payouts</h3>
            <Table rows={family['payouts'] as Record<string, unknown>[]} />
            <h3>Statement</h3>
            <Table rows={(family['statement'] as Record<string, unknown>[]).map((j) => ({ ...j, entries: (j['entries'] as unknown[]).length }))} />
          </>
        )}
      </section>
    </Shell>
  );
}
