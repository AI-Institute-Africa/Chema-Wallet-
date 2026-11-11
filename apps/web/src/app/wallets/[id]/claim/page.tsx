'use client';
// Fidelity claim: look up the policy, link the claim, send documents. Chema
// never decides a claim; Fidelity does. Community money never waits for it.
import { t } from '@chema/shared/i18n';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { benefitMessage, explainError, msgFor, type LookupOutcome } from '../../../../lib/family';
import { FamilyNav, Page, Status, useLoad } from '../../../../lib/family-ui';
import { family } from '../../../../lib/session';

const ACCEPT = 'application/pdf,image/jpeg,image/png';

export default function Claim() {
  const { id } = useParams<{ id: string }>();
  const funds = useLoad(() => family.funds(id), [id]);
  const claim = useLoad(() => family.claim(id).catch((e: unknown) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))), [id]);
  const [policyNo, setPolicyNo] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [outcome, setOutcome] = useState<{ outcome: LookupOutcome; linkable: boolean } | null>(null);
  const [recipient, setRecipient] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  const lookup = () =>
    run(async () => {
      const r = await family.lookup(id, { ...(policyNo.trim() ? { policyNo: policyNo.trim() } : {}), ...(nationalId.trim() ? { nationalId: nationalId.trim() } : {}) });
      setOutcome({ outcome: r.outcome, linkable: r.linkable });
    });
  const link = () =>
    run(async () => {
      await family.linkClaim(id, recipient.trim(), recipientId.trim());
      setMessage(t('fam.claim.linked'));
      claim.reload();
      funds.reload();
    });
  const sendEvidence = () =>
    run(async () => {
      if (!file) return;
      const doc = await family.uploadDocument(id, 'OTHER', file.type, new Uint8Array(await file.arrayBuffer()));
      await family.claimEvidence(id, [doc.id]);
      setFile(null);
      setMessage(t('fam.claim.evidence_sent'));
    });

  // `null` claim = the Fidelity link is switched off (404): community funds still work.
  const disabled = claim.data === null && !claim.error && funds.data !== null;
  const c = claim.data;

  return (
    <Page title={t('fam.claim.title')} walletId={id} intro={t('fam.claim.intro')}>
      <Status error={error ?? claim.error} message={message} />
      <div className="card">
        <h2>{t('fam.claim.status_heading')}</h2>
        {funds.data ? <p>{benefitMessage(funds.data.benefit.status)}</p> : <p className="muted">{t('fam.loading')}</p>}
        {funds.data?.benefit.statusUpdating && <p className="muted">{t('funds.benefit.status_updating')}</p>}
        {c?.policyNo && <p className="muted">{t('fam.claim.policy', { policyNo: c.policyNo })}</p>}
        <p className="muted small">{t('badge.verified.tooltip')}</p>
      </div>

      {disabled && <p className="muted">{t('error.feature_disabled')}</p>}

      {c && !c.linked && (
        <>
          <div className="card">
            <h2>{t('fam.claim.lookup_heading')}</h2>
            <label htmlFor="policy">{t('fam.claim.policy_no')}</label>
            <input id="policy" maxLength={64} value={policyNo} onChange={(e) => setPolicyNo(e.target.value)} />
            <label htmlFor="nid">{t('fam.claim.national_id')}</label>
            <input id="nid" maxLength={64} value={nationalId} onChange={(e) => setNationalId(e.target.value)} />
            <button onClick={() => void lookup()} disabled={busy || (!policyNo.trim() && !nationalId.trim())}>
              {t('fam.claim.lookup')}
            </button>
            {outcome && <p role="status">{msgFor('fam.claim.outcome', outcome.outcome, 'fam.error.invalid')}</p>}
          </div>
          {outcome?.linkable && (
            <div className="card">
              <h2>{t('fam.claim.link_heading')}</h2>
              <p className="muted">{t('fam.claim.recipient_help')}</p>
              <label htmlFor="recipient">{t('fam.claim.recipient')}</label>
              <input id="recipient" maxLength={64} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
              <label htmlFor="rid">{t('fam.claim.recipient_id')}</label>
              <input id="rid" maxLength={40} autoComplete="off" value={recipientId} onChange={(e) => setRecipientId(e.target.value)} />
              <button onClick={() => void link()} disabled={busy || !recipient.trim() || recipientId.trim().length < 4}>
                {t('fam.claim.link')}
              </button>
            </div>
          )}
        </>
      )}

      {c?.linked && (
        <div className="card">
          <h2>{t('fam.claim.evidence_heading')}</h2>
          <p className="muted">{t('fam.claim.evidence_help')}</p>
          <input id="claim-file" type="file" accept={ACCEPT} aria-label={t('fam.claim.evidence_heading')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button onClick={() => void sendEvidence()} disabled={busy || !file}>
            {t('fam.claim.evidence_send')}
          </button>
        </div>
      )}
      <FamilyNav walletId={id} />
    </Page>
  );
}
