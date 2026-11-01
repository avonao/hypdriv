import type { ReactNode } from 'react';
import '../styles.css';

export default async function Root({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Hypdriv on Waku</title>
        <meta
          name="description"
          content="The Hypdriv Drivetrain around a Waku app on Cloudflare Workers, Vercel and Node."
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

export const getConfig = async () => ({ render: 'static' }) as const;
