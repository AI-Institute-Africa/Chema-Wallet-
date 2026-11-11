'use client';
// Work queues (docs/12 queues 1-8 + support + failures). Each queue is the
// API's view; buttons call the API, which re-authorises every action. Maker
// and checker steps are separate clicks by separate people.
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api, explain } from '../../../lib/api';
import { subjectHref } from '../../../lib/portal';
import { askReason, Shell, Table, useLoad } from '../../../lib/ui';

type Row = Record<string, unknown>;

const CHECKLIST = ['DEATH_EVIDENCE_VALID', 'ADMIN_IDENTITY_MATCHES', 'MANDATE_SHOWS_AUTHORITY', 'DETAILS_CONSISTENT', 'FRAUD_FLAGS_REVIEWED'] as const;
const REASONS = ['EVIDENCE_SUFFICIENT', 'MISSING_EVIDENCE', 'IDENTITY_MISMATCH', 'AUTHORITY_NOT_SHOWN', 'EVIDENCE_NOT_AUTHENTIC', 'DETAILS_INCONSISTENT', 'DUPLICATE_WALLET', 'OTHER'];

interface QueueDef {
  title: string;
  path: string;
  rows: (d: unknown) => Row[];
  columns?: string[];
  help?: string;
}

const arr = (d: unknown) => (Array.isArray(d) ? (d as Row[]) : []);

const QUEUES: Record<string, QueueDef> = {
  verification: {
    title: 'Verification queue',
    path: '/verification/queue',
    rows: (d) => arr((d as { cases?: unknown }).cases),
    help: 'Assigned cases only. Approve needs every checklist item to pass; reject / more info need notes. You cannot decide a case you created or are family on.',
  },
  claims: { title: 'Claims mirror', path: '/admin/queues/claims', rows: arr, help: 'Fidelity decides claims. This mirrors status; blocked routes are unblocked by a claims officer (maker) and ops/finance (checker).' },
  approvals: {
    title: 'Approvals (checker view)',
    path: '/admin/queues/approvals',
    rows: arr,
    columns: ['action', 'subjectType', 'walletId', 'amountMinor', 'currency', 'makerRole', 'createdAt', 'escalatedTo', 'canDecide', 'whyNot'],
    help: 'You can decide only where canDecide is true: never your own request, and only for actions your role checks.',
  },
  cases: { title: 'Cases', path: '/cases', rows: arr, columns: ['type', 'status', 'severity', 'walletId', 'summary', 'assigneeId', 'slaDueAt', 'escalationLevel'] },
  recon: {
    title: 'Reconciliation exceptions',
    path: '/recon/exceptions',
    rows: (d) => arr((d as { exceptions?: unknown }).exceptions),
    columns: ['kind', 'severity', 'rail', 'walletId', 'varianceMinor', 'currency', 'detail', 'holdId', 'openedAt', 'slaDueAt'],
    help: 'Take ownership, then resolve with a written reason. A held exception resolves only after its hold is released (dual approval, Holds register). Money corrections go through Ledger adjustment.',
  },
  moderation: { title: 'Tribute moderation', path: '/tributes/review-queue', rows: (d) => arr((d as { items?: unknown }).items) },
  fraud: {
    title: 'Fraud flags & reports',
    path: '/admin/queues/fraud',
    rows: (d) => [
      ...arr((d as { flags?: unknown }).flags).map((r) => ({ type: 'flag', ...r })),
      ...arr((d as { reports?: unknown }).reports).map((r) => ({ type: 'report', ...r })),
    ],
  },
  holds: {
    title: 'Holds register',
    path: '/admin/queues/holds',
    rows: arr,
    columns: ['walletId', 'scope', 'sourceKind', 'amountMinor', 'currency', 'reasonCode', 'ownerId', 'reviewAt', 'overdue', 'pendingReleaseApproval'],
    help: 'Overdue = past its review date. Release is dual: request it, a different person approves it in Approvals, then you execute it here with the approval id.',
  },
  support: { title: 'Support hand-offs', path: '/admin/queues/support', rows: arr, columns: ['ref', 'reason', 'status', 'createdAt', 'lastInboundAt', 'signedIn', 'wallets'] },
  failures: {
    title: 'Delivery & integration failures',
    path: '/admin/queues/failures',
    rows: (d) =>
      Object.entries((d ?? {}) as Record<string, unknown>).flatMap(([kind, rows]) => arr(rows).map((r) => ({ kind, ...r }))),
  },
};

export default function QueuePage() {
  const { name } = useParams<{ name: string }>();
  const def = QUEUES[name];
  const { data, error, reload } = useLoad<unknown>(def ? def.path : null);
  const [msg, setMsg] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      const r = await fn();
      const approvalId = (r as { approvalId?: string } | undefined)?.approvalId;
      setMsg(approvalId && (r as { status?: string }).status === 'PENDING_APPROVAL' ? `${ok} Approval ${approvalId} now waits for a different checker.` : ok);
      reload();
    } catch (e) {
      setMsg(explain(e));
    }
  }

  if (!def) return <Shell title="Unknown queue"><p>No such queue.</p></Shell>;

  const actions = (r: Row): ReactNode => {
    const id = String(r['id'] ?? '');
    switch (name) {
      case 'cases':
        return <Link href={`/cases/${id}`}>Open</Link>;
      case 'approvals': {
        const href = subjectHref(r);
        const open = href ? <Link href={href}>Open</Link> : null;
        return r['canDecide'] ? (
          <>
            {open}{' '}
            <button className="small" onClick={() => void act(() => api.post(`/approvals/${id}/decision`, { decision: 'APPROVED' }), 'Approved.')}>Approve</button>{' '}
            <button className="small secondary" onClick={() => void act(() => api.post(`/approvals/${id}/decision`, { decision: 'REJECTED' }), 'Rejected.')}>Reject</button>
          </>
        ) : open;
      }
      case 'recon':
        return (
          <>
            <button className="small secondary" onClick={() => void act(() => api.post(`/admin/recon/exceptions/${id}/assign`), 'You own this exception.')}>Take</button>
            <button
              className="small"
              onClick={() => {
                const resolution = askReason('Resolve this exception');
                if (resolution) void act(() => api.post(`/admin/recon/exceptions/${id}/resolve`, { resolution }), 'Resolved.');
              }}
            >
              Resolve
            </button>
          </>
        );
      case 'holds':
        return r['releasedAt'] ? null : (
          <>
            <button
              className="small secondary"
              onClick={() => {
                const reason = askReason('Request release of this hold (a different person must approve)');
                if (reason) void act(() => api.post(`/holds/${id}/release`, { reason }), 'Release requested.');
              }}
            >
              Request release
            </button>
            <button
              className="small"
              onClick={() => {
                const approvalId = window.prompt('Approved release: approval id');
                const reason = approvalId ? askReason('Same reason as the request') : null;
                if (approvalId && reason) void act(() => api.post(`/holds/${id}/release`, { reason, approvalId: approvalId.trim() }), 'Hold released.');
              }}
            >
              Execute
            </button>
          </>
        );
      case 'support':
        return r['status'] === 'OPEN' ? (
          <button
            className="small"
            onClick={() => {
              const note = askReason(`Close hand-off ${String(r['ref'])}`);
              if (note) void act(() => api.post(`/admin/support/${id}/close`, { note }), 'Hand-off closed.');
            }}
          >
            Close
          </button>
        ) : null;
      case 'moderation':
        return (
          <>
            {(['APPROVE', 'HIDE', 'REJECT'] as const).map((o) => (
              <button key={o} className="small secondary" onClick={() => void act(() => api.post(`/tributes/${id}/moderate`, { outcome: o }), `Tribute ${o.toLowerCase()}d.`)}>
                {o.toLowerCase()}
              </button>
            ))}
          </>
        );
      case 'fraud':
        return r['type'] === 'flag' ? (
          <>
            {(['DISMISSED', 'CONFIRMED'] as const).map((o) => (
              <button
                key={o}
                className="small secondary"
                onClick={() => {
                  const note = askReason(`Mark flag ${o.toLowerCase()}`);
                  if (note) void act(() => api.post(`/fraud-flags/${id}/review`, { outcome: o, note }), `Flag ${o.toLowerCase()}.`);
                }}
              >
                {o.toLowerCase()}
              </button>
            ))}
          </>
        ) : null;
      case 'verification':
        return <VerificationDecision caseId={id} onDone={(m) => { setMsg(m); reload(); }} />;
      default:
        return null;
    }
  };

  return (
    <Shell title={def.title}>
      {def.help && <p className="muted small">{def.help}</p>}
      {error && <p className="error">{error}</p>}
      {msg && <p className="card" role="status">{msg}</p>}
      <button className="secondary small" onClick={reload}>Refresh</button>
      {data !== null && <Table rows={def.rows(data)} {...(def.columns ? { columns: def.columns } : {})} actions={actions} />}
    </Shell>
  );
}

function VerificationDecision({ caseId, onDone }: { caseId: string; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('EVIDENCE_SUFFICIENT');
  const [notes, setNotes] = useState('');
  if (!open) return <button className="small" onClick={() => setOpen(true)}>Decide</button>;
  const checklist = Object.fromEntries(CHECKLIST.map((c) => [c, checks[c] ? 'PASS' : 'FAIL']));
  const decide = async (outcome: 'APPROVED' | 'REJECTED' | 'MORE_INFO') => {
    try {
      await api.post(`/verification/cases/${caseId}/decide`, {
        outcome,
        reasonCode: outcome === 'APPROVED' ? 'EVIDENCE_SUFFICIENT' : reason,
        checklist,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onDone(`Case ${outcome.toLowerCase().replace('_', ' ')}.`);
    } catch (e) {
      onDone(explain(e));
    }
  };
  return (
    <div className="card small">
      {CHECKLIST.map((c) => (
        <label key={c} className="check">
          <input type="checkbox" checked={!!checks[c]} onChange={(e) => setChecks({ ...checks, [c]: e.target.checked })} /> {c.replace(/_/g, ' ').toLowerCase()}
        </label>
      ))}
      <label>Reason (reject / more info)</label>
      <select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
      <label>Notes</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button className="small" onClick={() => void decide('APPROVED')}>Approve</button>{' '}
      <button className="small secondary" onClick={() => void decide('MORE_INFO')}>More info</button>
      <button className="small secondary" onClick={() => void decide('REJECTED')}>Reject</button>
    </div>
  );
}
