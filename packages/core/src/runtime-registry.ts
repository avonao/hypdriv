import type { HypDrivEnv } from './bindings';
import type { ResolvedConfig } from './config/resolved';
import type { DeployTarget } from './config/types';

/**
 * The process-wide HypDriv runtime: the resolved config and the (platform-augmented) environment. Request
 * code normally reads both from the request context; on hosts where `proxy.ts` and the rendering functions
 * run in different invocations (Vercel, some Node deployments), server helpers such as `enqueue()` fall
 * back to this registration. `createInstrumentation().register()` and `createProxy()` register it.
 */
export interface HypRuntime {
  config: ResolvedConfig;
  env: HypDrivEnv;
  target: DeployTarget;
}

const KEY = Symbol.for('hypdriv.runtime');

/** Registers the runtime for this process/isolate (the last registration wins). */
export function registerRuntime(runtime: HypRuntime | null): void {
  (globalThis as Record<symbol, unknown>)[KEY] = runtime ?? undefined;
}

/** The registered runtime, if any. */
export function getRuntime(): HypRuntime | undefined {
  return (globalThis as Record<symbol, unknown>)[KEY] as HypRuntime | undefined;
}

/**
 * The env key under which a platform exposes a producer for the HypDriv queue `name` when it has no
 * Cloudflare binding name (Vercel Queues through `vercelEnv`). `enqueue()` looks here after the binding.
 */
export function queueEnvKey(name: string): string {
  return `HYPDRIV_QUEUE:${name}`;
}

/**
 * `waitUntil` of the hosting platform outside a HypDriv request context: Vercel's request context
 * (`@vercel/functions` reads the same slot). `null` when the platform offers none.
 */
export function platformWaitUntil(): ((promise: Promise<unknown>) => void) | null {
  const slot = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
    | { get?: () => { waitUntil?: (promise: Promise<unknown>) => void } | undefined }
    | undefined;
  const waitUntil = slot?.get?.()?.waitUntil;
  return typeof waitUntil === 'function' ? (promise) => waitUntil(promise) : null;
}
