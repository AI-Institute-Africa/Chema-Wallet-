'use client';
// Old links and QR codes to /w/[slug]/give keep working: the same contribute
// form as the memorial page, on its own.
import { t } from '@chema/shared/i18n';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API_BASE, createPublicClient, type PublicPage } from '../../../../lib/public';
import ContributeForm from '../contribute-form';

const client = createPublicClient({ baseUrl: API_BASE });

export default function Give() {
  const { slug } = useParams<{ slug: string }>();
  const [page, setPage] = useState<PublicPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client
      .page(slug)
      .then(setPage)
      .catch(() => setError(t('error.not_available')));
  }, [slug]);
  if (error) return <main><p className="error">{error}</p></main>;
  if (!page) return <main><p className="muted">Loading…</p></main>;
  return (
    <main className="public">
      <p className="small">
        <Link href={`/w/${slug}`}>← {t('memorial.title', { name: page.deceasedName })}</Link>
      </p>
      {page.closed || page.contribute.rails.length === 0 ? (
        <p className="card">{page.closed ? t('page.closed') : t('error.feature_disabled')}</p>
      ) : (
        <ContributeForm page={page} />
      )}
    </main>
  );
}
