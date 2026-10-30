import { HypDrivError } from '../util/errors';
import { SingleFlight } from '../util/singleflight';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMax: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

/** Per-origin circuit breaker. */
export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = 'closed';
  private openedAt = 0;
  private halfOpenInFlight = 0;

  constructor(
    private readonly options: CircuitBreakerOptions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get current(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.options.cooldownMs)
      this.state = 'half-open';
    return this.state;
  }

  /** Returns false when the call must be rejected immediately. */
  allow(): boolean {
    const s = this.current;
    if (s === 'closed') return true;
    if (s === 'half-open') {
      if (this.halfOpenInFlight >= this.options.halfOpenMax) return false;
      this.halfOpenInFlight++;
      return true;
    }
    return false;
  }

  success(): void {
    this.failures = 0;
    this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    this.state = 'closed';
  }

  failure(): void {
    this.failures++;
    this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    if (this.state === 'half-open' || this.failures >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}

export interface HypFetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  retryOn?: number[];
  backoff?: { baseMs: number; maxMs: number; jitter: boolean };
  /** Coalesce identical in-flight GET requests (default true for GET/HEAD). */
  dedupe?: boolean;
  /** Circuit breaker per origin (pass `false` to disable). */
  circuitBreaker?: CircuitBreakerOptions | false;
  /** `traceparent` to propagate. */
  traceparent?: string;
  /** Called before each attempt. */
  onAttempt?: (attempt: number, request: Request) => void;
  /** Underlying fetch (tests, service bindings). */
  fetch?: typeof fetch;
}

export interface HypFetchDefaults {
  timeoutMs: number;
  retries: number;
  retryOn: number[];
  backoff: { baseMs: number; maxMs: number; jitter: boolean };
  circuitBreaker: CircuitBreakerOptions | null;
}

const breakers = new Map<string, CircuitBreaker>();
const flight = new SingleFlight<Response>();

function breakerFor(origin: string, options: CircuitBreakerOptions): CircuitBreaker {
  let b = breakers.get(origin);
  if (!b) {
    b = new CircuitBreaker(options);
    breakers.set(origin, b);
  }
  return b;
}

/** For tests. */
export function __resetHypFetchState(): void {
  breakers.clear();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

function backoffDelay(attempt: number, backoff: { baseMs: number; maxMs: number; jitter: boolean }): number {
  const exp = Math.min(backoff.maxMs, backoff.baseMs * 2 ** attempt);
  return backoff.jitter ? Math.round(exp * (0.5 + Math.random() * 0.5)) : exp;
}

/**
 * `fetch` with timeout, retries with exponential backoff, request de-duplication and a per-origin
 * circuit breaker. Retries only idempotent methods unless `retryOn` explicitly includes the status
 * and the body is not a stream.
 */
export function createHypFetch(defaults: HypFetchDefaults) {
  return async function hypFetch(input: RequestInfo | URL, options: HypFetchOptions = {}): Promise<Response> {
    const {
      timeoutMs,
      retries,
      retryOn,
      backoff,
      dedupe,
      circuitBreaker,
      traceparent,
      onAttempt,
      fetch: fetchImpl,
      ...init
    } = options;
    const base = new Request(input, init);
    if (traceparent) base.headers.set('traceparent', traceparent);
    const method = base.method.toUpperCase();
    const idempotent =
      method === 'GET' ||
      method === 'HEAD' ||
      method === 'OPTIONS' ||
      method === 'PUT' ||
      method === 'DELETE';
    const canRetryBody =
      method === 'GET' ||
      method === 'HEAD' ||
      typeof init.body === 'string' ||
      init.body === undefined ||
      init.body === null;
    const maxRetries = idempotent && canRetryBody ? (retries ?? defaults.retries) : 0;
    const retryStatuses = new Set(retryOn ?? defaults.retryOn);
    const timeout = timeoutMs ?? defaults.timeoutMs;
    const bo = backoff ?? defaults.backoff;
    const cbOptions = circuitBreaker === false ? null : (circuitBreaker ?? defaults.circuitBreaker);
    const origin = new URL(base.url).origin;
    const breaker = cbOptions ? breakerFor(origin, cbOptions) : null;
    const doFetch = fetchImpl ?? fetch;

    const attemptOnce = async (attempt: number): Promise<Response> => {
      if (breaker && !breaker.allow())
        throw new HypDrivError('E_CIRCUIT_OPEN', `circuit open for ${origin}`, { origin });
      const controller = new AbortController();
      const onAbort = () => controller.abort(base.signal.reason);
      base.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () =>
          controller.abort(
            new HypDrivError('E_TIMEOUT', `fetch timed out after ${timeout}ms`, { url: base.url }),
          ),
        timeout,
      );
      try {
        const req = new Request(base, { signal: controller.signal });
        onAttempt?.(attempt, req);
        const res = await doFetch(req);
        if (res.status >= 500 || res.status === 429) breaker?.failure();
        else breaker?.success();
        return res;
      } catch (err) {
        breaker?.failure();
        throw err;
      } finally {
        clearTimeout(timer);
        base.signal.removeEventListener('abort', onAbort);
      }
    };

    const run = async (): Promise<Response> => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const res = await attemptOnce(attempt);
          if (attempt < maxRetries && retryStatuses.has(res.status)) {
            await res.body?.cancel().catch(() => undefined);
            const retryAfter = Number(res.headers.get('retry-after'));
            await sleep(
              Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, bo.maxMs)
                : backoffDelay(attempt, bo),
              base.signal,
            );
            continue;
          }
          return res;
        } catch (err) {
          lastError = err;
          if (err instanceof HypDrivError && err.code === 'E_CIRCUIT_OPEN') throw err;
          if (base.signal.aborted) throw err;
          if (attempt >= maxRetries) break;
          await sleep(backoffDelay(attempt, bo), base.signal);
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new HypDrivError('E_UPSTREAM', 'fetch failed', { url: base.url });
    };

    const shouldDedupe =
      (dedupe ?? (method === 'GET' || method === 'HEAD')) &&
      !base.headers.has('authorization') &&
      !base.headers.has('cookie');
    if (!shouldDedupe) return run();
    const key = `${method} ${base.url} ${base.headers.get('accept') ?? ''}`;
    const { promise } = flight.run(key, run);
    waiters.set(key, (waiters.get(key) ?? 0) + 1);
    // Every waiter registers its reaction before the master resolves, so clones are created
    // before any caller can lock the body. The last waiter receives the original response.
    return promise.then((res) => {
      const remaining = (waiters.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        waiters.delete(key);
        return res;
      }
      waiters.set(key, remaining);
      return res.clone();
    });
  };
}

const waiters = new Map<string, number>();

export const hypFetch = createHypFetch({
  timeoutMs: 10000,
  retries: 2,
  retryOn: [408, 425, 429, 500, 502, 503, 504],
  backoff: { baseMs: 100, maxMs: 2000, jitter: true },
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenMax: 1 },
});
