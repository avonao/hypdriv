import { hypFetch } from 'hypdriv';

/**
 * Requests from the function to its own deployment pass Vercel Deployment Protection with the automation
 * bypass (Vercel exposes `VERCEL_AUTOMATION_BYPASS_SECRET` to the deployment once a bypass exists).
 */
function selfHeaders(): Record<string, string> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return bypass ? { 'x-vercel-protection-bypass': bypass } : {};
}

/**
 * `?mode=signal`: does the runtime's `fetch` honour an abort signal (init vs. Request) against a hanging
 * upstream? Each probe is capped at 8 s by a race, so the route always answers.
 */
async function signalProbe(origin: string) {
  const target = `${origin}/api/slow?ms=9000`;
  const probe = async (useRequest: boolean) => {
    const started = Date.now();
    const signal = AbortSignal.timeout(1000);
    const headers = selfHeaders();
    const call = useRequest
      ? fetch(new Request(target, { signal, headers }))
      : fetch(target, { signal, headers });
    const outcome = await Promise.race([
      call.then(
        (r) => {
          void r.body?.cancel().catch(() => undefined);
          return `answered ${r.status}`;
        },
        (e: Error) => `aborted (${e.name})`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending after 8 s'), 8000)),
    ]);
    return { outcome, ms: Date.now() - started };
  };
  const [init, requestInput] = await Promise.all([probe(false), probe(true)]);
  return Response.json({ init, request: requestInput }, { headers: { 'cache-control': 'no-store' } });
}

/**
 * `?mode=net&host=`: DNS answers and a raw fetch to an external host (both capped at 8 s), plus how late a
 * 100 ms timer fires meanwhile — tells a slow network from a blocked event loop.
 */
async function netProbe(host: string) {
  const cap = <T>(p: Promise<T>, label: string) =>
    Promise.race([
      p,
      new Promise<string>((resolve) => setTimeout(() => resolve(`${label}: pending after 8 s`), 8000)),
    ]);
  const lag = new Promise<number>((resolve) => {
    const started = Date.now();
    setTimeout(() => resolve(Date.now() - started), 100);
  });
  const dnsStarted = Date.now();
  const { lookup } = await import('node:dns/promises');
  const dns = await cap(
    lookup(host, { all: true }).then(
      (a) =>
        `${a.map((x) => `${x.family === 6 ? 'v6' : 'v4'}:${x.address}`).join(' ')} in ${Date.now() - dnsStarted} ms`,
      (e: Error) => `error ${e.message}`,
    ),
    'dns',
  );
  const fetchStarted = Date.now();
  const raw = await cap(
    fetch(`https://${host}/`, { signal: AbortSignal.timeout(5000), redirect: 'manual' }).then(
      (r) => {
        void r.body?.cancel().catch(() => undefined);
        return `${r.status} in ${Date.now() - fetchStarted} ms`;
      },
      (e: Error) =>
        `${e.name}: ${(e.cause as Error | undefined)?.message ?? e.message} after ${Date.now() - fetchStarted} ms`,
    ),
    'fetch',
  );
  return Response.json(
    { host, dns, fetch: raw, timerLagMs: (await lag) - 100 },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Outbound fetch with timeout, retries and the circuit breaker.
 * - default: a small public endpoint (status, attempts, time to headers);
 * - `?mode=timeout`: an upstream (this deployment's `/api/slow`) that answers after 8 s, with a 1.5 s timeout
 *   and one retry → `E_TIMEOUT`;
 * - `?mode=signal`, `?mode=net&host=`: platform diagnostics (see above).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  if (mode === 'signal') return signalProbe(url.origin);
  if (mode === 'net') return netProbe(url.searchParams.get('host') ?? 'example.com');
  const timeoutMode = mode === 'timeout';
  const target = timeoutMode ? `${url.origin}/api/slow?ms=8000` : 'https://www.cloudflare.com/cdn-cgi/trace';
  const attempts: number[] = [];
  const started = Date.now();
  try {
    const res = await hypFetch(target, {
      timeoutMs: timeoutMode ? 1500 : 5000,
      retries: 1,
      dedupe: false,
      ...(timeoutMode ? { headers: selfHeaders() } : {}),
      onAttempt: (n) => void attempts.push(n),
    });
    const headersMs = Date.now() - started;
    // Not awaited: Next.js tees fetch bodies, and a cancel only settles once every branch is consumed.
    void res.body?.cancel().catch(() => undefined);
    return Response.json(
      { status: res.status, attempts, headersMs, ms: Date.now() - started },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return Response.json(
      { error: e.code ?? 'error', message: e.message ?? String(error), attempts, ms: Date.now() - started },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
