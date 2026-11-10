'use client';
// Live total by short polling (docs/06): every 15 s, from the ledger. No
// countdown, no "only X left", no pressure copy.
import { t } from '@chema/shared/i18n';
import { useEffect, useState } from 'react';
import { API_BASE, createPublicClient, formatMoney, progressPercent, type MoneyJSON } from '../../../lib/public';

const client = createPublicClient({ baseUrl: API_BASE });

export default function LiveTotal({ slug, initial }: { slug: string; initial: { raised: MoneyJSON; target: MoneyJSON | null } }) {
  const [totals, setTotals] = useState(initial);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      client.total(slug).then(setTotals).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(id);
  }, [slug]);
  return (
    <div className="card" aria-live="polite">
      <p className="big">{t('page.raised', { amount: formatMoney(totals.raised) })}</p>
      {totals.target && (
        <>
          <progress max={100} value={progressPercent(totals.raised, totals.target)} />
          <p className="muted">{t('page.target', { amount: formatMoney(totals.target) })}</p>
        </>
      )}
    </div>
  );
}
