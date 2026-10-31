import { hypdrivMiddleware } from '@hypdriv/react-router/server';
import { isRouteErrorResponse, Links, Meta, NavLink, Outlet, Scripts, ScrollRestoration } from 'react-router';
import type { Route } from './+types/root';
import './app.css';

// The Drivetrain around every request React Router routes: documents, `.data`, actions and resource routes. Inside
// HypDriv's Worker entry, Node server or Vercel function it only exposes the request context (they already ran it).
export const middleware: Route.MiddlewareFunction[] = [hypdrivMiddleware()];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <Meta />
        <Links />
      </head>
      <body>
        <nav>
          <NavLink to="/">Home</NavLink>
          <NavLink to="/about">About</NavLink>
          <NavLink to="/ssr">Request facts</NavLink>
          <a href="/api/hello">API</a>
        </nav>
        <main>{children}</main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message =
    status === 404
      ? 'This page does not exist.'
      : status === 429
        ? 'Slow down a little.'
        : 'Something went wrong.';
  return (
    <section>
      <h1>{status}</h1>
      <p>{message}</p>
    </section>
  );
}
