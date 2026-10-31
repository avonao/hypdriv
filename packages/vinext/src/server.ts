import type { FlagValue } from '@hypdriv/core';
import {
  type HypRequestContext,
  devtoolsMeta as runtimeDevtoolsMeta,
  flag as runtimeFlag,
  geo as runtimeGeo,
  hyp as runtimeHyp,
  nonce as runtimeNonce,
  requireHyp as runtimeRequireHyp,
} from '@hypdriv/runtime';
import { unstable_noStore } from 'vinext/shims/cache';

/**
 * `@hypdriv/vinext/server` — Hypdriv's request context for Server Components, Route Handlers, Server Actions
 * and `proxy.ts` in a vinext app (`hyp()` reads the AsyncLocalStorage context of the request hook the Hypdriv
 * plugin installs).
 *
 * The request-scoped readers (`hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `devtoolsMeta`) are dynamic APIs,
 * like `headers()`: calling one during a render opts the page out of prerendering and vinext's page cache, so
 * a request id, a nonce or a flag value is never cached for other visitors.
 */

export {
  defer,
  type HypRequestContext,
  type JobHandlerOptions,
  type JobInput,
  jobHandler,
} from '@hypdriv/runtime';

/** Marks the current render dynamic (no-op outside a render and inside `unstable_cache`). */
function dynamic(): void {
  try {
    unstable_noStore();
  } catch {
    // Not inside a vinext render.
  }
}

/** The Hypdriv request context of the current request, or `null` outside one (build-time prerendering). */
export function hyp(): HypRequestContext | null {
  dynamic();
  return runtimeHyp();
}

/** Like `hyp()`, but throws when called outside a Hypdriv request. */
export function requireHyp(): HypRequestContext {
  dynamic();
  return runtimeRequireHyp();
}

/** The CSP nonce of the current request (nonce mode), for `<script nonce>` / `<Script nonce>` tags. */
export function nonce(): string | undefined {
  dynamic();
  return runtimeNonce();
}

/** Reads an edge-evaluated feature flag of the current request. */
export function flag<T extends FlagValue>(name: string, fallback: T): T;
export function flag(name: string): FlagValue | undefined;
export function flag(name: string, fallback?: FlagValue): FlagValue | undefined {
  dynamic();
  return fallback === undefined ? runtimeFlag(name) : runtimeFlag(name, fallback);
}

/** Geo information for the current request. */
export function geo(): ReturnType<typeof runtimeGeo> {
  dynamic();
  return runtimeGeo();
}

/** Request facts for the DevTools HUD's `<meta name="hypdriv:*">` tags. */
export function devtoolsMeta(...args: Parameters<typeof runtimeDevtoolsMeta>): Record<string, string> {
  dynamic();
  return runtimeDevtoolsMeta(...args);
}
