'use client';
// Config & flags (docs/12 queue 9). Every change is audited with a reason.
// Financial flags are dual: request → another Fidelity admin approves →
// apply with the approval id and the SAME value. Locked flags never change.
// An env override (CHEMA_FLAG_*) wins over anything set here.
import { useState } from 'react';
import { api, explain } from '../../lib/api';
import { askReason, Shell, Table, useLoad } from '../../lib/ui';

interface Flag {
  key: string;
  description: string;
  decision: string | null;
  financial: boolean;
  locked: boolean;
  value: unknown;
  source: string;
  error: string | null;
}
interface View {
  flags: Flag[];
  changes: Record<string, unknown>[];
  pending: Record<string, unknown>[];
}

function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export default function ConfigPage() {
  const { data, error, reload } = useLoad<View>('/admin/queues/config');
  const [msg, setMsg] = useState<string | null>(null);

  async function change(f: Flag) {
    const raw = window.prompt(`New value for ${f.key} (JSON: true, false, a number, "text", or empty for unset)`, JSON.stringify(f.value));
    if (raw === null) return;
    const value = parseValue(raw);
    setMsg(null);
    try {
      if (f.financial) {
        const r = await api.post<{ approvalId: string }>(`/admin/flags/${f.key}/request`, { value });
        setMsg(`Financial flag: approval ${r.approvalId} requested. After a different Fidelity admin approves, use "Apply approved".`);
      } else {
        const reason = askReason(`Change ${f.key}`);
        if (!reason) return;
        await api.post(`/admin/flags/${f.key}`, { value, reason });
        setMsg(`${f.key} updated.`);
      }
      reload();
    } catch (e) {
      setMsg(explain(e));
    }
  }

  async function applyApproved(f: Flag) {
    const approvalId = window.prompt(`Approval id for ${f.key}`);
    const raw = approvalId ? window.prompt('The exact value that was approved (JSON)') : null;
    const reason = raw !== null && approvalId ? askReason(`Apply ${f.key}`) : null;
    if (!approvalId || raw === null || !reason) return;
    try {
      await api.post(`/admin/flags/${f.key}`, { value: parseValue(raw), reason, approvalId: approvalId.trim() });
      setMsg(`${f.key} applied.`);
      reload();
    } catch (e) {
      setMsg(explain(e));
    }
  }

  return (
    <Shell title="Config & flags">
      {error && <p className="error">{error}</p>}
      {msg && <p className="card" role="status">{msg}</p>}
      {data && (
        <>
          <Table
            rows={data.flags.map((f) => ({ ...f, value: f.value === null ? 'unset' : JSON.stringify(f.value) }))}
            columns={['key', 'value', 'source', 'financial', 'locked', 'decision', 'description']}
            actions={(r) => {
              const f = data.flags.find((x) => x.key === r['key']);
              if (!f || f.locked) return <span className="muted small">locked</span>;
              return (
                <>
                  <button className="small secondary" onClick={() => void change(f)}>{f.financial ? 'Request' : 'Change'}</button>
                  {f.financial && <button className="small" onClick={() => void applyApproved(f)}>Apply approved</button>}
                </>
              );
            }}
          />
          <h2>Pending financial changes</h2>
          <Table rows={data.pending} />
          <h2>Recent changes</h2>
          <Table rows={data.changes} />
        </>
      )}
    </Shell>
  );
}
