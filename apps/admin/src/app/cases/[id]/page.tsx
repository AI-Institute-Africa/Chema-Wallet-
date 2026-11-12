'use client';
// Case detail: assign, add a note / escalate, resolve with an outcome. Every
// button calls the API, which re-authorises (role, assignment, case state).
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, explain, fmtMoney, type Me } from '../../../lib/api';
import { CASE_OUTCOMES, isUuid } from '../../../lib/portal';
import { Fields, Shell, Table, useLoad } from '../../../lib/ui';

interface CaseView {
  id: string;
  type: string;
  walletId: string | null;
  status: string;
  severity: string;
  summary: string;
  assigneeId: string | null;
  slaDueAt: string;
  escalationLevel: number;
  source: string | null;
  amount: { minor: string; ccy: string } | null;
  payoutRequestId: string | null;
  holds: { id: string; scope: string; source: string | null; reasonCode: string; released: boolean }[];
  outcome: string | null;
  openedAt: string;
  closedAt: string | null;
}

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: c, error, reload } = useLoad<CaseView>(`/cases/${id}`);
  const { data: me } = useLoad<Me>('/admin/me');
  const [assignee, setAssignee] = useState('');
  const [note, setNote] = useState('');
  const [escalate, setEscalate] = useState(false);
  const [outcome, setOutcome] = useState<(typeof CASE_OUTCOMES)[number]>('UPHELD');
  const [resolution, setResolution] = useState('');
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

  return (
    <Shell title="Case">
      <p className="small">
        <Link href="/q/cases">← Cases</Link>
      </p>
      {error && <p className="error">{error}</p>}
      {msg && <p className="card" role="status">{msg}</p>}
      {c && (
        <>
          <div className="card">
            <Fields
              data={{
                ...c,
                amount: c.amount ? fmtMoney(c.amount.minor, c.amount.ccy) : null,
                holds: c.holds.length,
              }}
              keys={['type', 'status', 'severity', 'walletId', 'assigneeId', 'slaDueAt', 'escalationLevel', 'source', 'amount', 'payoutRequestId', 'outcome', 'openedAt', 'closedAt']}
            />
            <p>{c.summary}</p>
            {c.walletId && (
              <p className="small">
                <Link href="/audit">Audit explorer</Link> · <Link href={`/closure/${c.walletId}`}>Closure checks</Link>
              </p>
            )}
            {c.payoutRequestId && (
              <p className="small">
                <Link href={`/payouts/${c.payoutRequestId}`}>Linked payout</Link>
              </p>
            )}
          </div>
          <h2>Holds linked to this case</h2>
          <Table rows={c.holds as unknown as Record<string, unknown>[]} columns={['id', 'scope', 'source', 'reasonCode', 'released']} />
          <p className="muted small">Holds are released from the Holds register (dual approval), never from here.</p>

          {c.status !== 'RESOLVED' && (
            <>
              <div className="card">
                <h2>Assign</h2>
                <div className="row">
                  <div>
                    <label htmlFor="assignee">Staff person id</label>
                    <input id="assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="uuid" />
                  </div>
                </div>
                <button disabled={!isUuid(assignee)} onClick={() => void act(() => api.post(`/cases/${id}/assign`, { assigneePersonId: assignee.trim() }), 'Assigned.')}>
                  Assign
                </button>{' '}
                {me && (
                  <button className="secondary" onClick={() => void act(() => api.post(`/cases/${id}/assign`, { assigneePersonId: me.personId }), 'Assigned to you.')}>
                    Assign to me
                  </button>
                )}
              </div>

              <div className="card">
                <h2>Update</h2>
                <label htmlFor="note">Note (3+ characters)</label>
                <textarea id="note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
                <label className="check">
                  <input type="checkbox" checked={escalate} onChange={(e) => setEscalate(e.target.checked)} /> Escalate to the next level
                </label>
                <button
                  disabled={note.trim().length < 3 && !escalate}
                  onClick={() =>
                    void act(
                      () => api.post(`/cases/${id}/update`, { ...(note.trim() ? { note: note.trim() } : {}), ...(escalate ? { escalate: true } : {}) }),
                      escalate ? 'Escalated.' : 'Note added.',
                    ).then(() => {
                      setNote('');
                      setEscalate(false);
                    })
                  }
                >
                  Save update
                </button>
              </div>

              <div className="card">
                <h2>Resolve</h2>
                <label htmlFor="outcome">Outcome</label>
                <select id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as (typeof CASE_OUTCOMES)[number])}>
                  {CASE_OUTCOMES.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
                <label htmlFor="resolution">Written reason (10+ characters)</label>
                <textarea id="resolution" rows={3} maxLength={2000} value={resolution} onChange={(e) => setResolution(e.target.value)} />
                <button disabled={resolution.trim().length < 10} onClick={() => void act(() => api.post(`/cases/${id}/resolve`, { outcome, note: resolution.trim() }), 'Case resolved.')}>
                  Resolve case
                </button>
                <p className="muted small">A case with active holds cannot be resolved: release them first in the Holds register (dual approval).</p>
              </div>
            </>
          )}
        </>
      )}
    </Shell>
  );
}
