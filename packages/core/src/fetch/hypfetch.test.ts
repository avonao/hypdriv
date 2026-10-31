import { afterEach, describe, expect, it } from 'vitest';
import { __resetHypFetchState, CircuitBreaker, createHypFetch } from './hypfetch';

const defaults = {
  timeoutMs: 200,
  retries: 2,
  retryOn: [500, 503],
  backoff: { baseMs: 1, maxMs: 5, jitter: false },
  circuitBreaker: { failureThreshold: 3, cooldownMs: 50, halfOpenMax: 1 },
};

afterEach(() => __resetHypFetchState());

describe('hypFetch', () => {
  it('retries retryable statuses and returns the final response', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls < 3 ? new Response('x', { status: 503 }) : new Response('ok');
    }) as typeof fetch;
    const hf = createHypFetch(defaults);
    const res = await hf('https://api.test/a', { fetch: fetchImpl, dedupe: false });
    expect(await res.text()).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry non-idempotent requests with stream bodies', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('x', { status: 503 });
    }) as typeof fetch;
    const hf = createHypFetch(defaults);
    const res = await hf('https://api.test/a', {
      method: 'POST',
      body: new ReadableStream(),
      duplex: 'half',
      fetch: fetchImpl,
    } as never);
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });

  it('times out', async () => {
    const fetchImpl = ((req: Request) =>
      new Promise<Response>((_resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason));
      })) as unknown as typeof fetch;
    const hf = createHypFetch({ ...defaults, retries: 0, timeoutMs: 10 });
    await expect(hf('https://slow.test/', { fetch: fetchImpl, dedupe: false })).rejects.toMatchObject({
      code: 'E_TIMEOUT',
    });
  });

  it('enforces the timeout when the fetch implementation ignores the abort signal', async () => {
    let late: Response | null = null;
    let calls = 0;
    // A wrapper that drops the signal (as some platform instrumentation does) and answers after 1 s.
    const fetchImpl = ((input: Request) => {
      calls++;
      const url = input.url;
      return new Promise<Response>((resolve) =>
        setTimeout(() => {
          late = new Response(new ReadableStream({ pull: () => undefined }), { headers: { 'x-url': url } });
          resolve(late);
        }, 1000),
      );
    }) as unknown as typeof fetch;
    const hf = createHypFetch({ ...defaults, timeoutMs: 50, retries: 1 });
    const started = Date.now();
    await expect(hf('https://api.test/slow', { fetch: fetchImpl, dedupe: false })).rejects.toMatchObject({
      code: 'E_TIMEOUT',
    });
    expect(Date.now() - started).toBeLessThan(800);
    expect(calls).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // The late response's body was cancelled, not leaked.
    expect((late as Response | null)?.bodyUsed || (late as Response | null)?.body?.locked).toBe(true);
  });

  it('settles on the caller abort even when the fetch implementation ignores signals', async () => {
    const fetchImpl = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const hf = createHypFetch({ ...defaults, timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = hf('https://api.test/hang', {
      fetch: fetchImpl,
      dedupe: false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('caller gave up')), 20);
    await expect(pending).rejects.toThrow('caller gave up');
  });

  it('retries without waiting for a body cancel that never settles (Next.js patched fetch)', async () => {
    let calls = 0;
    // A teed body (what Next.js's fetch returns) only finishes cancelling once every branch is consumed.
    const stuckBody = () =>
      new ReadableStream({ pull: () => undefined, cancel: () => new Promise<void>(() => undefined) });
    const fetchImpl = (async () => {
      calls++;
      return calls < 2 ? new Response(stuckBody(), { status: 503 }) : new Response('ok');
    }) as typeof fetch;
    const hf = createHypFetch({ ...defaults, timeoutMs: 1000 });
    const res = await hf('https://api.test/flaky', { fetch: fetchImpl, dedupe: false });
    expect(await res.text()).toBe('ok');
    expect(calls).toBe(2);
  });

  it('dedupes concurrent GETs and gives each caller a readable body', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ n: calls }));
    }) as typeof fetch;
    const hf = createHypFetch(defaults);
    const [a, b, c] = await Promise.all([
      hf('https://api.test/d', { fetch: fetchImpl }),
      hf('https://api.test/d', { fetch: fetchImpl }),
      hf('https://api.test/d', { fetch: fetchImpl }),
    ]);
    expect(calls).toBe(1);
    expect(await Promise.all([a.json(), b.json(), c.json()])).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }]);
  });

  it('opens the circuit after repeated failures', async () => {
    const fetchImpl = (async () => new Response('down', { status: 500 })) as typeof fetch;
    const hf = createHypFetch({ ...defaults, retries: 0 });
    for (let i = 0; i < 3; i++) await hf('https://down.test/', { fetch: fetchImpl, dedupe: false });
    await expect(hf('https://down.test/', { fetch: fetchImpl, dedupe: false })).rejects.toMatchObject({
      code: 'E_CIRCUIT_OPEN',
    });
  });
});

describe('CircuitBreaker', () => {
  it('transitions closed → open → half-open → closed', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, halfOpenMax: 1 }, () => t);
    expect(cb.allow()).toBe(true);
    cb.failure();
    cb.failure();
    expect(cb.current).toBe('open');
    expect(cb.allow()).toBe(false);
    t = 150;
    expect(cb.current).toBe('half-open');
    expect(cb.allow()).toBe(true);
    expect(cb.allow()).toBe(false);
    cb.success();
    expect(cb.current).toBe('closed');
  });
});
