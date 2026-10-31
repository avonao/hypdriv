import { VitalsReporter } from 'hypdriv/client';
import { HypDrivMeta, Speculation } from 'hypdriv/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: { default: 'HypDriv e2e', template: '%s · HypDriv e2e' },
  description: 'Live end-to-end suite for HypDriv on Vercel.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HypDrivMeta />
        <Speculation />
      </head>
      <body>
        <nav>
          <a href="/">Home</a> <a href="/isr">ISR</a> <a href="/tagged">Tagged</a> <a href="/geo">Geo</a>{' '}
          <a href="/form">Form</a> <a href="/images">Images</a> <a href="/flags">Flags</a>{' '}
          <a href="/botid">BotID</a>
        </nav>
        <main>{children}</main>
        <VitalsReporter />
      </body>
    </html>
  );
}
