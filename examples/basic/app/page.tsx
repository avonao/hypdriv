import { flag, geo } from 'hypdriv/server';
import { Suspense } from 'react';

export default function Home() {
  return (
    <>
      <h1>Next.js 16 on Cloudflare Workers, hyper-extended.</h1>
      <p>
        This page is fully static: HypDriv serves it with a hash-based strict CSP, Early Hints for its
        stylesheet and scripts, Speculation Rules for the links below, and an edge cache in front of OpenNext.
      </p>
      <Suspense fallback={<p className="card">Loading your region…</p>}>
        <Personalised />
      </Suspense>
      <ul>
        <li>
          <a href="/blog/hello-world">Hello world (ISR, 60s)</a>
        </li>
        <li>
          <a href="/blog/second-post">Second post (ISR, 60s)</a>
        </li>
        <li>
          <a href="/dashboard">Dashboard (dynamic)</a>
        </li>
      </ul>
    </>
  );
}

async function Personalised() {
  const [where, newHero] = await Promise.all([geo(), flag('newHero', false)]);
  return (
    <p className="card">
      {newHero ? 'New hero enabled for you. ' : ''}
      Served near <strong>{where.city ?? 'you'}</strong>
      {where.country ? ` (${where.country})` : ''}.
    </p>
  );
}
