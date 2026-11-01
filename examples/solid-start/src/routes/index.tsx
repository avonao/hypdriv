import { A } from '@solidjs/router';

// Prerendered at build time (vite.config.ts `nitro.prerender.routes`): served as a static file with a hash-based
// Content-Security-Policy.
export default function Home() {
  return (
    <main>
      <h1>Hypdriv × SolidStart</h1>
      <p>
        This page is prerendered. Its security headers and its hash-based Content-Security-Policy come from
        the platform's static configuration (Vercel Build Output routes) or from the Hypdriv pipeline in front
        of Nitro's static files (Node).
      </p>
      <p>
        <A href="/request">See what Hypdriv knows about this request</A>
      </p>
    </main>
  );
}
