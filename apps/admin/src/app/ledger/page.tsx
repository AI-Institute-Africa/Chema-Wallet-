'use client';
// Ledger adjustment (docs/02, docs/04 §1): a compensating ADJUSTMENT journal,
// never an edit. Maker requests → a different ops/finance person approves in
// Approvals → the maker executes with the approval id. The API dry-runs the
// ledger's own rules at request time and pins the exact entries approved.
import { useState } from 'react';
import { api, explain, fmtMoney } from '../../lib/api';
import { Shell, Table, useLoad } from '../../lib/ui';

interface Account {
  id: string;
  code: string;
  kind: string;
  currency: string;
  available?: string;
}
interface Line {
  accountId: string;
  side: 'D' | 'C';
  minor: string;
  ccy: 'USD' | 'ZWG';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const empty = (): Line => ({ accountId: '', side: 'D', minor: '', ccy: 'USD' });

export default function LedgerPage() {
  const [walletId, setWalletId] = useState('');
  const wallet = useLoad<Account[]>(UUID.test(walletId.trim()) ? `/admin/ledger/accounts?walletId=${walletId.trim()}` : null);
  const system = useLoad<Account[]>('/admin/ledger/accounts');
  const [lines, setLines] = useState<Line[]>([empty(), { ...empty(), side: 'C' }]);
  const [reason, setReason] = useState('');
  const [approvalId, setApprovalId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const accounts = [...(wallet.data ?? []), ...(system.data ?? [])];
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit(execute: boolean) {
    setMsg(null);
    try {
      const body = { entries: lines, reason: reason.trim(), ...(execute ? { approvalId: approvalId.trim() } : {}) };
      const r = await api.post<{ status: string; approvalId: string; journalId?: string }>('/admin/ledger/adjustments', body);
      if (r.status === 'POSTED') setMsg(`Posted: journal ${r.journalId}.`);
      else {
        setApprovalId(r.approvalId);
        setMsg(`Requested. Approval ${r.approvalId} waits for a different ops/finance checker. Execute it here once approved, with the same lines and reason.`);
      }
      wallet.reload();
    } catch (e) {
      setMsg(explain(e));
    }
  }

  return (
    <Shell title="Ledger adjustment">
      <p className="muted small">Debits and credits must balance per currency and stay within one wallet and one sub-ledger. Value leaves a wallet only to an allowed exit account; community money never funds Fidelity or platform accounts.</p>
      <label htmlFor="w">Wallet id (optional: leave empty for system-only)</label>
      <input id="w" value={walletId} onChange={(e) => setWalletId(e.target.value)} placeholder="uuid" />
      {wallet.error && <p className="error">{wallet.error}</p>}
      {wallet.data && (
        <Table
          rows={wallet.data.map((a) => ({ code: a.code, currency: a.currency, available: fmtMoney(a.available, a.currency) }))}
        />
      )}
      <h2>Entries</h2>
      {lines.map((l, i) => (
        <div className="row card" key={i}>
          <div>
            <label>Account</label>
            <select value={l.accountId} onChange={(e) => {
              const a = accounts.find((x) => x.id === e.target.value);
              set(i, { accountId: e.target.value, ...(a ? { ccy: a.currency as Line['ccy'] } : {}) });
            }}>
              <option value="">Choose…</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.currency}</option>)}
            </select>
          </div>
          <div>
            <label>Side</label>
            <select value={l.side} onChange={(e) => set(i, { side: e.target.value as Line['side'] })}>
              <option value="D">Debit</option>
              <option value="C">Credit</option>
            </select>
          </div>
          <div>
            <label>Amount (minor units, e.g. 2500 = 25.00)</label>
            <input inputMode="numeric" value={l.minor} onChange={(e) => set(i, { minor: e.target.value.replace(/[^0-9]/g, '') })} />
          </div>
        </div>
      ))}
      <button className="secondary small" onClick={() => setLines([...lines, empty()])} disabled={lines.length >= 10}>Add line</button>
      <button className="secondary small" onClick={() => setLines(lines.slice(0, -1))} disabled={lines.length <= 2}>Remove line</button>
      <label htmlFor="r">Reason (written, 10+ characters; recorded on the journal)</label>
      <textarea id="r" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row">
        <div><button onClick={() => void submit(false)}>Request adjustment</button></div>
        <div>
          <label htmlFor="a">Approval id (to execute)</label>
          <input id="a" value={approvalId} onChange={(e) => setApprovalId(e.target.value)} />
        </div>
        <div><button onClick={() => void submit(true)} disabled={!UUID.test(approvalId.trim())}>Execute approved</button></div>
      </div>
      {msg && <p className="card" role="status">{msg}</p>}
    </Shell>
  );
}
