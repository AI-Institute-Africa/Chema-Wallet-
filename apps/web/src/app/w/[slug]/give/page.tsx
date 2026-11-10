'use client';
// Contribute in ~30 s, no account (docs/06): amount (no suggested amounts),
// name or "Sympathetic Friend", optional message and receipt contact, then a
// disclosure step BEFORE the provider is involved. Payment happens on the
// handset or in provider checkout: we never ask for a PIN or card details.
import { t } from '@chema/shared/i18n';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, majorToMinor } from '../../../../lib/api';
import { API_BASE, createPublicClient, formatMoney, type ContributeForm, type Disclosure, type PublicPage } from '../../../../lib/public';
import { getToken } from '../../../../lib/session';

const client = createPublicClient({ baseUrl: API_BASE, token: getToken });

const RAIL_NAMES: Record<string, string> = { ECOCASH: 'EcoCash', ONEMONEY: 'OneMoney', CARD: 'Card' };

const ERRORS: Record<string, string> = {
  amount_below_minimum: 'That amount is below the smallest amount this page accepts.',
  amount_above_maximum: 'That amount is above the largest single contribution allowed. You can split it.',
  full_kyc_required: 'This amount needs extra identity checks that are not available online yet.',
  contribution_limits_not_configured: 'Contributions are not open yet.',
  invalid_request: 'Please check the details you entered.',
};

export default function Give() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const [page, setPage] = useState<PublicPage | null>(null);
  const [amount, setAmount] = useState('');
  const [rail, setRail] = useState('');
  const [payerName, setPayerName] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [tribute, setTribute] = useState('');
  const [contact, setContact] = useState('');
  const [quote, setQuote] = useState<Disclosure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per form: a double tap or a retry is the same contribution.
  const idempotencyKey = useMemo(() => `web-${crypto.randomUUID()}`, []);

  useEffect(() => {
    client
      .page(slug)
      .then((p) => {
        setPage(p);
        setRail(p.contribute.rails[0] ?? '');
      })
      .catch(() => setError(t('error.not_available')));
  }, [slug]);

  function form(): ContributeForm | null {
    if (!page) return null;
    let minor: bigint;
    try {
      minor = majorToMinor(amount);
    } catch {
      setError('Enter an amount like 10 or 10.50.');
      return null;
    }
    const c = contact.trim();
    return {
      rail,
      amount: { minor: minor.toString(), ccy: page.contribute.currency },
      payerName: payerName.trim(),
      payerPhone: payerPhone.trim(),
      anonymous,
      ...(anonymous ? {} : { displayName: (displayName.trim() || payerName.trim()).slice(0, 60) }),
      ...(tribute.trim() ? { tribute: tribute.trim() } : {}),
      ...(c ? { contact: { kind: c.includes('@') ? ('EMAIL' as const) : ('PHONE' as const), value: c } } : {}),
    };
  }

  async function review() {
    setError(null);
    const f = form();
    if (!f) return;
    try {
      setQuote(await client.quote(slug, f.rail, f.amount));
    } catch (e) {
      setError(e instanceof ApiError ? (ERRORS[e.code] ?? t('error.internal')) : t('error.internal'));
    }
  }

  async function pay() {
    const f = form();
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.contribute(slug, f, idempotencyKey);
      const status = `/c/${r.contributionId}#t=${r.accessToken}`;
      // Card: provider checkout. Mobile money: the prompt is on the payer's phone.
      if (r.payment.next?.type === 'REDIRECT') {
        window.sessionStorage.setItem('chema.after_checkout', status);
        window.location.assign(r.payment.next.url);
        return;
      }
      router.push(status);
    } catch (e) {
      setError(e instanceof ApiError ? (ERRORS[e.code] ?? t('error.internal')) : t('error.internal'));
      setBusy(false);
    }
  }

  if (error && !page) return <main><p className="error">{error}</p></main>;
  if (!page) return <main><p className="muted">Loading…</p></main>;

  return (
    <main className="public">
      <h1>{page.deceasedName}</h1>
      {!quote ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void review();
          }}
        >
          <label htmlFor="amount">
            {t('contribute.amount')} ({page.contribute.currency})
          </label>
          <input id="amount" inputMode="decimal" autoComplete="off" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <p className="muted small">{t('contribute.any_amount')}</p>

          <label htmlFor="rail">{t('contribute.pay_with')}</label>
          <select id="rail" value={rail} onChange={(e) => setRail(e.target.value)}>
            {page.contribute.rails.map((r) => (
              <option key={r} value={r}>
                {RAIL_NAMES[r] ?? r}
              </option>
            ))}
          </select>

          <label htmlFor="name">{t('contribute.name')}</label>
          <input id="name" autoComplete="name" required value={payerName} onChange={(e) => setPayerName(e.target.value)} />
          <label htmlFor="phone">{t('contribute.phone')}</label>
          <input id="phone" type="tel" autoComplete="tel" placeholder="+263771234567" required value={payerPhone} onChange={(e) => setPayerPhone(e.target.value)} />
          <p className="muted small">{t('contribute.kyc_note')}</p>

          <label className="check">
            <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> {t('contribute.anonymous')}
          </label>
          {!anonymous && (
            <>
              <label htmlFor="display">{t('contribute.display_name')}</label>
              <input id="display" maxLength={60} placeholder={payerName} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </>
          )}

          <label htmlFor="tribute">{t('contribute.tribute')}</label>
          <textarea id="tribute" rows={3} maxLength={500} value={tribute} onChange={(e) => setTribute(e.target.value)} />
          <label htmlFor="contact">{t('contribute.contact')}</label>
          <input id="contact" placeholder="phone or email" value={contact} onChange={(e) => setContact(e.target.value)} />

          {error && <p className="error">{error}</p>}
          <button type="submit" className="big">
            Continue
          </button>
        </form>
      ) : (
        <div className="card">
          <p className="big">{t('disclosure.total', { amount: formatMoney(quote.totalCharged) })}</p>
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
          <p className="muted small">{t('contribute.no_pin')}</p>
          {error && <p className="error">{error}</p>}
          <button className="big" disabled={busy} onClick={() => void pay()}>
            {t('page.contribute')}
          </button>{' '}
          <button className="secondary" disabled={busy} onClick={() => setQuote(null)}>
            Back
          </button>
        </div>
      )}
    </main>
  );
}
