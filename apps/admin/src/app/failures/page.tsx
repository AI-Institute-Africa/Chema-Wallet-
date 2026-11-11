'use client';
// Delivery & integration failures, one section per kind: FAILED/IGNORED
// WhatsApp inbound, DEAD notifications, DEAD Fidelity requests, payouts stuck
// at the rail (→ override). Open WhatsApp escalations are in Support hand-offs.
import Link from 'next/link';
import { fmtMoney } from '../../lib/api';
import { failureGroups } from '../../lib/portal';
import { Shell, Table, useLoad } from '../../lib/ui';

export default function Failures() {
  const { data, error, reload } = useLoad<unknown>('/admin/queues/failures');
  return (
    <Shell title="Delivery & integration failures">
      <p className="muted small">
        Open WhatsApp escalations (people waiting for a person) are in <Link href="/q/support">Support hand-offs</Link>.
      </p>
      {error && <p className="error">{error}</p>}
      <button className="secondary small" onClick={reload}>
        Refresh
      </button>
      {data !== null &&
        failureGroups(data).map((g) => (
          <section key={g.kind} aria-labelledby={`f-${g.kind}`}>
            <h2 id={`f-${g.kind}`}>
              {g.title} ({g.rows.length})
            </h2>
            {g.help && <p className="muted small">{g.help}</p>}
            <Table
              rows={g.kind === 'payouts' ? g.rows.map((r) => ({ ...r, amountMinor: fmtMoney(r['amountMinor'] as string | null, r['currency'] as string | null) })) : g.rows}
              {...(g.kind === 'payouts'
                ? {
                    actions: (r: Record<string, unknown>) => <Link href={`/payouts/${String(r['id'])}`}>{r['status'] === 'RAIL_DOWN' || r['status'] === 'OVERRIDE_PENDING' ? 'Override' : 'Open'}</Link>,
                  }
                : {})}
            />
          </section>
        ))}
    </Shell>
  );
}
