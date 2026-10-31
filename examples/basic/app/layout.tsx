import { HypDrivDevTools, VitalsReporter } from 'hypdriv/client';
import { HypDrivMeta, Speculation } from 'hypdriv/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Hypdriv basic example', template: '%s · Hypdriv' },
  description: 'Next.js 16 on Cloudflare Workers with Hypdriv.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HypDrivMeta />
        <Speculation />
      </head>
      <body>
        <header className="site-header">
          <a href="/" className="brand">
            Hypdriv
          </a>
          <nav>
            <a href="/blog">Blog</a>
            <a href="/dashboard">Dashboard</a>
            <a href="/account">Account</a>
          </nav>
        </header>
        <main>{children}</main>
        <VitalsReporter />
        <HypDrivDevTools />
      </body>
    </html>
  );
}
