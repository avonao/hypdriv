import { connection } from 'next/server';
import { hyp } from '@hypdriv/next/server';

export default async function Dashboard() {
  await connection();
  const ctx = await hyp();
  return (
    <>
      <h1>Dashboard</h1>
      <p>Rendered per request with a nonce-based CSP.</p>
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
    </>
  );
}
