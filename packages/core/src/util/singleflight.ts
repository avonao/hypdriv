/**
 * Request coalescing: concurrent callers of `run(key, fn)` share one in-flight promise.
 * Entries are removed when the promise settles, so a later call starts fresh work.
 */
export class SingleFlight<T = unknown> {
  private readonly inflight = new Map<string, Promise<T>>();

  get size(): number {
    return this.inflight.size;
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  run(key: string, fn: () => Promise<T>): { promise: Promise<T>; shared: boolean } {
    const existing = this.inflight.get(key);
    if (existing) return { promise: existing, shared: true };
    let settled = false;
    const holder: { promise?: Promise<T> } = {};
    const cleanup = () => {
      settled = true;
      if (holder.promise && this.inflight.get(key) === holder.promise) this.inflight.delete(key);
    };
    holder.promise = (async () => {
      try {
        return await fn();
      } finally {
        cleanup();
      }
    })();
    if (!settled) this.inflight.set(key, holder.promise);
    return { promise: holder.promise, shared: false };
  }

  /** Forget an in-flight entry without cancelling it (used on errors that should not be shared further). */
  forget(key: string): void {
    this.inflight.delete(key);
  }
}

/** Memoises an async factory per key with a TTL; concurrent misses coalesce. */
export function memoizeAsync<T>(
  fn: (key: string) => Promise<T>,
  ttlMs: number,
  now: () => number = () => Date.now(),
) {
  const values = new Map<string, { value: T; expiresAt: number }>();
  const flight = new SingleFlight<T>();
  return {
    async get(key: string): Promise<T> {
      const hit = values.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;
      const { promise } = flight.run(key, async () => {
        const value = await fn(key);
        values.set(key, { value, expiresAt: now() + ttlMs });
        return value;
      });
      return promise;
    },
    invalidate(key?: string) {
      if (key === undefined) values.clear();
      else values.delete(key);
    },
  };
}
