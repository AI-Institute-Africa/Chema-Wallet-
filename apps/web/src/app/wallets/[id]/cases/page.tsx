'use client';
// Concerns and disputes for this wallet: raise one, see where each stands.
import { t } from '@chema/shared/i18n';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { explainError, msgFor, OPENABLE_CASE_TYPES, shortDate } from '../../../../lib/family';
import { FamilyNav, Page, Status, useLoad } from '../../../../lib/family-ui';
import { family } from '../../../../lib/session';

type Openable = (typeof OPENABLE_CASE_TYPES)[number];

export default function Cases() {
  const { id } = useParams<{ id: string }>();
  const list = useLoad(() => family.cases(id), [id]);
  const [type, setType] = useState<Openable>('PAYMENT_DISPUTE');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      await family.openCase(id, type, summary.trim());
      setSummary('');
      setMessage(t('fam.cases.opened'));
      list.reload();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title={t('fam.cases.title')} walletId={id} intro={t('fam.cases.intro')}>
      <Status error={error ?? list.error} message={message} />
      <ul className="plain" aria-label={t('fam.cases.title')}>
        {list.data?.map((c) => (
          <li key={c.id}>
            <strong>{msgFor('fam.case.type', c.type, 'fam.case.type.payment_dispute')}</strong> — {msgFor('fam.case.status', c.status, 'fam.case.status.open')}
            <br />
            <span className="muted small">{t('fam.case.opened_at', { date: shortDate(c.openedAt) })}</span>{' '}
            <Link href={`/wallets/${id}/cases/${c.id}`}>{t('fam.cases.view')}</Link>
          </li>
        ))}
        {list.data?.length === 0 && <li className="muted">{t('fam.none')}</li>}
      </ul>
      <div className="card">
        <h2>{t('fam.cases.open_heading')}</h2>
        <label htmlFor="type">{t('fam.cases.type')}</label>
        <select id="type" value={type} onChange={(e) => setType(e.target.value as Openable)}>
          {OPENABLE_CASE_TYPES.map((c) => (
            <option key={c} value={c}>
              {msgFor('fam.case.type', c, 'fam.case.type.payment_dispute')}
            </option>
          ))}
        </select>
        <label htmlFor="summary">{t('fam.cases.summary')}</label>
        <textarea id="summary" rows={4} maxLength={2000} value={summary} onChange={(e) => setSummary(e.target.value)} />
        <button onClick={() => void open()} disabled={busy || summary.trim().length < 10}>
          {t('fam.cases.open')}
        </button>
      </div>
      <FamilyNav walletId={id} />
    </Page>
  );
}
