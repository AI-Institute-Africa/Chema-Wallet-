'use client';
// "Report this page" (docs/05/06): opens a review case; it changes nothing on the page by itself.
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { API_BASE, createPublicClient } from '../../../../lib/public';

const client = createPublicClient({ baseUrl: API_BASE });
const CATEGORIES = { FAKE_DEATH: 'This death is not real', NOT_FAMILY: 'Not run by the family', DUPLICATE: 'Duplicate page', SCAM: 'Scam', OTHER: 'Something else' };

export default function Report() {
  const { slug } = useParams<{ slug: string }>();
  const [category, setCategory] = useState('OTHER');
  const [details, setDetails] = useState('');
  const [done, setDone] = useState<string | null>(null);

  async function send() {
    await client
      .report(slug, category, details.trim() || undefined)
      .then(() => setDone('Thank you. Our team will look into it.'))
      .catch(() => setDone('Could not send the report. Please try again later.'));
  }

  return (
    <main>
      <h1>Report this page</h1>
      {done ? (
        <p>{done}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="cat">What is wrong?</label>
          <select id="cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(CATEGORIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <label htmlFor="details">Details (optional)</label>
          <textarea id="details" rows={4} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
          <button type="submit">Send report</button>
        </form>
      )}
    </main>
  );
}
