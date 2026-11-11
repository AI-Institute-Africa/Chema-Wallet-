import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Chema Wallet',
  description: 'Funeral support, collected with dignity.',
};

// Rendered per request: the CSP nonce from src/proxy.ts is applied at render
// time, so no page may be prerendered with a stale (or no) nonce.
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
