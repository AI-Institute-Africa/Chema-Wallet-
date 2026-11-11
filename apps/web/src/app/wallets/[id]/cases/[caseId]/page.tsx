'use client';
// One concern: type, status, outcome. No staff notes or internal ids shown.
import { t } from '@chema/shared/i18n';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { msgFor, shortDate } from '../../../../../lib/family';
import { Page, Status, useLoad } from '../../../../../lib/family-ui';
import { family } from '../../../../../lib/session';

export default function CaseDetail() {
  const { id, caseId } = useParams<{ id: string; caseId: string }>();
  const { data: c, error } = useLoad(() => family.caseView(caseId), [caseId]);
  const paused = c ? c.holds.filter((h) => !h.released).length : 0;
  return (
    <Page title={t('fam.case.title')} walletId={id}>
      <Status error={error} />
      {!c && !error && <p className="muted">{t('fam.loading')}</p>}
      {c && (
        <div className="card">
          <strong>{msgFor('fam.case.type', c.type, 'fam.case.type.payment_dispute')}</strong>
          <p>{msgFor('fam.case.status', c.status, 'fam.case.status.open')}</p>
          <p className="muted">{c.summary}</p>
          <p className="small">{t('fam.case.opened_at', { date: shortDate(c.openedAt) })}</p>
          {c.closedAt && <p className="small">{t('fam.case.closed_at', { date: shortDate(c.closedAt) })}</p>}
          {c.outcome && <p>{t('fam.case.outcome', { outcome: msgFor('fam.case.outcome', c.outcome, 'fam.case.outcome.other') })}</p>}
          {paused > 0 && <p>{t('fam.case.holds', { count: String(paused) })}</p>}
        </div>
      )}
      <p>
        <Link href={`/wallets/${id}/cases`}>{t('fam.nav.cases')}</Link>
      </p>
    </Page>
  );
}
