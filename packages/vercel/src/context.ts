import { type DeployTarget, detectDeployTarget } from '@hypdriv/core';

/** The global symbol under which Vercel's runtime exposes the per-request context. */
export const VERCEL_REQUEST_CONTEXT: symbol = Symbol.for('@vercel/request-context');

/** Options of a tag delete on Vercel's CDN. */
export interface VercelDeleteOptions {
  /** Seconds during which stale content is still served while revalidating (default 0: delete now). */
  revalidationDeadlineSeconds?: number;
}

/** The purge API of the Vercel request context (what `@vercel/functions` `invalidateByTag` calls). */
export interface VercelPurgeApi {
  invalidateByTag(tag: string | string[]): Promise<void>;
  dangerouslyDeleteByTag(tag: string | string[], options?: VercelDeleteOptions): Promise<void>;
  invalidateBySrcImage?(src: string | string[]): Promise<void>;
  dangerouslyDeleteBySrcImage?(src: string | string[], options?: VercelDeleteOptions): Promise<void>;
}

/**
 * The per-request context Vercel's runtime installs for Functions and Routing Middleware
 * (`globalThis[Symbol.for('@vercel/request-context')].get()`, the shape `@vercel/functions` 3.x reads).
 */
export interface VercelRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void;
  /** ISO timestamp of the invocation deadline. */
  deadline?: string;
  purge?: VercelPurgeApi;
  /** Adds cache tags to the current response (`addCacheTag` of `@vercel/functions`). */
  addCacheTag?: (tag: string | string[]) => Promise<void>;
  /** Headers of the current request. */
  headers?: Record<string, string>;
  /** Runtime cache (`getCache` of `@vercel/functions`); left untyped here. */
  cache?: unknown;
}

/**
 * The current Vercel request context, or `null` outside a Vercel Function / Routing Middleware invocation
 * (local `next dev`, other hosts, or code running outside a request).
 */
export function vercelRequestContext(): VercelRequestContext | null {
  const holder = (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] as
    | { get?: () => VercelRequestContext | undefined }
    | undefined;
  try {
    const context = holder?.get?.();
    return context && typeof context === 'object' ? context : null;
  } catch {
    return null;
  }
}

/**
 * `true` when the application runs on Vercel: an explicit `platform` wins, otherwise `VERCEL=1`,
 * `NEXT_EDGE_RUNTIME_PROVIDER=vercel` or the Vercel request context decide (core `detectDeployTarget`).
 */
export function isVercel(env?: Record<string, unknown>, platform: 'auto' | DeployTarget = 'auto'): boolean {
  return detectDeployTarget(env, platform) === 'vercel';
}
