import { createFileRoute, Link } from '@tanstack/react-router';

// Prerendered at build time (vite.config.ts `pages`): served as a static file with a hash-based CSP.
export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <main>
      <h1>HypDriv × TanStack Start</h1>
      <p>
        This page is prerendered. Its security headers and its hash-based Content-Security-Policy come from
        the platform's static configuration (Cloudflare <code>_headers</code>, Vercel Build Output routes).
      </p>
      <p>
        <Link to="/request">See what HypDriv knows about this request</Link>
      </p>
    </main>
  );
}
