'use client';
// Contribute in ~30 s, no account (docs/06), in the memorial page's right column.
// Amount chips are a product decision (2026-11-11, overrides docs/06 "no
// suggested amounts"); every amount is still honoured. A disclosure step comes
// BEFORE the provider is involved. Payment happens on the handset (EcoCash,
// OneMoney prompt) or on the card provider's page: we never ask for a PIN or
// card details. One idempotency key per form: a double tap is one contribution.
import { t } from '@chema/shared/i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, majorToMinor } from '../../../lib/api';
import { minorToInput, moneyShort, orderRails, quickAmounts, railName } from '../../../lib/memorial';
import { API_BASE, createPublicClient, formatMoney, type ContributeForm as FormBody, type Disclosure, type PublicPage } from '../../../lib/public';
import { getToken } from '../../../lib/session';

const client = createPublicClient({ baseUrl: API_BASE, token: getToken });

const ERRORS: Record<string, string> = {
  amount_below_minimum: 'That amount is below the smallest amount this page accepts.',
  amount_above_maximum: 'That amount is above the largest single contribution allowed. You can split it.',
  full_kyc_required: 'This amount needs extra identity checks that are not available online yet.',
  contribution_limits_not_configured: 'Contributions are not open yet.',
  invalid_request: 'Please check the details you entered.',
};

export default function ContributeForm({ page, disabled = false }: { page: PublicPage; disabled?: boolean }) {
  const router = useRouter();
  const { currency, min, max } = page.contribute;
  const rails = useMemo(() => orderRails(page.contribute.rails), [page.contribute.rails]);
  const chips = useMemo(() => quickAmounts(currency, min, max), [currency, min, max]);
  const [amount, setAmount] = useState(chips[2] !== undefined ? minorToInput(chips[2]) : '');
  const [rail, setRail] = useState(rails[0] ?? '');
  const [payerName, setPayerName] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [tribute, setTribute] = useState('');
  const [contact, setContact] = useState('');
  const [quote, setQuote] = useState<Disclosure | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useMemo(() => `web-${crypto.randomUUID()}`, []);
  // The rail list can change under a mounted form (owner view data arriving): keep a valid choice.
  useEffect(() => {
    if (!rails.includes(rail)) setRail(rails[0] ?? '');
  }, [rails, rail]);

  let minor: bigint | null = null;
  try {
    minor = amount.trim() ? majorToMinor(amount) : null;
  } catch {
    minor = null;
  }
  const shown = minor !== null && minor > 0n ? moneyShort({ minor: minor.toString(), ccy: currency }) : `${currency} 0`;

  function body(): FormBody | null {
    if (minor === null || minor <= 0n) {
      setError('Enter an amount like 10 or 10.50.');
      return null;
    }
    if (!payerName.trim() || !payerPhone.trim()) {
      setError('Please give your name and phone number.');
      return null;
    }
    const c = contact.trim();
    return {
      rail,
      amount: { minor: minor.toString(), ccy: currency },
      payerName: payerName.trim(),
      payerPhone: payerPhone.trim(),
      anonymous,
      ...(anonymous ? {} : { displayName: payerName.trim().slice(0, 60) }),
      ...(tribute.trim() ? { tribute: tribute.trim() } : {}),
      ...(c ? { contact: { kind: c.includes('@') ? ('EMAIL' as const) : ('PHONE' as const), value: c } } : {}),
    };
  }

  async function review() {
    setError(null);
    const f = body();
    if (!f) return;
    setBusy(true);
    try {
      setQuote(await client.quote(page.slug, f.rail, f.amount));
    } catch (e) {
      setError(e instanceof ApiError ? (ERRORS[e.code] ?? t('error.internal')) : t('error.internal'));
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    const f = body();
    if (!f) return;
    setBusy(true);
    setError(null);
    setStatus(rail === 'CARD' ? t('memorial.form.redirecting') : t('memorial.form.waiting', { rail: railName(rail) }));
    try {
      const r = await client.contribute(page.slug, f, idempotencyKey);
      const next = `/c/${r.contributionId}#t=${r.accessToken}`;
      if (r.payment.next?.type === 'REDIRECT') {
        window.sessionStorage.setItem('chema.after_checkout', next);
        window.location.assign(r.payment.next.url);
        return;
      }
      router.push(next);
    } catch (e) {
      setError(e instanceof ApiError ? (ERRORS[e.code] ?? t('error.internal')) : t('error.internal'));
      setStatus('');
      setBusy(false);
    }
  }

  return (
    <form
      className="m-card panel contrib"
      id="give"
      data-testid="contribute-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        void (quote ? pay() : review());
      }}
    >
      <h3>{t('memorial.form.title')}</h3>
      {disabled && <p className="hint" style={{ margin: '0 0 16px' }}>{t('memorial.form.preview')}</p>}
      <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {!quote ? (
          <>
            <div className="field">
              <span className="lbl">{t('memorial.form.currency')}</span>
              <span className="cur-fixed">{currency === 'USD' ? 'USD ($)' : 'ZiG / ZWG'}</span>
            </div>

            <div className="field">
              <label className="lbl" htmlFor="amt">
                {t('memorial.form.amount', { ccy: currency })}
              </label>
              {chips.length > 0 && (
                <div className="quick" role="group" aria-label={t('contribute.amount')}>
                  {chips.map((v) => (
                    <button key={v.toString()} type="button" className={minor === v ? 'on' : ''} onClick={() => setAmount(minorToInput(v))}>
                      {moneyShort({ minor: v.toString(), ccy: currency })}
                    </button>
                  ))}
                  <button type="button" onClick={() => setAmount('')}>
                    {t('memorial.form.other')}
                  </button>
                </div>
              )}
              <input className="amount" id="amt" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <p className="hint">{t('contribute.any_amount')}</p>
            </div>

            <div className="field" hidden={rails.length === 0}>
              <span className="lbl" id="payLbl">
                {t('memorial.form.method')}
              </span>
              <div className="pay" role="radiogroup" aria-labelledby="payLbl">
                {rails.map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={rail === r} className={rail === r ? 'on' : ''} onClick={() => setRail(r)}>
                    {railName(r).toUpperCase()}
                  </button>
                ))}
              </div>
              {rail === 'CARD' && <p className="hint">{t('memorial.form.card_note')}</p>}
            </div>

            <div className="field">
              <label className="lbl" htmlFor="phone">
                {rail === 'CARD' ? t('contribute.phone') : t('memorial.form.mobile')}
              </label>
              <input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="e.g. 077 123 4567" value={payerPhone} onChange={(e) => setPayerPhone(e.target.value)} />
            </div>

            <div className="field">
              <label className="lbl" htmlFor="nm">
                {t('contribute.name')}
              </label>
              <input id="nm" autoComplete="name" placeholder="e.g. Tendai Chikore" value={payerName} onChange={(e) => setPayerName(e.target.value)} />
              <p className="hint">{t('contribute.kyc_note')}</p>
            </div>

            <label className="check">
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> {t('contribute.anonymous')}
            </label>

            <div className="field">
              <label className="lbl" htmlFor="msg">
                {t('contribute.tribute')}
              </label>
              <textarea id="msg" rows={3} maxLength={500} placeholder="Leave a message for the family…" value={tribute} onChange={(e) => setTribute(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="contact">
                {t('contribute.contact')}
              </label>
              <input id="contact" placeholder="phone or email" value={contact} onChange={(e) => setContact(e.target.value)} />
            </div>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button className={`submit${busy ? ' busy' : ''}`} type="submit">
              {t('memorial.form.submit', { amount: shown })}
            </button>
          </>
        ) : (
          <div className="disclosure" data-testid="disclosure">
            <p className="big">{t('memorial.form.review')}</p>
            <p>{t('disclosure.total', { amount: formatMoney(quote.totalCharged) })}</p>
            {quote.feePayer && (
              <p>
                {t('disclosure.fee', {
                  amount: formatMoney(quote.providerFee),
                  payer: t(quote.feePayer === 'CONTRIBUTOR' ? 'disclosure.fee_payer.contributor' : 'disclosure.fee_payer.wallet'),
                })}
              </p>
            )}
            {quote.fxRate && <p>{t('disclosure.fx', { rate: quote.fxRate })}</p>}
            <p>{t('disclosure.credit', { amount: formatMoney(quote.expectedCredit) })}</p>
            <p className="hint">{t('contribute.no_pin')}</p>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button className={`submit${busy ? ' busy' : ''}`} type="submit">
              {t('memorial.form.pay', { amount: moneyShort(quote.totalCharged) })}
            </button>
            <button type="button" className="secondary" onClick={() => setQuote(null)}>
              {t('memorial.form.back')}
            </button>
          </div>
        )}
      </fieldset>
      <p className="status" aria-live="polite">
        {status}
      </p>
      {rail && (
        <p className="trust">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span>{t('memorial.form.trust', { rail: railName(rail) })}</span>
        </p>
      )}
    </form>
  );
}
