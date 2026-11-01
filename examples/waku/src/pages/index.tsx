import { Counter } from '../components/counter';

// Prerendered at build time (render: 'static'): served as built, with a hash-based CSP.
export default async function Home() {
  return (
    <>
      <title>Hypdriv on Waku</title>
      <h1>Hypdriv on Waku</h1>
      <p>
        This page is prerendered. Its Content-Security-Policy allows exactly the inline scripts of the built
        document by hash; the security headers, request id and Server-Timing come from Hypdriv.
      </p>
      <Counter />
      <ul>
        <li>
          <a href="/dynamic">/dynamic</a> renders per request and shows what <code>hyp()</code> knows.
        </li>
        <li>
          <a href="/api/hello">/api/hello</a> is an API route behind a rate limit.
        </li>
        <li>
          <a href="/_hypdriv/health">/_hypdriv/health</a> reports the runner and the build.
        </li>
      </ul>
    </>
  );
}

export const getConfig = async () => ({ render: 'static' }) as const;
