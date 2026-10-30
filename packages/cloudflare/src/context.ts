import { AsyncLocalStorage } from 'node:async_hooks';
import { getCurrentContext, type HypContext, setContextStore } from '@hypdriv/core';

const als = new AsyncLocalStorage<HypContext>();
let installed = false;

/** Installs the AsyncLocalStorage-backed context store once per isolate. */
export function installContextStore(): AsyncLocalStorage<HypContext> {
  if (!installed) {
    setContextStore({ getStore: () => als.getStore(), run: (ctx, fn) => als.run(ctx, fn) });
    installed = true;
  }
  return als;
}

/** The HypDriv request context for the current async flow inside the Worker (undefined outside a request). */
export function getHypContext(): HypContext | undefined {
  return getCurrentContext();
}

/** Runs `fn` with `ctx` as the current HypDriv context. */
export function runWithHypContext<T>(ctx: HypContext, fn: () => T): T {
  return installContextStore().run(ctx, fn);
}
