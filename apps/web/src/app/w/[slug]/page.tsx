// Public funeral page (docs/06), server-rendered. Privacy is applied by the
// API: fields the family hides never reach this server, let alone the browser.
// The family admin sees the same <Memorial> at /wallets/[id] (UI redesign).
import { notFound } from 'next/navigation';
import { ApiError } from '../../../lib/api';
import { SERVER_API_BASE, createPublicClient, type PublicPage } from '../../../lib/public';
import Memorial from './memorial';

export const dynamic = 'force-dynamic';

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
  return <Memorial page={await load(slug)} mode="public" />;
}
