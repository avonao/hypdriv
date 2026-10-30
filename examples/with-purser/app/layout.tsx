import { css } from '@avonao/purser';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { HypDrivDevTools, VitalsReporter } from 'hypdriv/client';
import { HypDrivMeta, Speculation, ThemeScript } from 'hypdriv/server';
import { ThemeSwitch } from '@/components/theme-switch';
import { layout } from '@/lib/styles';
import config from '../hypdriv.config';
import './purser.css';

export const metadata: Metadata = {
  title: { default: 'HypDriv × Purser CSS', template: '%s · HypDriv × Purser' },
  description: 'Next.js 16 on Cloudflare Workers with HypDriv and Purser CSS: zero overrides, flashless themes.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The Worker pins the theme classes on <html> before the HTML leaves the edge; the fallback script
    // does the same on other runners. Both change `class` outside React.
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript config={config} />
        <HypDrivMeta config={config} />
        <Speculation config={config} />
      </head>
      <body>
        <header className={css.props(layout.header)}>
          <a href="/" className={css.props(layout.brand)}>
            HypDriv × Purser
          </a>
          <nav className={css.props(layout.nav)}>
            <a href="/docs/themes" className={css.props(layout.navLink)}>
              Themes
            </a>
            <a href="/docs/guard" className={css.props(layout.navLink)}>
              Atom guard
            </a>
            <a href="/docs/audit" className={css.props(layout.navLink)}>
              Audit
            </a>
          </nav>
          <ThemeSwitch />
        </header>
        <main className={css.props(layout.main)}>{children}</main>
        <VitalsReporter />
        <HypDrivDevTools />
      </body>
    </html>
  );
}
