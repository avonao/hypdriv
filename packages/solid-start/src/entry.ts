import type { GeoProperties, HypDrivEnv, ResolvedConfig } from '@hypdriv/core';
import type { HandleInput } from '@hypdriv/runtime';

/**
 * The request as Nitro (srvx) hands it over: a `Request` plus the platform facts srvx attaches (`ip`, `waitUntil`,
 * `runtime`, `context`). On Node srvx's `NodeRequest` is lazy and wraps a native request in `_request`.
 */
export type PlatformRequest = Request & {
  ip?: unknown;
  waitUntil?: unknown;
  cf?: unknown;
  runtime?: unknown;
  context?: unknown;
  _request?: unknown;
};

/** Properties srvx puts on a request that SolidStart, h3 and Nitro read; the forwarded request carries them over. */
const CARRIED = ['ip', 'waitUntil', 'runtime', 'context', 'cf'] as const;

/**
 * The platform's native `Request` behind Nitro's. On Node, srvx's lazy `NodeRequest` passes `instanceof Request` but
 * cannot be the input of `new Request()` (the pipeline forwards a copy with its headers); srvx materialises the
 * native request through `_request` (the same unwrapping srvx's own global `Request` patch does), and both then
 * share one body. Elsewhere the request is returned as is.
 */
export function nativeRequest(request: Request): Request {
  const inner = (request as PlatformRequest)._request;
  return inner instanceof Request ? inner : request;
}

/**
 * Copies the platform facts of the incoming request (`ip`, `waitUntil`, `runtime` with the Node socket or the
 * Cloudflare bindings, `context`, `cf`) onto the request the pipeline forwards, so the application — SolidStart's
 * `event.clientAddress`, Nitro's `waitUntil`, early hints on the Node socket — sees what it would without Hypdriv.
 */
export function carryPlatformFacts(from: Request, to: Request): Request {
  if (from === to) return to;
  for (const key of CARRIED) {
    const value = (from as PlatformRequest)[key];
    if (value === undefined || key in (to as object)) continue;
    try {
      Object.defineProperty(to, key, { value, configurable: true, writable: true, enumerable: false });
    } catch {
      // a frozen request: the application does without the extra fact
    }
  }
  return to;
}

interface CloudflareRuntime {
  env?: unknown;
  context?: { waitUntil?: (promise: Promise<unknown>) => void };
}

/**
 * The platform facts Nitro's request exposes, as `createHandler` input: srvx puts the socket address on
 * `request.ip` and `waitUntil` on the request (Node, Vercel); a Cloudflare worker built by Nitro passes `env` and
 * the execution context through `request.runtime.cloudflare`. Anything missing falls back inside `createHandler`
 * (`cloudflare:workers`, Vercel's request context, forwarded headers).
 */
export function platformInput(
  request: Request,
  config: ResolvedConfig,
): Pick<HandleInput, 'env' | 'waitUntil' | 'ip' | 'cf'> {
  const req = request as PlatformRequest;
  const out: Pick<HandleInput, 'env' | 'waitUntil' | 'ip' | 'cf'> = {};
  const cloudflare = (req.runtime as { cloudflare?: CloudflareRuntime } | undefined)?.cloudflare;
  if (cloudflare?.env && typeof cloudflare.env === 'object') out.env = cloudflare.env as HypDrivEnv;
  const ctx = cloudflare?.context;
  if (ctx && typeof ctx.waitUntil === 'function') {
    const waitUntil = ctx.waitUntil;
    out.waitUntil = (promise) => waitUntil.call(ctx, promise);
  } else if (typeof req.waitUntil === 'function') {
    const waitUntil = req.waitUntil as (promise: Promise<unknown>) => void;
    out.waitUntil = (promise) => waitUntil.call(req, promise);
  }
  // The socket address (srvx on Node; Nitro's Vercel runtime derives it from Vercel's own x-forwarded-for) is the
  // client unless the config says the server sits behind proxies, whose forwarded headers decide instead.
  if (typeof req.ip === 'string' && req.ip && config.security.trustedProxies === 0) out.ip = req.ip;
  if (req.cf && typeof req.cf === 'object') out.cf = req.cf as GeoProperties;
  return out;
}
