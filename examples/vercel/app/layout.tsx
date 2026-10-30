import { HypDrivDevTools, VitalsReporter } from 'hypdriv/client';
import { HypDrivMeta, Speculation } from 'hypdriv/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'HypDriv on Vercel', template: '%s · HypDriv' },
  description: 'Next.js 16 on Vercel with HypDriv.',
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
            HypDriv
          </a>
          <nav>
            <a href="/products/trail-runner">Products</a>
            <a href="/contact">Contact</a>
          </nav>
        </header>
        <main>{children}</main>
        <VitalsReporter />
        <HypDrivDevTools />
      </body>
    </html>
  );
}
