'use client';
// Payout detail + manual override (rail down). Dual: ops/finance maker records
// the outside payment with evidence → a DIFFERENT ops/finance person approves
// in Approvals → the maker executes with the approval id. The API enforces
// every step (status, evidence scanned CLEAN and linked to the wallet, holds).
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, explain, fmtMoney } from '../../../lib/api';
import { bytesToBase64, isUuid, overrideStep } from '../../../lib/portal';
import { Fields, Shell, useLoad } from '../../../lib/ui';

interface PayoutView {
  id: string;
  walletId: string;
  planId: string;
  payeeId: string;
  purpose: string;
  source: string;
  amount: { minor: string; ccy: string };
  rail: string;
  status: string;
  approvalId: string | null;
  attempts: number;
  providerRef: string | null;
  lastError: string | null;
  blockedBy: string | null;
  requestedAt: string;
  confirmedAt: string | null;
}

const ACCEPT = 'application/pdf,image/jpeg,image/png';

export default function PayoutDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error, reload } = useLoad<PayoutView>(`/payouts/${id}`);
  const [externalRef, setExternalRef] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [approvalId, setApprovalId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await fn());
      reload();
    } catch (e) {
      setMsg(explain(e));
    } finally {
      setBusy(false);
    }
  }

  const upload = () =>
    act(async () => {
      if (!file || !p) return 'Choose a file first.';
      const doc = await api.post<{ id: string }>('/documents', {
        class: 'OTHER',
        contentType: file.type,
        dataBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        walletId: p.walletId,
      });
      setDocumentId(doc.id);
      setFile(null);
      return `Evidence uploaded (${doc.id}). It must finish the virus scan (CLEAN) before the override is accepted.`;
    });

  const request = () =>
    act(async () => {
      const r = await api.post<{ status: string; approvalId: string }>(`/payouts/${id}/override`, { externalRef: externalRef.trim(), documentId: documentId.trim() });
      setApprovalId(r.approvalId);
      return `Override requested. Approval ${r.approvalId} now waits for a different ops/finance checker.`;
    });

  const execute = () =>
    act(async () => {
      const r = await api.post<{ status: string }>(`/payouts/${id}/override`, { externalRef: externalRef.trim(), documentId: documentId.trim(), approvalId: approvalId.trim() });
      return r.status === 'CONFIRMED' ? 'Override booked: payout CONFIRMED.' : `Checker rejected the override: payout back to ${r.status}.`;
    });

  const step = p ? overrideStep(p.status) : 'NONE';

  return (
    <Shell title="Payout">
      <p className="small">
        <Link href="/failures">← Failures</Link>
      </p>
      {error && <p className="error">{error}</p>}
      {msg && <p className="card" role="status">{msg}</p>}
      {p && (
        <>
          <div className="card">
            <Fields
              data={{ ...p, amount: fmtMoney(p.amount.minor, p.amount.ccy) }}
              keys={['status', 'amount', 'source', 'purpose', 'rail', 'walletId', 'payeeId', 'attempts', 'lastError', 'blockedBy', 'approvalId', 'providerRef', 'requestedAt', 'confirmedAt']}
            />
            <p className="small">
              <Link href={`/closure/${p.walletId}`}>Wallet closure checks</Link>
            </p>
          </div>

          <div className="card">
            <h2>Manual override</h2>
            <p className="muted small">
              Only for a RAIL_DOWN payout paid outside the rail. Same external reference and document on both steps. Holds, open cases and the mandate still apply.
            </p>
            {step === 'NONE' && <p className="muted">This payout is {p.status}: no override step applies.</p>}
            <label htmlFor="ref">External payment reference</label>
            <input id="ref" maxLength={128} value={externalRef} onChange={(e) => setExternalRef(e.target.value)} />
            <label htmlFor="file">Evidence document (proof of the outside payment)</label>
            <input id="file" type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button className="secondary" disabled={busy || !file} onClick={() => void upload()}>
              Upload evidence
            </button>
            <label htmlFor="doc">Evidence document id</label>
            <input id="doc" value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder="uuid (filled after upload, or paste an existing one)" />
            <div>
              <button disabled={busy || externalRef.trim().length < 3 || !isUuid(documentId)} onClick={() => void request()}>
                1. Request override (maker)
              </button>
            </div>
            <label htmlFor="approval">Approved approval id</label>
            <input id="approval" value={approvalId} onChange={(e) => setApprovalId(e.target.value)} placeholder="from Approvals, after a different checker approved" />
            <button disabled={busy || externalRef.trim().length < 3 || !isUuid(documentId) || !isUuid(approvalId)} onClick={() => void execute()}>
              2. Execute approved override
            </button>
          </div>
        </>
      )}
    </Shell>
  );
}
