import type { HypContext } from './context';

/** Minimal AsyncLocalStorage-like store contract so core stays free of Node imports. */
export interface ContextStore {
  getStore(): HypContext | undefined;
  run<T>(ctx: HypContext, fn: () => T): T;
}

const KEY = Symbol.for('hypdriv.context-store');

/** Installs the per-isolate context store (the Worker shell does this with `AsyncLocalStorage`). */
export function setContextStore(store: ContextStore | null): void {
  (globalThis as Record<symbol, unknown>)[KEY] = store ?? undefined;
}

/** The installed context store, if any. */
export function getContextStore(): ContextStore | undefined {
  return (globalThis as Record<symbol, unknown>)[KEY] as ContextStore | undefined;
}

/** Structural `AsyncLocalStorage` (Node, workerd with `nodejs_compat`, Bun, Deno). */
export interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

/**
 * Installs an `AsyncLocalStorage`-backed context store once per isolate and returns the installed store.
 * The first installation wins, so the Worker shell, framework hooks and server helpers that share an
 * isolate always read the same storage (two storages would hide each other's contexts).
 */
export function installAsyncContext(create: () => AsyncLocalStorageLike<HypContext>): ContextStore {
  const existing = getContextStore();
  if (existing) return existing;
  const als = create();
  const store: ContextStore = { getStore: () => als.getStore(), run: (ctx, fn) => als.run(ctx, fn) };
  setContextStore(store);
  return store;
}

/** Returns the request context of the current async flow, when a store is installed. */
export function getCurrentContext(): HypContext | undefined {
  const store = (globalThis as Record<symbol, unknown>)[KEY] as ContextStore | undefined;
  return store?.getStore();
}

/** Runs `fn` with `ctx` as the current context (no-op wrapper when no store is installed). */
export function runWithContext<T>(ctx: HypContext, fn: () => T): T {
  const store = (globalThis as Record<symbol, unknown>)[KEY] as ContextStore | undefined;
  return store ? store.run(ctx, fn) : fn();
}

/**
 * Whether a response should be treated as an HTML document. Proxy runners only see a marker response
 * (`x-middleware-next`), so they fall back to the matched route's kind.
 */
export function isHtmlLike(ctx: HypContext, response: Response): boolean {
  const type = response.headers.get('content-type');
  if (type) return type.toLowerCase().includes('text/html');
  if (ctx.runner === 'proxy' && response.headers.has('x-middleware-next')) {
    const kind = ctx.route?.route.kind;
    return kind === 'app-page' || kind === 'page' || (!ctx.route && !ctx.url.pathname.startsWith('/api/'));
  }
  return false;
}
