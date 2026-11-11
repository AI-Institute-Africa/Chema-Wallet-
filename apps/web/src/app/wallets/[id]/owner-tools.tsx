'use client';
// Owner-only controls slotted into the memorial page (UI redesign 2026-11-11):
// photo add/change and the target editor. Every action is re-authorised by the
// API (wallet admin only); this file only collects input.
import { t } from '@chema/shared/i18n';
import { useRef, useState } from 'react';
import { ApiError, majorToMinor } from '../../../lib/api';
import { minorToInput, moneyShort } from '../../../lib/memorial';
import type { MoneyJSON } from '../../../lib/public';
import { api } from '../../../lib/session';

const MAX_SIDE = 900;

/** Resize to at most 900 px and re-encode as JPEG in the browser (smaller upload, EXIF dropped). */
async function resized(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.trunc(bitmap.width * scale));
  canvas.height = Math.max(1, Math.trunc(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('encode failed');
  return new Uint8Array(await blob.arrayBuffer());
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function PhotoControl({
  walletId,
  name,
  hasPhoto,
  onDone,
}: {
  walletId: string;
  name: string;
  hasPhoto: boolean;
  onDone: (msg: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    onDone('Uploading the photo…');
    try {
      const bytes = await resized(file);
      const doc = await api.uploadPhoto(walletId, 'image/jpeg', bytes);
      // The worker scans every upload; the photo can be set once the scan is clean.
      for (let i = 0; i < 20; i++) {
        try {
          await api.setPhoto(walletId, doc.id);
          onDone('Photo updated.');
          return;
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'document_not_available')) throw e;
          await wait(1500);
        }
      }
      onDone('The photo is still being checked. Please refresh in a minute.');
    } catch (e) {
      onDone(e instanceof ApiError && e.status === 403 ? 'Only the wallet administrator can change the photo.' : 'The photo could not be uploaded. Please use a JPG or PNG under 5 MB.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/jpeg,image/png"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void upload(f);
      }}
    />
  );
  return hasPhoto ? (
    <>
      <button className="icon-btn change-photo" type="button" aria-label="Change photo" title="Change photo" disabled={busy} onClick={() => input.current?.click()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      </button>
      {picker}
    </>
  ) : (
    <div className="ph-action">
      <button className="pill" type="button" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Uploading…' : `Add ${name}'s photo`}
      </button>
      {picker}
    </div>
  );
}

export function TargetEditor({
  walletId,
  target,
  currency,
  onSaved,
}: {
  walletId: string;
  target: MoneyJSON | null;
  currency: 'USD' | 'ZWG';
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(target ? minorToInput(BigInt(target.minor)) : '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setErr(null);
    let minor: string | null = null;
    if (value.trim()) {
      try {
        const m = majorToMinor(value);
        if (m <= 0n) throw new Error('zero');
        minor = m.toString();
      } catch {
        setErr('Enter a target above 0, like 2000 or 2000.50.');
        return;
      }
    }
    setBusy(true);
    try {
      await api.updateTarget(walletId, minor);
      setOpen(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'Only the wallet administrator can change the target.' : 'The target could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <span data-testid="target-view">
        {target ? (
          <>
            {t('memorial.target', { amount: '' })}
            <b>
              {moneyShort(target)} {target.ccy}
            </b>
          </>
        ) : (
          <span>No target set</span>
        )}
        <button type="button" className="link" onClick={() => setOpen(true)}>
          {target ? 'Edit' : 'Set a target'}
        </button>
      </span>
    );
  }
  return (
    <div className="tform">
      <label htmlFor="tIn">Target ({currency})</label>
      <input
        id="tIn"
        inputMode="decimal"
        value={value}
        autoFocus
        aria-describedby="e-tIn"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <button type="button" className="pill dark" disabled={busy} onClick={() => void save()}>
        Save
      </button>
      <button type="button" className="pill" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {err && (
        <p className="err error" id="e-tIn" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
