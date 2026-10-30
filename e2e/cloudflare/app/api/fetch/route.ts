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
  await res.body?.cancel();
  return Response.json(
    { status: res.status, attempts, ms: Date.now() - started },
    { headers: { 'cache-control': 'no-store' } },
  );
}
