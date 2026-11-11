'use client';
// Share row (WhatsApp first, as in the design; SMS/Facebook secondary; copy link; QR).
import { t } from '@chema/shared/i18n';
import { useState } from 'react';
import type { ShareLinks } from '../../../lib/api';
import { API_BASE } from '../../../lib/public';

export default function ShareButtons({ share, slug }: { share: ShareLinks; slug: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(share.copy);
    } catch {
      const i = document.createElement('input');
      i.value = share.copy;
      document.body.appendChild(i);
      i.select();
      document.execCommand('copy');
      document.body.removeChild(i);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }
  return (
    <div className="share">
      <a className="pill dark" href={share.whatsapp} target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.5A8.5 8.5 0 1 1 21 11.5z" />
        </svg>
        {t('memorial.share.whatsapp')}
      </a>
      <button type="button" className="pill" onClick={() => void copy()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
        <span aria-live="polite">{copied ? t('memorial.share.copied') : t('memorial.share.copy')}</span>
      </button>
      <a className="pill" href={share.sms}>
        SMS
      </a>
      <a className="pill" href={share.facebook} target="_blank" rel="noopener noreferrer">
        Facebook
      </a>
      <details>
        <summary>{t('memorial.share.qr')}</summary>
        <img className="qr" src={`${API_BASE}/public/wallets/${slug}/qr.svg`} alt="QR code for this page" width={220} height={220} />
      </details>
    </div>
  );
}
