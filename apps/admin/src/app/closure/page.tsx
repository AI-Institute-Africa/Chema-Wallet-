'use client';
// Closure checks: pick a wallet by id.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { isUuid } from '../../lib/portal';
import { Shell } from '../../lib/ui';

export default function ClosurePick() {
  const router = useRouter();
  const [id, setId] = useState('');
  return (
    <Shell title="Closure checks">
      <div className="card">
        <label htmlFor="wallet">Wallet id</label>
        <input id="wallet" value={id} onChange={(e) => setId(e.target.value)} placeholder="uuid" />
        <button disabled={!isUuid(id)} onClick={() => router.push(`/closure/${id.trim()}`)}>
          Check
        </button>
      </div>
    </Shell>
  );
}
