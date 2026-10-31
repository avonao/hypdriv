/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import appCss from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'HypDriv × TanStack Start' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
  }),
  notFoundComponent: () => (
    <main>
      <h1>Not found</h1>
      <p>
        Nothing lives here. <Link to="/">Back home</Link>
      </p>
    </main>
  ),
  component: () => <Outlet />,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav>
          <Link to="/">Home</Link>
          <Link to="/about">About</Link>
          <Link to="/request">Request</Link>
          <Link to="/posts/$slug" params={{ slug: 'hello-world' }}>
            Post
          </Link>
        </nav>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
