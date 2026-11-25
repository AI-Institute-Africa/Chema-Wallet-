'use client';
// Family statement (2026-11-25): every amount that came into the wallet and
// where the money went. Names are the family's to see (product decision:
// anonymity is public-only); the API audits each read. Payee numbers arrive
// masked; nothing here can reveal more than the server sent.
import { t } from '@chema/shared/i18n';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  explainError,
  filterLines,
  groupByDay,
  payoutStatusLabel,
  pendingTitle,
  purposeLabel,
  txSourceLabel,
  txTitle,
  type TxFilter,
  type TxLine,
  type TxPending,
  type TxSummary,
  type WalletTransactions,
} from '../../../../lib/family';
import { FamilyNav, Page, Status, useLoad } from '../../../../lib/family-ui';
import { moneyShort, railName } from '../../../../lib/memorial';
import { family } from '../../../../lib/session';

const FILTERS: [TxFilter, Parameters<typeof t>[0]][] = [
  ['ALL', 'fam.tx.filter.all'],
  ['IN', 'fam.tx.filter.in'],
  ['OUT', 'fam.tx.filter.out'],
  ['PENDING', 'fam.tx.filter.pending'],
];

function Arrow({ dir }: { dir: 'IN' | 'OUT' }) {
  return (
    <span className={`tx-icon ${dir === 'IN' ? 'in' : 'out'}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {dir === 'IN' ? <path d="M12 5v14M5 12l7 7 7-7" /> : <path d="M12 19V5M5 12l7-7 7 7" />}
      </svg>
    </span>
  );
}

function SummaryCard({ s }: { s: TxSummary }) {
  return (
    <div className="panel tx-sum" data-source={s.source}>
      <strong>{txSourceLabel(s.source, s.groupName)}</strong>
      <dl>
        <div>
          <dt>{t('fam.tx.summary.in')}</dt>
          <dd>{moneyShort(s.moneyIn)}</dd>
        </div>
        <div>
          <dt>{t('fam.tx.summary.out')}</dt>
          <dd>{moneyShort(s.moneyOut)}</dd>
        </div>
        <div className="now">
          <dt>{t('fam.tx.summary.balance')}</dt>
          <dd>{moneyShort(s.balance)}</dd>
        </div>
      </dl>
      <p className="small muted">{t('fam.tx.summary.available', { amount: moneyShort(s.available) })}</p>
      {BigInt(s.reserved.minor) > 0n && <p className="small muted">{t('fam.tx.summary.reserved', { amount: moneyShort(s.reserved) })}</p>}
      {s.source === 'FIDELITY_BENEFIT' && <p className="small muted">{t('fam.tx.benefit_note')}</p>}
    </div>
  );
}

function subtitle(l: TxLine): string[] {
  const bits: string[] = [];
  if (l.source !== 'COMMUNITY') bits.push(txSourceLabel(l.source, l.groupName));
  if (l.contribution) {
    bits.push(railName(l.contribution.rail));
    if (l.contribution.receiptNo) bits.push(t('fam.tx.receipt', { no: l.contribution.receiptNo }));
  }
  if (l.payout) {
    bits.push(purposeLabel(l.payout.purpose));
    bits.push(railName(l.payout.rail));
  }
  if (l.claimRef) bits.push(t('fam.tx.claim', { ref: l.claimRef }));
  return bits;
}

function Row({ l }: { l: TxLine }) {
  const [open, setOpen] = useState(false);
  const sign = l.direction === 'IN' ? '+' : '−';
  return (
    <li className={`tx-row${l.reversedById ? ' struck' : ''}`} data-kind={l.kind} data-direction={l.direction}>
      <button type="button" className="tx-main" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Arrow dir={l.direction} />
        <span className="tx-text">
          <span className="tx-title">{txTitle(l)}</span>
          <span className="tx-sub small muted">{subtitle(l).join(' · ')}</span>
          {(l.payout?.note || l.note) && <span className="tx-note small">“{l.payout?.note ?? l.note}”</span>}
          <span className="tx-tags">
            {l.contribution?.anonymousPublicly && <span className="badge">{t('fam.tx.anonymous_public')}</span>}
            {l.reversedById && <span className="badge warn">{t('fam.tx.status.reversed')}</span>}
          </span>
        </span>
        <span className="tx-amt">
          <span className={`tx-value ${l.direction === 'IN' ? 'in' : 'out'}`}>
            {sign}
            {moneyShort(l.amount)}
          </span>
          <span className="small muted">{t('fam.tx.balance_after', { amount: moneyShort(l.balanceAfter) })}</span>
        </span>
      </button>
      {open && (
        <dl className="tx-details small">
          <div>
            <dt>{t('fam.tx.details')}</dt>
            <dd>{new Date(l.at).toLocaleString()}</dd>
          </div>
          {l.contribution?.publicName && (
            <div>
              <dt>{t('fam.tx.shown_as', { name: '' }).trim()}</dt>
              <dd>{l.contribution.publicName}</dd>
            </div>
          )}
          {l.contribution?.hasMessage && (
            <div>
              <dt>✓</dt>
              <dd>{t('fam.tx.with_message')}</dd>
            </div>
          )}
          {l.payout?.providerRef && (
            <div>
              <dt>{t('fam.tx.ref', { ref: '' }).trim()}</dt>
              <dd>{l.payout.providerRef}</dd>
            </div>
          )}
          {l.approvalRef && (
            <div>
              <dt>{t('fam.tx.approval', { ref: '' }).trim()}</dt>
              <dd>{l.approvalRef}</dd>
            </div>
          )}
          {l.reversesId && (
            <div>
              <dt>↺</dt>
              <dd>{t('fam.tx.reverses')}</dd>
            </div>
          )}
          {l.reversedById && (
            <div>
              <dt>↺</dt>
              <dd>{t('fam.tx.reversed_by')}</dd>
            </div>
          )}
        </dl>
      )}
    </li>
  );
}

function PendingRow({ p }: { p: TxPending }) {
  return (
    <li className="tx-row pending" data-kind={p.type} data-direction={p.direction}>
      <div className="tx-main">
        <Arrow dir={p.direction} />
        <span className="tx-text">
          <span className="tx-title">{pendingTitle(p)}</span>
          <span className="tx-sub small muted">
            {[p.payout ? purposeLabel(p.payout.purpose) : null, p.payout ? payoutStatusLabel(p.status) : null, p.contribution ? railName(p.contribution.rail) : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {p.payout?.note && <span className="tx-note small">“{p.payout.note}”</span>}
        </span>
        <span className="tx-amt">
          <span className="tx-value pending">
            {p.direction === 'IN' ? '+' : '−'}
            {moneyShort(p.amount)}
          </span>
        </span>
      </div>
    </li>
  );
}

export default function Transactions() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useLoad(() => family.transactions(id), [id]);
  const [older, setOlder] = useState<TxLine[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [filter, setFilter] = useState<TxFilter>('ALL');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const view: WalletTransactions | null = data;
  const next = cursor === undefined ? view?.nextCursor ?? null : cursor;
  const lines = view ? [...view.lines, ...older] : [];
  const shown = filterLines(lines, filter);

  async function loadMore() {
    if (!next) return;
    setBusy(true);
    try {
      const page = await family.transactions(id, next);
      setOlder((o) => [...o, ...page.lines]);
      setCursor(page.nextCursor);
    } catch (e) {
      setErr(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setErr(null);
    try {
      const { filename, csv } = await family.transactionsCsv(id);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(explainError(e));
    }
  }

  return (
    <Page title={t('fam.tx.title')} walletId={id} intro={t('fam.tx.intro')}>
      <Status error={error ?? err} />
      {!view && !error && <p className="muted">{t('fam.loading')}</p>}
      {view && (
        <>
          <section className="tx-summary" aria-label={t('fam.tx.title')}>
            {view.summary.map((s) => (
              <SummaryCard key={`${s.source}:${s.groupName ?? ''}:${s.currency}`} s={s} />
            ))}
          </section>

          <div className="tx-toolbar">
            <div className="tx-filters" role="radiogroup" aria-label={t('fam.tx.filters')}>
              {FILTERS.map(([f, key]) => (
                <button key={f} type="button" role="radio" aria-checked={filter === f} className={`pill${filter === f ? ' dark' : ''}`} onClick={() => setFilter(f)}>
                  {t(key)}
                  {f === 'PENDING' && view.pending.length > 0 ? ` (${view.pending.length})` : ''}
                </button>
              ))}
            </div>
            <div className="tx-actions">
              <button type="button" className="pill" onClick={download}>
                {t('fam.tx.download')}
              </button>
              <button type="button" className="pill" onClick={() => window.print()}>
                {t('fam.tx.print')}
              </button>
            </div>
          </div>

          {(filter === 'ALL' || filter === 'PENDING') && view.pending.length > 0 && (
            <section className="panel tx-list" aria-labelledby="tx-pending">
              <h2 id="tx-pending">{t('fam.tx.pending_title')}</h2>
              <p className="small muted">{t('fam.tx.pending_note')}</p>
              <ul className="tx-rows">
                {view.pending.map((p) => (
                  <PendingRow key={`${p.type}:${p.id}`} p={p} />
                ))}
              </ul>
            </section>
          )}

          {filter !== 'PENDING' && (
            <section className="panel tx-list" aria-label={t('fam.tx.title')}>
              {shown.length === 0 && <p className="muted">{t('fam.tx.empty')}</p>}
              {groupByDay(shown).map((g) => (
                <div key={g.day} className="tx-day">
                  <h3>{g.day}</h3>
                  <ul className="tx-rows">
                    {g.items.map((l) => (
                      <Row key={`${l.id}:${l.source}`} l={l} />
                    ))}
                  </ul>
                </div>
              ))}
              {next && (
                <button type="button" className="pill" disabled={busy} onClick={loadMore}>
                  {t('fam.tx.more')}
                </button>
              )}
            </section>
          )}
          {filter === 'PENDING' && view.pending.length === 0 && <p className="muted">{t('fam.tx.empty')}</p>}
        </>
      )}
      <FamilyNav walletId={id} />
    </Page>
  );
}
