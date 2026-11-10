// Public funeral page (docs/06). Server-rendered, no JavaScript needed to read
// it, small payload. Privacy is applied by the API: fields the family hides
// never reach this server, let alone the browser.
import { t } from '@chema/shared/i18n';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError } from '../../../lib/api';
import { API_BASE, SERVER_API_BASE, createPublicClient, formatMoney, type PublicPage } from '../../../lib/public';
import LiveTotal from './live-total';

export const dynamic = 'force-dynamic';

const PURPOSE_KEYS = {
  PARLOUR: 'payout.purpose.parlour',
  TRANSPORT: 'payout.purpose.transport',
  FOOD: 'payout.purpose.food',
  CHURCH: 'payout.purpose.church',
  FAMILY_BENEFICIARY: 'payout.purpose.family_beneficiary',
  OTHER_APPROVED: 'payout.purpose.other_approved',
} as const;

function purposeLabel(purpose: string): string {
  const key = PURPOSE_KEYS[purpose as keyof typeof PURPOSE_KEYS];
  return key ? t(key) : t('payout.purpose.other_approved');
}

const client = createPublicClient({ baseUrl: SERVER_API_BASE });

async function load(slug: string): Promise<PublicPage> {
  try {
    return await client.page(slug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export default async function FuneralPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await load(slug);
  const open = p.contribute.rails.length > 0;
  return (
    <main className="public">
      {p.photoPath && <img className="photo" src={`${API_BASE}${p.photoPath}`} alt={p.deceasedName} width={320} />}
      <h1>{p.deceasedName}</h1>
      <p className="badge" title={p.badge.tooltip}>
        ✓ {p.badge.label}
      </p>
      <p className="muted small">{p.badge.tooltip}</p>
      <div className="card">
        <p>Passed away {p.dateOfDeath}</p>
        {p.funeralDate && <p>Funeral {p.funeralDate}</p>}
        <p>{p.funeralLocation}</p>
      </div>

      {p.totals && <LiveTotal slug={slug} initial={p.totals} />}
      {p.usage && <p className="muted">{t('page.paid_out', { amount: formatMoney(p.usage.paidOut) })}</p>}
      {p.usage && p.usage.byPurpose.length > 0 && (
        <>
          <h2>{t('page.usage.title')}</h2>
          <ul className="plain">
            {p.usage.byPurpose.map((u) => (
              <li key={u.purpose}>
                {purposeLabel(u.purpose)}: {formatMoney(u.amount)}
              </li>
            ))}
          </ul>
        </>
      )}

      {p.closed ? (
        <p className="card">{t('page.closed')}</p>
      ) : open ? (
        <Link className="button big" href={`/w/${slug}/give`}>
          {t('page.contribute')}
        </Link>
      ) : (
        <p className="muted">{t('error.feature_disabled')}</p>
      )}

      {!p.closed && (
        <>
          <h2>{t('page.share')}</h2>
          <p>
            <a href={p.share.whatsapp}>WhatsApp</a> · <a href={p.share.sms}>SMS</a> · <a href={p.share.facebook}>Facebook</a>
          </p>
          <img className="qr" src={`${API_BASE}/public/wallets/${slug}/qr.svg`} alt="QR code for this page" />
        </>
      )}

      {p.tributes && (
        <>
          <h2>{t('page.tributes.title')}</h2>
          <ul className="plain">
            {p.tributes.map((tr) => (
              <li key={tr.id}>
                <strong>{tr.name}</strong>
                {tr.amount && <span className="muted"> · {formatMoney(tr.amount)}</span>}
                <p>{tr.message}</p>
              </li>
            ))}
          </ul>
        </>
      )}

      {!p.closed && (
        <p className="small">
          <Link href={`/w/${slug}/report`}>{t('page.report')}</Link>
        </p>
      )}
    </main>
  );
}
