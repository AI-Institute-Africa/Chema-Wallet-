'use client';
// Closing the wallet: what still blocks it (server-evaluated), start, finalise,
// thank contributors once, and the family statement.
import { t } from '@chema/shared/i18n';
import { useParams } from 'next/navigation';
import { Fragment, useState } from 'react';
import {
  closureBlockerLabel,
  explainError,
  FAMILY_CLOSURE_REASONS,
  msgFor,
  purposeLabel,
  shortDate,
  sourceKey,
  type ClosureReason,
} from '../../../../lib/family';
import { FamilyNav, Page, Status, useLoad } from '../../../../lib/family-ui';
import { STATUS_COPY } from '../../../../lib/copy';
import { formatMoney } from '../../../../lib/public';
import { family } from '../../../../lib/session';
import type { WalletStatus } from '../../../../lib/api';

export default function Closure() {
  const { id } = useParams<{ id: string }>();
  const check = useLoad(() => family.closure(id), [id]);
  const statements = useLoad(() => family.statements(id), [id]);
  const [reason, setReason] = useState<ClosureReason>('FUNERAL_COMPLETED');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await fn());
      check.reload();
      statements.reload();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  const c = check.data;
  const status = c?.status as WalletStatus | undefined;
  // Shown while closing; an ACTIVE wallet's only "blocker" is that closing has not started.
  const blockers = c?.status === 'CLOSING' ? c.blockers : [];

  return (
    <Page title={t('fam.closure.title')} walletId={id} intro={t('fam.closure.intro')}>
      <Status error={error ?? check.error} message={message} />
      {c && (
        <div className="card">
          <p>{t('fam.closure.status', { status: status && STATUS_COPY[status] ? STATUS_COPY[status].title : c.status })}</p>
          {c.status === 'CLOSING' && blockers.length === 0 && <p className="ok">{t('fam.closure.ready')}</p>}
          {blockers.length > 0 && (
            <>
              <p>{t('fam.closure.blockers')}</p>
              <ul>
                {blockers.map((b) => (
                  <li key={b}>{closureBlockerLabel(b)}</li>
                ))}
              </ul>
            </>
          )}
          {c.residual.length > 0 && (
            <ul className="plain">
              {c.residual.map((r) => (
                <li key={`${r.source}:${r.currency}`}>{t('fam.closure.residual', { source: t(sourceKey(r.source)), amount: formatMoney(r.amount) })}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {c?.status === 'ACTIVE' && (
        <div className="card">
          <h2>{t('fam.closure.start_heading')}</h2>
          <label htmlFor="reason">{t('fam.closure.reason')}</label>
          <select id="reason" value={reason} onChange={(e) => setReason(e.target.value as ClosureReason)}>
            {FAMILY_CLOSURE_REASONS.map((r) => (
              <option key={r} value={r}>
                {msgFor('fam.closure.reason', r, 'fam.closure.reason.other')}
              </option>
            ))}
          </select>
          <label htmlFor="note">{t('fam.closure.note')}</label>
          <textarea id="note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            onClick={() => void run(async () => (await family.startClose(id, reason, note), t('fam.closure.started')))}
            disabled={busy || (reason === 'OTHER' && note.trim().length < 10)}
          >
            {t('fam.closure.start')}
          </button>
        </div>
      )}

      {c?.status === 'CLOSING' && (
        <button onClick={() => void run(async () => (await family.finalise(id), t('fam.closure.finalised')))} disabled={busy || blockers.length > 0}>
          {t('fam.closure.finalise')}
        </button>
      )}

      {(c?.status === 'CLOSING' || c?.status === 'CLOSED') && (
        <div className="card">
          <p className="muted">{t('fam.closure.thank_help')}</p>
          <button className="secondary" onClick={() => void run(async () => t('fam.closure.thanked', { count: String((await family.thank(id)).queued) }))} disabled={busy}>
            {t('fam.closure.thank')}
          </button>
        </div>
      )}

      {statements.data && statements.data.length > 0 && (
        <section aria-labelledby="statements">
          <h2 id="statements">{t('fam.closure.statements')}</h2>
          {statements.data.map((s) => (
            <div className="card receipt" key={s.contentHash}>
              <strong>{t('fam.closure.statement', { date: shortDate(s.generatedAt) })}</strong>
              <dl>
                {(s.content.sources ?? []).map((src) => (
                  <Fragment key={src.source}>
                    <dt>{t(sourceKey(src.source))}</dt>
                    <dd>
                      {t('fam.funds.received', { amount: formatMoney(src.settled) })} · {t('fam.funds.paid', { amount: formatMoney(src.paid) })}
                    </dd>
                  </Fragment>
                ))}
              </dl>
              <ul className="plain">
                {(s.content.payouts ?? []).map((p, i) => (
                  <li key={i}>{t('fam.closure.statement_payout', { amount: formatMoney(p.amount), payee: p.payee, purpose: purposeLabel(p.purpose) })}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      <FamilyNav walletId={id} />
    </Page>
  );
}
