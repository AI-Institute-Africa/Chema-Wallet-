'use client';
// One mandate change: verifier decision (assigned verifier, not a party) and
// execute (the family requester only; shown here too, the API decides).
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, explain } from '../../../lib/api';
import { reasonsFor, type MandateReason } from '../../../lib/portal';
import { Fields, Shell, useLoad } from '../../../lib/ui';

interface MandateChange {
  id: string;
  walletId: string;
  kind: string;
  status: string;
  approvalId: string;
  approval: string;
  verifier: string;
  newAdminPerson: string | null;
  approverPerson: string | null;
  requestedBy: string;
}

export default function MandateChangePage() {
  const { id } = useParams<{ id: string }>();
  const { data: c, error, reload } = useLoad<MandateChange>(`/mandate-changes/${id}`);
  const [outcome, setOutcome] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [reason, setReason] = useState<MandateReason>('AUTHORITY_SHOWN');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      reload();
    } catch (e) {
      setMsg(explain(e));
    }
  }

  const reasons = reasonsFor(outcome);
  const noteOk = outcome === 'APPROVED' || note.trim().length >= 10;

  return (
    <Shell title="Mandate change">
      <p className="small">
        <Link href="/mandate">← Mandate changes</Link>
      </p>
      {error && <p className="error">{error}</p>}
      {msg && <p className="card" role="status">{msg}</p>}
      {c && (
        <>
          <div className="card">
            <Fields data={{ ...c }} keys={['kind', 'status', 'walletId', 'approval', 'verifier', 'approvalId', 'newAdminPerson', 'approverPerson', 'requestedBy']} />
            <p className="muted small">Authority evidence is reviewed in the wallet's documents; it is never shown in this list.</p>
          </div>
          {c.status === 'PENDING' && c.verifier === 'PENDING' && (
            <div className="card">
              <h2>Verifier decision</h2>
              <label htmlFor="outcome">Outcome</label>
              <select
                id="outcome"
                value={outcome}
                onChange={(e) => {
                  const o = e.target.value as 'APPROVED' | 'REJECTED';
                  setOutcome(o);
                  setReason(reasonsFor(o)[0] ?? 'OTHER');
                }}
              >
                <option value="APPROVED">APPROVED (authority shown)</option>
                <option value="REJECTED">REJECTED</option>
              </select>
              <label htmlFor="reason">Reason code</label>
              <select id="reason" value={reason} onChange={(e) => setReason(e.target.value as MandateReason)}>
                {reasons.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <label htmlFor="note">Note {outcome === 'REJECTED' ? '(required, 10+ characters)' : '(optional)'}</label>
              <textarea id="note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
              <button
                disabled={!noteOk}
                onClick={() =>
                  void act(() => api.post(`/mandate-changes/${id}/verify`, { outcome, reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) }), `Verification recorded: ${outcome}.`)
                }
              >
                Record verification
              </button>
            </div>
          )}
          {c.status === 'PENDING' && (
            <div className="card">
              <h2>Execute</h2>
              <p className="muted small">Runs once the family checker and the verifier both approved. Only the requester may execute.</p>
              <button className="secondary" onClick={() => void act(() => api.post(`/mandate-changes/${id}/execute`), 'Change executed.')}>
                Execute change
              </button>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
