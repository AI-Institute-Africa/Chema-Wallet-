'use client';
// Family "one wallet" view: every source on its own line, the Fidelity
// benefit in its own section. Verified badge ≠ policy cover ≠ claim approval.
import { t } from '@chema/shared/i18n';
import { useParams } from 'next/navigation';
import { benefitMessage, labelFor, splitFunds, type FundsLine } from '../../../../lib/family';
import { FamilyNav, Page, Status, useLoad } from '../../../../lib/family-ui';
import { formatMoney } from '../../../../lib/public';
import { family } from '../../../../lib/session';

function Line({ l }: { l: FundsLine }) {
  return (
    <div className="card" data-source={l.source}>
      <strong>{labelFor(l.labelKey, l.source)}</strong>
      <ul className="plain">
        <li>{t('fam.funds.available', { amount: formatMoney(l.available) })}</li>
        <li>{t('fam.funds.received', { amount: formatMoney(l.settled) })}</li>
        <li>{t('fam.funds.pending', { amount: formatMoney(l.pending) })}</li>
        <li>{t('fam.funds.held', { amount: formatMoney(l.held) })}</li>
        <li>{t('fam.funds.paid', { amount: formatMoney(l.paid) })}</li>
      </ul>
    </div>
  );
}

export default function Funds() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useLoad(() => family.funds(id), [id]);
  const split = data ? splitFunds(data.lines) : null;
  return (
    <Page title={t('fam.funds.title')} walletId={id} intro={t('fam.funds.intro')}>
      <Status error={error} />
      {!data && !error && <p className="muted">{t('fam.loading')}</p>}
      {data && split && (
        <>
          <section aria-labelledby="community">
            <h2 id="community">{t('fam.funds.community_heading')}</h2>
            {split.community.length === 0 && <p className="muted">{t('fam.funds.no_lines')}</p>}
            {split.community.map((l) => (
              <Line key={`${l.source}:${l.groupId ?? ''}:${l.available.ccy}`} l={l} />
            ))}
          </section>
          <section aria-labelledby="benefit" id="benefit-section">
            <h2 id="benefit">{t('fam.funds.benefit_heading')}</h2>
            <p className="muted">{t('fam.funds.benefit_note')}</p>
            <p>{benefitMessage(data.benefit.status)}</p>
            {data.benefit.statusUpdating && <p className="muted">{t('funds.benefit.status_updating')}</p>}
            {split.benefit.map((l) => (
              <Line key={`${l.source}:${l.available.ccy}`} l={l} />
            ))}
          </section>
        </>
      )}
      <FamilyNav walletId={id} />
    </Page>
  );
}
