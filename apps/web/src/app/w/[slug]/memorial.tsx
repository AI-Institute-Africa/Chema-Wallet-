// One memorial page for everyone (UI redesign 2026-11-11): contributors see it
// at /w/[slug]; the family admin sees the SAME page at /wallets/[id] with owner
// tools slotted in (photo, target), and a "not public yet" preview before
// verification. Privacy is applied by the API: hidden fields never arrive here.
// No hooks here, so it renders on the server (public) and the client (owner).
import { t } from '@chema/shared/i18n';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { initials, moneyShort, orderRails, railName, relativeTime } from '../../../lib/memorial';
import { API_BASE, type PublicPage } from '../../../lib/public';
import ContributeForm from './contribute-form';
import LiveTotal from './live-total';
import ShareButtons from './share-buttons';

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

/** Whole-number share of a part in the paid-out total, from minor-unit strings (no floats). */
function sharePercent(part: string, total: string): number {
  const tot = BigInt(total);
  if (tot <= 0n) return 0;
  const pct = (BigInt(part) * 100n) / tot;
  return Number(pct > 100n ? 100n : pct);
}

export type MemorialMode = 'public' | 'owner' | 'preview';

export interface MemorialProps {
  page: PublicPage;
  mode: MemorialMode;
  /** Owner only: photo add/change control, rendered on the portrait. */
  photoControl?: ReactNode;
  /** Owner only: inline target editor, replaces the static target line. */
  targetEditor?: ReactNode;
  /** Shown above the page (owner bar, preview notice). */
  banner?: ReactNode;
  /** Photo URL override (owner preview of a just-uploaded photo). */
  photoUrl?: string | null;
  /** Rendered below the page (owner: documents, appeal). */
  footer?: ReactNode;
}

export default function Memorial({ page: p, mode, photoControl, targetEditor, banner, photoUrl, footer }: MemorialProps) {
  const preview = mode === 'preview';
  const open = !preview && !p.closed && p.contribute.rails.length > 0;
  const photo = photoUrl !== undefined ? photoUrl : p.photoPath ? `${API_BASE}${p.photoPath}` : null;
  const name = p.deceasedName;
  return (
    <main className="memorial-main" data-testid="memorial" data-mode={mode}>
      {banner}
      <div className="m-grid">
        <div className="m-col">
          <section className="m-card panel m-memorial">
            <div className="portrait">
              {photo ? (
                <img src={photo} alt={name} />
              ) : (
                <div className="ph">
                  <svg viewBox="0 0 120 120" fill="currentColor" aria-hidden="true">
                    <circle cx="60" cy="42" r="22" />
                    <path d="M16 112c0-26 20-42 44-42s44 16 44 42z" />
                  </svg>
                  {!photoControl && <span className="sr-only">{t('memorial.photo.placeholder', { name })}</span>}
                </div>
              )}
              {photoControl}
              <div className="caption">
                <p className="meta">{t('memorial.caption', { date: p.dateOfDeath, location: p.funeralLocation })}</p>
                {!preview && (
                  <span className="chip" title={p.badge.tooltip}>
                    {p.badge.label}
                  </span>
                )}
              </div>
            </div>

            <div className="m-body">
              <h2 className="m-title">{t('memorial.title', { name })}</h2>
              {!preview && <p className="badge-note">{p.badge.tooltip}</p>}
              {p.policy && (
                <div className="policy" data-testid="policy">
                  <small>{p.policy.insurer}</small>
                  <strong>{t('memorial.policy.number', { number: p.policy.number })}</strong>
                </div>
              )}
              <p className="desc">
                {t('memorial.description', { name })}
                {p.funeralDate && (
                  <>
                    {' '}
                    {t('memorial.funeral', { date: p.funeralDate, location: p.funeralLocation })}
                  </>
                )}
              </p>

              {p.totals ? (
                <LiveTotal slug={p.slug} initial={p.totals} targetEditor={targetEditor} poll={!preview} />
              ) : (
                targetEditor && <div className="progress-box">{targetEditor}</div>
              )}

              {!p.closed && !preview && <ShareButtons share={p.share} slug={p.slug} />}
            </div>
          </section>

          {p.usage && (
            <section className="m-card panel usage">
              <h3>{t('page.usage.title')}</h3>
              <p className="muted">{t('page.paid_out', { amount: moneyShort(p.usage.paidOut) })}</p>
              {p.usage.byPurpose.length > 0 && (
                <ul className="u-bars">
                  {p.usage.byPurpose.map((u) => {
                    const pct = sharePercent(u.amount.minor, p.usage?.paidOut.minor ?? '0');
                    return (
                      <li key={u.purpose}>
                        <div className="u-bar-head">
                          <span>{purposeLabel(u.purpose)}</span>
                          <b>{moneyShort(u.amount)}</b>
                        </div>
                        <div className="u-track" role="img" aria-label={t('page.usage.share', { percent: String(pct) })}>
                          <div className="u-fill" style={{ width: `${pct}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {p.usage.payouts && p.usage.payouts.length > 0 && (
                <>
                  <h4>{t('page.usage.list_title')}</h4>
                  <ul className="u-list">
                    {p.usage.payouts.map((u, i) => (
                      <li key={`${u.at}:${i}`}>
                        <span>
                          <time dateTime={u.at}>{u.at.slice(0, 10)}</time> · {purposeLabel(u.purpose)}
                        </span>
                        <b>{moneyShort(u.amount)}</b>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {p.tributes && (
            <section className="m-card panel tributes">
              <h3>{t('memorial.tributes.title', { count: String(p.tributes.length) })}</h3>
              {p.tributes.map((tr) => (
                <article className="tribute" key={tr.id}>
                  <div className="avatar" aria-hidden="true">
                    {initials(tr.name)}
                  </div>
                  <div className="t-main">
                    <div className="head">
                      <span className="name">{tr.name}</span>
                      <span className="time">{relativeTime(tr.at)}</span>
                    </div>
                    <p>{tr.message}</p>
                    {tr.amount && (
                      <span className="badge">
                        {t('memorial.tributes.contributed', { amount: `${moneyShort(tr.amount)} ${tr.amount.ccy}` })}
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}
        </div>

        <aside className="m-col m-right">
          {p.closed ? (
            <div className="m-card panel closed-note">
              <p>{t('page.closed')}</p>
            </div>
          ) : open || preview ? (
            <ContributeForm page={p} disabled={preview} />
          ) : (
            <div className="m-card panel closed-note">
              <p className="muted">{t('error.feature_disabled')}</p>
            </div>
          )}

          <div className="m-card panel guard">
            <h4>{t('memorial.guard.title')}</h4>
            <p>{t('memorial.guard.body')}</p>
            {p.contribute.rails.length > 0 && (
              <div className="methods">
                {orderRails(p.contribute.rails).map((r) => (
                  <span key={r}>{railName(r).toUpperCase()}</span>
                ))}
              </div>
            )}
          </div>

          {!p.closed && !preview && (
            <p className="report-link">
              <Link href={`/w/${p.slug}/report`}>{t('page.report')}</Link>
            </p>
          )}
        </aside>
      </div>

      {footer}

      {open && (
        <div className="sticky-bar glass">
          <a className="button big" href="#give">
            {t('memorial.cta')}
          </a>
        </div>
      )}
    </main>
  );
}
