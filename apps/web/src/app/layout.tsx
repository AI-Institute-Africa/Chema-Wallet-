import '@chema/shared/theme.css';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { ThemeToggle } from '../components/theme';
import { THEME_INIT } from '../components/theme-init';
import './globals.css';

export const metadata: Metadata = {
  title: 'Chema Wallet',
  description: 'Funeral support, collected with dignity.',
};

// Rendered per request: the CSP nonce from src/proxy.ts is applied at render
// time, so no page may be prerendered with a stale (or no) nonce. The theme
// script carries that nonce and sets data-theme before first paint.
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <header className="top glass">
          <div className="top-inner">
            <Link className="brand" href="/">
              <span className="logo" aria-hidden="true">
                CW
              </span>
              <span>
                <span className="name">Chema Wallet</span>
                <span className="sub">Fidelity Life Assurance · Zimbabwe</span>
              </span>
            </Link>
            <div className="top-right">
              <ThemeToggle />
            </div>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
