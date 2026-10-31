import {
  type AsyncLocalStorageLike,
  type ContextStore,
  getContextStore,
  type HypContext,
  installAsyncContext,
} from '@hypdriv/core';

let pending: Promise<ContextStore | null> | null = null;

/**
 * Installs the `AsyncLocalStorage`-backed request-context store (once per isolate) so server helpers such as
 * `hyp()` see the request context anywhere below a HypDriv handler. `node:async_hooks` is imported lazily:
 * it exists on Node, Vercel Functions, Bun, Deno and Workers with `nodejs_compat`. Resolves to `null` on
 * runtimes without it; requests still run, only the ambient context is unavailable there.
 */
export function ensureContextStore(): Promise<ContextStore | null> {
  const existing = getContextStore();
  if (existing) return Promise.resolve(existing);
  pending ??= (async () => {
    try {
      const mod = (await import('node:async_hooks')) as {
        AsyncLocalStorage?: new () => AsyncLocalStorageLike<HypContext>;
      };
      const ALS =
        mod.AsyncLocalStorage ??
        (globalThis as { AsyncLocalStorage?: new () => AsyncLocalStorageLike<HypContext> }).AsyncLocalStorage;
      if (typeof ALS !== 'function') return null;
      return installAsyncContext(() => new ALS());
    } catch {
      const ALS = (globalThis as { AsyncLocalStorage?: new () => AsyncLocalStorageLike<HypContext> })
        .AsyncLocalStorage;
      return typeof ALS === 'function' ? installAsyncContext(() => new ALS()) : null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
