'use client';
// Create a private draft wallet. Nothing is public until community checks pass.
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiError, type DraftForm } from '../../lib/api';
import { api } from '../../lib/session';

const EMPTY: DraftForm = {
  deceasedName: '',
  dateOfDeath: '',
  funeralDate: '',
  funeralLocation: '',
  familyContactPhone: '',
  target: '',
  currency: 'USD',
  policyNo: '',
};

export default function NewWallet() {
  const router = useRouter();
  const [form, setForm] = useState<DraftForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof DraftForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const w = await api.createDraft(form);
      router.push(`/wallets/${w.id}/evidence`);
    } catch (err) {
      if (err instanceof RangeError) setError('Target amount should look like 1500 or 1500.50.');
      else if (err instanceof ApiError && err.status === 401) setError('Please sign in first.');
      else setError('Please check the details and try again.');
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Start a funeral wallet</h1>
      <p className="muted">This creates a private draft. Only you can see it until our community checks pass.</p>
      <form className="card" onSubmit={onSubmit}>
        <label htmlFor="name">Full name of the person who passed away</label>
        <input id="name" required maxLength={200} value={form.deceasedName} onChange={set('deceasedName')} />
        <label htmlFor="dod">Date of death</label>
        <input id="dod" type="date" required value={form.dateOfDeath} onChange={set('dateOfDeath')} />
        <label htmlFor="fd">Funeral date (if known)</label>
        <input id="fd" type="date" value={form.funeralDate} onChange={set('funeralDate')} />
        <label htmlFor="loc">Funeral location</label>
        <input id="loc" required maxLength={200} value={form.funeralLocation} onChange={set('funeralLocation')} />
        <label htmlFor="contact">Family contact phone (optional)</label>
        <input id="contact" inputMode="tel" placeholder="+263771234567" value={form.familyContactPhone} onChange={set('familyContactPhone')} />
        <label htmlFor="ccy">Currency</label>
        <select id="ccy" value={form.currency} onChange={set('currency')}>
          <option value="USD">USD</option>
          <option value="ZWG">ZiG (ZWG)</option>
        </select>
        <label htmlFor="target">Target amount (optional)</label>
        <input id="target" inputMode="decimal" placeholder="e.g. 1500" value={form.target} onChange={set('target')} />
        <label htmlFor="policy">Fidelity policy number (optional)</label>
        <input id="policy" maxLength={64} value={form.policyNo} onChange={set('policyNo')} />
        <p className="muted">A policy number does not affect the community checks; a claim is handled separately.</p>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save draft'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
