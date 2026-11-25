'use client';
// Owner view: the last few money movements under the owner bar, with a link to
// the full family statement. Loads only for the family (the API refuses others).
import { t } from '@chema/shared/i18n';
import Link from 'next/link';
import { txTitle } from '../../../lib/family';
import { useLoad } from '../../../lib/family-ui';
import { moneyShort, relativeTime } from '../../../lib/memorial';
import { family } from '../../../lib/session';

export function RecentActivity({ walletId }: { walletId: string }) {
  const { data } = useLoad(() => family.transactions(walletId, undefined, 5), [walletId]);
  if (!data || (data.lines.length === 0 && data.pending.length === 0)) return null;
  return (
    <section className="tx-recent panel" aria-labelledby="tx-recent-title" data-testid="recent-activity">
      <h3 id="tx-recent-title">{t('fam.tx.recent')}</h3>
      <ul className="tx-rows">
        {data.lines.map((l) => (
          <li key={`${l.id}:${l.source}`} className="tx-row" data-direction={l.direction}>
            <div className="tx-main" style={{ cursor: 'default' }}>
              <span className={`tx-icon ${l.direction === 'IN' ? 'in' : 'out'}`} aria-hidden="true">
                {l.direction === 'IN' ? '↓' : '↑'}
              </span>
              <span className="tx-text">
                <span className="tx-title">{txTitle(l)}</span>
                <span className="tx-sub small muted">{relativeTime(l.at)}</span>
              </span>
              <span className="tx-amt">
                <span className={`tx-value ${l.direction === 'IN' ? 'in' : 'out'}`}>
                  {l.direction === 'IN' ? '+' : '−'}
                  {moneyShort(l.amount)}
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>
      <Link className="pill" href={`/wallets/${walletId}/transactions`}>
        {t('fam.tx.see_all')}
      </Link>
    </section>
  );
}
