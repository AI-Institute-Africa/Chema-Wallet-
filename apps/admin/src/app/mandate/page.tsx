'use client';
// Mandate-change verification queue. The API has no list of changes awaiting a
// verifier, so this shows the pending mandate approvals (oversight roles can
// read the approvals queue) and lets anyone open a change by its id.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { isUuid, mandateApprovals } from '../../lib/portal';
import { Shell, Table, useLoad } from '../../lib/ui';

export default function MandateQueue() {
  const router = useRouter();
  const { data, error } = useLoad<unknown>('/admin/queues/approvals');
  const [id, setId] = useState('');
  return (
    <Shell title="Mandate changes">
      <p className="muted small">
        A change to who manages a wallet needs a family checker AND an assigned community verifier who is not a party. The requester then executes it.
      </p>
      <div className="card">
        <label htmlFor="change">Open a change by id</label>
        <div className="row">
          <input id="change" value={id} onChange={(e) => setId(e.target.value)} placeholder="mandate change id (uuid)" />
        </div>
        <button disabled={!isUuid(id)} onClick={() => router.push(`/mandate/${id.trim()}`)}>
          Open
        </button>
      </div>
      <h2>Awaiting the family checker</h2>
      {error && <p className="muted small">Approvals queue not available to your role ({error}). Open a change by id instead.</p>}
      {data !== null && (
        <Table
          rows={mandateApprovals(data)}
          columns={['action', 'walletId', 'makerRole', 'createdAt', 'escalatedTo']}
          actions={(r) => <Link href={`/mandate/${String(r['subjectId'])}`}>Open</Link>}
        />
      )}
    </Shell>
  );
}
