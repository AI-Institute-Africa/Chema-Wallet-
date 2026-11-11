'use client';
import Link from 'next/link';
import type { Me } from '../lib/api';
import { SECTION_LABELS, Shell, useLoad } from '../lib/ui';

export default function Home() {
  const { data: me } = useLoad<Me>('/admin/me');
  return (
    <Shell title="Work queues">
      <p className="muted">
        High-risk actions (ledger adjustments, hold releases, overrides, financial flags, privileged access) need a second person:
        the maker requests, a different checker approves, then the maker executes.
      </p>
      <div className="grid">
        {(me?.sections ?? []).map((s) => SECTION_LABELS[s] && (
          <Link key={s} href={SECTION_LABELS[s].href} className="card">{SECTION_LABELS[s].label}</Link>
        ))}
      </div>
    </Shell>
  );
}
