import { component$ } from '@qwik.dev/core';
import type { DocumentHead } from '@qwik.dev/router';
import { Counter } from '../components/counter';

// Prerendered at build time (static generation): served as built, with a hash-based CSP.
export default component$(() => (
  <>
    <h1>Hypdriv on Qwik</h1>
    <p>
      This page is prerendered. Its Content-Security-Policy allows exactly the inline scripts of the built
      document by hash; the security headers, request id and Server-Timing come from Hypdriv.
    </p>
    <Counter />
    <ul>
      <li>
        <a href="/dynamic/">/dynamic/</a> renders per request and shows what <code>hyp()</code> knows.
      </li>
      <li>
        <a href="/blog/hello/">/blog/hello/</a> is one of the prerendered paths of a dynamic route.
      </li>
      <li>
        <a href="/api/hello">/api/hello</a> is an endpoint behind a rate limit.
      </li>
      <li>
        <a href="/_hypdriv/health">/_hypdriv/health</a> reports the runner and the build.
      </li>
    </ul>
  </>
));

export const head: DocumentHead = {
  title: 'Hypdriv on Qwik',
  meta: [{ name: 'description', content: 'Qwik Router behind the Hypdriv Drivetrain.' }],
};
