import type { Route } from './+types/home';

export function meta(_: Route.MetaArgs) {
  return [{ title: 'HypDriv × React Router' }];
}

// Prerendered at build time: served statically with the hash-based CSP and security headers HypDriv computed.
export default function Home() {
  return (
    <section>
      <h1>HypDriv × React Router</h1>
      <p>
        This page is prerendered. Its scripts are allowed by their build-time hashes; the request facts page
        renders per request with a nonce.
      </p>
    </section>
  );
}
