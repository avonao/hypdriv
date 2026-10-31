import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Hypdriv on vinext',
  description:
    'The Hypdriv Drivetrain around a vinext App Router app on Cloudflare Workers, Vercel and Node.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <nav>
            <a href="/">Home</a> · <a href="/about">About</a> · <a href="/dynamic">Request facts</a> ·{' '}
            <a href="/api/hello">API</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
