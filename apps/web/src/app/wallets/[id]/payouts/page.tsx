'use client';
// Payouts: request (step-up + the family's approvals), list, status, cancel
// while unsubmitted. The server checks balance, source rules, holds, cases
// and approvals; this page only shows what it says.
import { t } from '@chema/shared/i18n';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  cancellable,
  explainError,
  newIdempotencyKey,
  PAYOUT_PURPOSES,
  payoutBody,
  payoutStatusLabel,
  purposeLabel,
  sourceKey,
  type Purpose,
  type Source,
} from '../../../../lib/family';
import { FamilyNav, Page, Status, StepUp, useLoad } from '../../../../lib/family-ui';
import { formatMoney } from '../../../../lib/public';
import { api, family } from '../../../../lib/session';

const SOURCES: Source[] = ['COMMUNITY', 'FIDELITY_BENEFIT'];

export default function Payouts() {
  const { id } = useParams<{ id: string }>();
  const wallet = useLoad(() => api.wallet(id), [id]);
  const payees = useLoad(() => family.payees(id), [id]);
  const list = useLoad(() => family.payouts(id), [id]);
  const [source, setSource] = useState<Source>('COMMUNITY');
  const [payeeId, setPayeeId] = useState('');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState<Purpose>('PARLOUR');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [idem, setIdem] = useState(newIdempotencyKey);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const active = (payees.data ?? []).filter((p) => p.status === 'ACTIVE');
  const payeeName = (pid: string) => payees.data?.find((p) => p.id === pid)?.label ?? '—';
  const currency = wallet.data?.currency ?? 'USD';

  function prepare() {
    setError(null);
    try {
      payoutBody({ source, currency, payeeId, amount, purpose, note, idempotencyKey: idem });
      setConfirming(true);
    } catch {
      setError(t('fam.error.amount'));
    }
  }

  async function request(stepUpToken: string) {
    setConfirming(false);
    setError(null);
    try {
      const r = await family.requestPayout(id, payoutBody({ source, currency, payeeId, amount, purpose, note, idempotencyKey: idem }), stepUpToken);
      setMessage(t('fam.payouts.requested', { status: payoutStatusLabel(r.payouts[0]?.status ?? 'AWAITING_APPROVAL') }));
      setAmount('');
      setNote('');
      setIdem(newIdempotencyKey());
      list.reload();
    } catch (e) {
      setError(explainError(e));
    }
  }

  async function cancel(payoutId: string) {
    setError(null);
    try {
      await family.cancelPayout(payoutId, reason.trim());
      setCancelFor(null);
      setReason('');
      setMessage(t('fam.payouts.cancelled'));
      list.reload();
    } catch (e) {
      setError(explainError(e));
    }
  }

  return (
    <Page title={t('fam.payouts.title')} walletId={id} intro={t('fam.payouts.intro')}>
      <Status error={error ?? list.error ?? payees.error} message={message} />
      <ul className="plain" aria-label={t('fam.payouts.title')}>
        {list.data?.map((p) => (
          <li key={p.id}>
            {t('fam.payouts.item', {
              amount: formatMoney(p.amount),
              payee: p.payeeLabel ? `${p.payeeLabel}${p.payeeMasked ? ` (${p.payeeMasked})` : ''}` : payeeName(p.payeeId),
              purpose: purposeLabel(p.purpose),
            })}
            {p.purposeNote && (
              <>
                <br />
                <span className="small">{t('fam.payouts.note_shown', { note: p.purposeNote })}</span>
              </>
            )}
            <br />
            <span className="muted small">
              {t(sourceKey(p.source))} · {payoutStatusLabel(p.status)}
              {p.blockedBy ? ` · ${t('fam.payouts.waiting')}` : ''}
            </span>
            {cancellable(p.status) && cancelFor !== p.id && (
              <div>
                <button className="secondary" onClick={() => setCancelFor(p.id)}>
                  {t('fam.payouts.cancel')}
                </button>
              </div>
            )}
            {cancelFor === p.id && (
              <div>
                <label htmlFor={`reason-${p.id}`}>{t('fam.payouts.cancel_reason')}</label>
                <input id={`reason-${p.id}`} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
                <button onClick={() => void cancel(p.id)} disabled={reason.trim().length < 3}>
                  {t('fam.payouts.cancel')}
                </button>{' '}
                <button className="secondary" onClick={() => setCancelFor(null)}>
                  {t('stepup.cancel')}
                </button>
              </div>
            )}
          </li>
        ))}
        {list.data?.length === 0 && <li className="muted">{t('fam.none')}</li>}
      </ul>

      <div className="card">
        <h2>{t('fam.payouts.request_heading')}</h2>
        {payees.data && active.length === 0 ? (
          <p className="muted">{t('fam.payouts.no_payees')}</p>
        ) : (
          <>
            <label htmlFor="source">{t('fam.payouts.source')}</label>
            <select id="source" value={source} onChange={(e) => setSource(e.target.value as Source)}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(sourceKey(s))}
                </option>
              ))}
            </select>
            <label htmlFor="payee">{t('fam.payouts.payee')}</label>
            <select id="payee" value={payeeId} onChange={(e) => setPayeeId(e.target.value)}>
              <option value="">—</option>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.destination})
                </option>
              ))}
            </select>
            <label htmlFor="amount">{t('fam.payouts.amount', { ccy: currency })}</label>
            <input id="amount" inputMode="decimal" maxLength={16} value={amount} onChange={(e) => setAmount(e.target.value)} />
            <label htmlFor="purpose">{t('fam.payouts.purpose')}</label>
            <select id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
              {PAYOUT_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {purposeLabel(p)}
                </option>
              ))}
            </select>
            <label htmlFor="note">{t('fam.payouts.note')}</label>
            <input id="note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            {!confirming && (
              <button onClick={prepare} disabled={!payeeId || !amount.trim()}>
                {t('fam.payouts.request')}
              </button>
            )}
          </>
        )}
      </div>
      {confirming && (
        <StepUp target={{ action: 'payout.request', subjectType: 'wallet', subjectId: id }} onToken={(tok) => void request(tok)} onCancel={() => setConfirming(false)} />
      )}
      <FamilyNav walletId={id} />
    </Page>
  );
}
