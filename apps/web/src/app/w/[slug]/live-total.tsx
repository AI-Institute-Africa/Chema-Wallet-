'use client';
// Live total by short polling (docs/06): every 15 s, from the ledger. No
// countdown, no "only X left", no pressure copy. The owner view passes a
// target editor that replaces the static target line.
import { t } from '@chema/shared/i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { moneyShort, toGo } from '../../../lib/memorial';
import { API_BASE, createPublicClient, progressPercent, type MoneyJSON } from '../../../lib/public';

const client = createPublicClient({ baseUrl: API_BASE });

export default function LiveTotal({
  slug,
  initial,
  targetEditor,
  poll = true,
}: {
  slug: string;
  initial: { raised: MoneyJSON; target: MoneyJSON | null };
  targetEditor?: ReactNode;
  poll?: boolean;
}) {
  const [totals, setTotals] = useState(initial);
  useEffect(() => setTotals(initial), [initial]);
  useEffect(() => {
    if (!poll) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      client.total(slug).then(setTotals).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(id);
  }, [slug, poll]);
  const pct = totals.target ? progressPercent(totals.raised, totals.target) : null;
  const left = totals.target ? toGo(totals.raised, totals.target) : null;
  return (
    <div className="progress-box" aria-live="polite" data-testid="progress">
      <div className="m-row">
        <div className="collected">
          {moneyShort(totals.raised)}
          <small>
            {totals.raised.ccy} {t('memorial.collected')}
          </small>
        </div>
        <div className="target">
          {targetEditor ??
            (totals.target && (
              <span>
                {t('memorial.target', { amount: '' })}
                <b>
                  {moneyShort(totals.target)} {totals.target.ccy}
                </b>
              </span>
            ))}
        </div>
      </div>
      {pct !== null && (
        <>
          <div className="track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="bar" style={{ width: `${pct}%` }} />
          </div>
          <div className="pstats">
            <span>
              <b>{t('memorial.funded', { pct: String(pct) })}</b>
            </span>
            <span>
              <b>{left ? t('memorial.to_go', { amount: moneyShort(left) }) : t('memorial.target_reached')}</b>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
