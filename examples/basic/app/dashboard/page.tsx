import { hyp } from 'hypdriv/server';
import { Suspense } from 'react';

export default function Dashboard() {
  return (
    <>
      <h1>Dashboard</h1>
      <p>The heading is prerendered; the request details below stream per request (nonce-based CSP).</p>
      <Suspense fallback={<p className="card">Loading request details…</p>}>
        <RequestDetails />
      </Suspense>
    </>
  );
}

async function RequestDetails() {
  const ctx = await hyp();
  return (
    <dl className="card">
      <dt>Request id</dt>
      <dd>{ctx.requestId ?? 'n/a'}</dd>
      <dt>Runner</dt>
      <dd>{ctx.runner ?? 'next'}</dd>
      <dt>Country</dt>
      <dd>{ctx.country ?? 'unknown'}</dd>
      <dt>Flags</dt>
      <dd>{JSON.stringify(ctx.flags)}</dd>
    </dl>
  );
}
