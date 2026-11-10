'use client';
// Family privacy settings (docs/06): what the public page shows. Everything
// starts hidden; the API enforces it, this screen only flips the toggles.
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { API_BASE, PRIVACY_KEYS, createPublicClient, type Privacy } from '../../../../lib/public';
import { getToken } from '../../../../lib/session';

const client = createPublicClient({ baseUrl: API_BASE, token: getToken });

const LABELS: Record<(typeof PRIVACY_KEYS)[number], string> = {
  showTotal: 'Total received (and funeral costs, if set)',
  showUsageSummary: 'How much has been used for funeral costs',
  showPhoto: 'Photo',
  showContributorNames: 'Names of contributors',
  showAmounts: 'Amount next to each message',
  showTributes: 'Messages of condolence',
};

export default function PrivacySettings() {
  const { id } = useParams<{ id: string }>();
  const [p, setP] = useState<Privacy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .privacy(id)
      .then(setP)
      .catch((e: unknown) => setError(e instanceof ApiError && e.status === 401 ? 'Please sign in.' : 'Not available.'));
  }, [id]);

  async function toggle(key: (typeof PRIVACY_KEYS)[number], value: boolean) {
    try {
      setP(await client.setPrivacy(id, { [key]: value }));
    } catch {
      setError('Only the wallet administrator can change these settings.');
    }
  }

  if (error) return <main><p className="error">{error}</p></main>;
  if (!p) return <main><p className="muted">Loading…</p></main>;
  return (
    <main>
      <h1>What the public page shows</h1>
      <p className="muted">The name, funeral details and the verified badge are always shown. Everything else is your choice.</p>
      <ul className="plain">
        {PRIVACY_KEYS.map((k) => (
          <li key={k}>
            <label className="check">
              <input type="checkbox" checked={p[k]} onChange={(e) => void toggle(k, e.target.checked)} /> {LABELS[k]}
            </label>
          </li>
        ))}
      </ul>
    </main>
  );
}
