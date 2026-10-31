import { AsyncLocalStorage } from 'node:async_hooks';
import { type ContextStore, getCurrentContext, type HypContext, installAsyncContext } from '@hypdriv/core';

/** Installs the AsyncLocalStorage-backed context store once per isolate (shared with framework hooks). */
export function installContextStore(): ContextStore {
  return installAsyncContext(() => new AsyncLocalStorage<HypContext>());
}

/** The HypDriv request context for the current async flow inside the Worker (undefined outside a request). */
export function getHypContext(): HypContext | undefined {
  return getCurrentContext();
}

/** Runs `fn` with `ctx` as the current HypDriv context. */
export function runWithHypContext<T>(ctx: HypContext, fn: () => T): T {
  return installContextStore().run(ctx, fn);
}
