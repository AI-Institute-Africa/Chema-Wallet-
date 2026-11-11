'use client';
// People to pay. Adding one is a step-up action (one-time code) and needs a
// second family approver before any payout can go to them (server-enforced).
import { t } from '@chema/shared/i18n';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { explainError, msgFor, type Payee } from '../../../../lib/family';
import { FamilyNav, Page, Status, StepUp, useLoad } from '../../../../lib/family-ui';
import { family } from '../../../../lib/session';

const RAILS: Payee['rail'][] = ['ECOCASH', 'ONEMONEY'];

export default function Payees() {
  const { id } = useParams<{ id: string }>();
  const list = useLoad(() => family.payees(id), [id]);
  const [label, setLabel] = useState('');
  const [holder, setHolder] = useState('');
  const [rail, setRail] = useState<Payee['rail']>('ECOCASH');
  const [destination, setDestination] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const ready = label.trim() && holder.trim() && /^\+[1-9][0-9]{6,14}$/.test(destination.trim());

  async function add(stepUpToken: string) {
    setConfirming(false);
    setError(null);
    try {
      await family.addPayee(id, { label: label.trim(), holderName: holder.trim(), rail, destination: destination.trim() }, stepUpToken);
      setMessage(t('fam.payees.added'));
      setLabel('');
      setHolder('');
      setDestination('');
      list.reload();
    } catch (e) {
      setError(explainError(e));
    }
  }

  return (
    <Page title={t('fam.payees.title')} walletId={id} intro={t('fam.payees.intro')}>
      <Status error={error ?? list.error} message={message} />
      <ul className="plain" aria-label={t('fam.payees.title')}>
        {list.data?.map((p) => (
          <li key={p.id}>
            <strong>{p.label}</strong> — {p.holderName}, {msgFor('fam.rail', p.rail, 'fam.payees.rail')} {p.destination}
            <br />
            <span className="muted small">
              {msgFor('fam.payees.status', p.status, 'fam.payees.status.pending')}
              {p.verification ? ` · ${msgFor('fam.payees.check', p.verification, 'fam.payees.check.unavailable')}` : ''}
            </span>
          </li>
        ))}
        {list.data?.length === 0 && <li className="muted">{t('fam.none')}</li>}
      </ul>

      <div className="card">
        <h2>{t('fam.payees.add_heading')}</h2>
        <label htmlFor="label">{t('fam.payees.label')}</label>
        <input id="label" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        <label htmlFor="holder">{t('fam.payees.holder')}</label>
        <input id="holder" maxLength={120} autoComplete="name" value={holder} onChange={(e) => setHolder(e.target.value)} />
        <label htmlFor="rail">{t('fam.payees.rail')}</label>
        <select id="rail" value={rail} onChange={(e) => setRail(e.target.value as Payee['rail'])}>
          {RAILS.map((r) => (
            <option key={r} value={r}>
              {msgFor('fam.rail', r, 'fam.payees.rail')}
            </option>
          ))}
        </select>
        <label htmlFor="destination">{t('fam.payees.destination')}</label>
        <input id="destination" inputMode="tel" maxLength={16} value={destination} onChange={(e) => setDestination(e.target.value)} />
        {!confirming && (
          <button onClick={() => setConfirming(true)} disabled={!ready}>
            {t('fam.payees.add')}
          </button>
        )}
      </div>
      {confirming && (
        <StepUp
          target={{ action: 'wallet.change_payout_destination', subjectType: 'wallet', subjectId: id }}
          onToken={(tok) => void add(tok)}
          onCancel={() => setConfirming(false)}
        />
      )}
      <FamilyNav walletId={id} />
    </Page>
  );
}
