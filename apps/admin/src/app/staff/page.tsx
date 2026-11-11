'use client';
// Staff & roles (docs/02 Staff, docs/12 queue 10). Enrolment returns a
// one-time password + authenticator secret, shown once here and never again:
// hand them to the person out of band. Privileged roles (Fidelity admin,
// ops/finance, auditor) need a second Fidelity admin's approval.
import { useState, type FormEvent } from 'react';
import { api, download, explain } from '../../lib/api';
import { askReason, Shell, Table, useLoad } from '../../lib/ui';

const ROLES = ['AGENT', 'CLAIMS_OFFICER', 'COMMUNITY_VERIFIER', 'OPS_FINANCE', 'FIDELITY_ADMIN', 'AUDITOR'];

interface Enrolled {
  status: 'ENROLLED' | 'PENDING_APPROVAL';
  approvalId?: string;
  login?: string;
  initialPassword?: string;
  totpSecret?: string;
  otpauth?: string;
}

export default function StaffPage() {
  const { data, error, reload } = useLoad<Record<string, unknown>[]>('/admin/staff');
  const [msg, setMsg] = useState<string | null>(null);
  const [secret, setSecret] = useState<Enrolled | null>(null);
  const [form, setForm] = useState({ login: '', role: 'COMMUNITY_VERIFIER', name: '', approvalId: '' });
  const [assign, setAssign] = useState({ staffPersonId: '', walletId: '' });

  async function enrol(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setSecret(null);
    try {
      const r = await api.post<Enrolled>('/admin/staff', {
        login: form.login.trim(),
        role: form.role,
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        ...(form.approvalId.trim() ? { approvalId: form.approvalId.trim() } : {}),
      });
      if (r.status === 'ENROLLED') setSecret(r);
      else setMsg(`Privileged role: approval ${r.approvalId} waits for a different Fidelity admin. Then enrol again with the same login, role and name plus that approval id.`);
      reload();
    } catch (err) {
      setMsg(explain(err));
    }
  }

  async function toggle(r: Record<string, unknown>) {
    const disabled = !r['disabled'];
    const reason = askReason(`${disabled ? 'Disable' : 'Re-enable'} ${String(r['login'])}`);
    if (!reason) return;
    const approvalId = !disabled ? window.prompt('Approval id (privileged roles only; leave empty to request one)') ?? '' : '';
    try {
      const out = await api.post<{ status: string; approvalId?: string }>(`/admin/staff/${String(r['staffId'])}/disabled`, {
        disabled,
        reason,
        ...(approvalId.trim() ? { approvalId: approvalId.trim() } : {}),
      });
      setMsg(out.status === 'PENDING_APPROVAL' ? `Approval ${out.approvalId} requested.` : 'Done.');
      reload();
    } catch (err) {
      setMsg(explain(err));
    }
  }

  async function doAssign(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post('/admin/assignments', { staffPersonId: assign.staffPersonId.trim(), walletId: assign.walletId.trim() });
      setMsg('Assigned.');
      reload();
    } catch (err) {
      setMsg(explain(err));
    }
  }

  return (
    <Shell title="Staff & roles">
      {error && <p className="error">{error}</p>}
      {msg && <p className="card" role="status">{msg}</p>}
      {secret && (
        <div className="card">
          <p><strong>Shown once.</strong> Give these to {secret.login} privately; they set up their authenticator app with the secret.</p>
          <p>Initial password</p>
          <p className="secret">{secret.initialPassword}</p>
          <p>Authenticator secret</p>
          <p className="secret">{secret.totpSecret}</p>
          <p className="secret small">{secret.otpauth}</p>
          <button className="secondary small" onClick={() => setSecret(null)}>I have handed these over</button>
        </div>
      )}
      <h2>Access review</h2>
      <button className="secondary small" onClick={() => void api.text('/admin/staff?format=csv').then((t) => download('access-review.csv', t)).catch((e: unknown) => setMsg(explain(e)))}>
        Export CSV
      </button>
      {data && (
        <Table
          rows={data}
          columns={['login', 'role', 'disabled', 'lastLoginAt', 'activeAssignments', 'personId']}
          actions={(r) => <button className="small secondary" onClick={() => void toggle(r)}>{r['disabled'] ? 'Re-enable' : 'Disable'}</button>}
        />
      )}
      <h2>Enrol staff</h2>
      <form className="card" onSubmit={(e) => void enrol(e)}>
        <div className="row">
          <div><label>Login</label><input value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required /></div>
          <div><label>Role</label><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></div>
          <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>Approval id (privileged)</label><input value={form.approvalId} onChange={(e) => setForm({ ...form, approvalId: e.target.value })} /></div>
        </div>
        <button type="submit">Enrol</button>
      </form>
      <h2>Assign to a case</h2>
      <form className="card" onSubmit={(e) => void doAssign(e)}>
        <div className="row">
          <div><label>Staff person id</label><input value={assign.staffPersonId} onChange={(e) => setAssign({ ...assign, staffPersonId: e.target.value })} required /></div>
          <div><label>Wallet id</label><input value={assign.walletId} onChange={(e) => setAssign({ ...assign, walletId: e.target.value })} required /></div>
        </div>
        <button type="submit">Assign</button>
      </form>
    </Shell>
  );
}
