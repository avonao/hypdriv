import { hypFetch } from 'hypdriv';

/** Outbound fetch with timeout, retries and the circuit breaker. */
export async function GET() {
  const attempts: number[] = [];
  const started = Date.now();
  const res = await hypFetch('https://example.com/', {
    timeoutMs: 5000,
    retries: 1,
    onAttempt: (n) => void attempts.push(n),
  });
  // Not awaited: Next.js tees fetch bodies, and a cancel only settles once every branch is consumed.
  void res.body?.cancel().catch(() => undefined);
  return Response.json(
    { status: res.status, attempts, ms: Date.now() - started },
    { headers: { 'cache-control': 'no-store' } },
  );
}
