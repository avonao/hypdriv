import { flag, geo } from 'hypdriv/server';
import { Suspense } from 'react';
import { listProducts } from '@/lib/catalog';

export default async function Home() {
  const products = await listProducts();
  return (
    <>
      <h1>Next.js 16 on Vercel, hyper-extended.</h1>
      <p>
        The shell of this page is prerendered: Vercel serves it from its CDN, HypDriv adds a strict CSP,
        Speculation Rules for the links below and per-visitor geo and flags in the streamed part.
      </p>
      <Suspense fallback={<p className="card">Loading your region…</p>}>
        <Personalised />
      </Suspense>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            <a href={`/products/${p.id}`}>{p.name}</a> (CDN-cached by the <code>products</code> policy)
          </li>
        ))}
        <li>
          <a href="/api/products">/api/products</a> (Route Handler wrapped with <code>withVercelCdn</code>)
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
