import {
  type GeoProperties,
  type HypDrivConfig,
  type HypDrivEnv,
  type ResolvedConfig,
  timingSafeEqual,
} from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  type HandleInput,
  type HypHandler,
  type ManifestSource,
  nonce as requestNonce,
} from '@hypdriv/runtime';
import { createMiddleware, type RequestMiddlewareAfterServer } from '@tanstack/react-start';
import { HOST_LABEL, MIN_TOKEN_LENGTH, PRERENDER_HEADER } from './constants';
import { renderedManifestSource } from './manifest';

/**
 * What the HypDriv request middleware adds to TanStack Start's request context: the request's CSP nonce (nonce
 * mode), read by `hypdrivSsr()` in `getRouter()` and by `getGlobalStartContext()` anywhere on the server.
 */
export interface HypDrivStartContext {
  nonce?: string;
}

/** The request middleware `hypdrivMiddleware()` returns. */
export type HypDrivRequestMiddleware = RequestMiddlewareAfterServer<
  Record<never, never>,
  undefined,
  HypDrivStartContext
>;

/**
 * The platform objects a Cloudflare Worker entry hands to Start (`handler.fetch(request, { context: { cloudflare:
 * { env, ctx } } })`; `createStartWorker()` does this).
 */
export interface CloudflareStartContext {
  cloudflare?: { env?: unknown; ctx?: { waitUntil(promise: Promise<unknown>): void } };
}

export interface CreateHypDrivMiddlewareOptions extends Omit<CreateHandlerOptions, 'config' | 'manifest'> {
  /** The HypDriv config (`virtual:hypdriv/config`). */
  config: HypDrivConfig | ResolvedConfig;
  /**
   * The build manifest (`() => import('virtual:hypdriv/manifest')`). The handler sees it through
   * `renderedManifest()`: pages that reach Start are rendered per request.
   */
  manifest?: ManifestSource;
  /**
   * The per-build prerender token (`virtual:hypdriv/tanstack-start`). Requests that carry it in
   * `x-hypdriv-prerender` are Start's own prerender requests and skip the pipeline, so no per-request nonce,
   * request id or flag ends up in a static document. Empty (development, deployed servers): never matches.
   */
  prerenderToken?: string;
}

/** Whether a request is one of the build's own prerender requests (the token is at least 32 characters). */
export function isPrerenderRequest(request: Request, token: string | undefined): boolean {
  if (!token || token.length < MIN_TOKEN_LENGTH) return false;
  const presented = request.headers.get(PRERENDER_HEADER);
  return presented !== null && timingSafeEqual(presented, token);
}

type PlatformRequest = Request & {
  ip?: unknown;
  waitUntil?: unknown;
  cf?: unknown;
  _request?: unknown;
};

/**
 * The platform's native `Request` behind Start's. On Node, Nitro hands Start srvx's lazy `NodeRequest`, which
 * passes `instanceof Request` but cannot be the input of `new Request()` (the pipeline forwards a copy with its
 * headers); srvx materialises the native request through `_request` (the same unwrapping srvx's own global
 * `Request` patch does), and both then share one body. Elsewhere the request is returned as is.
 */
export function nativeRequest(request: Request): Request {
  const inner = (request as PlatformRequest)._request;
  return inner instanceof Request ? inner : request;
}

/**
 * The platform facts Start's request exposes, as `createHandler` input: Nitro/srvx put the socket address on
 * `request.ip` and `waitUntil` on the request (Node, Vercel); a Worker entry passes `env` and `ctx` through the
 * Start context. Anything missing falls back inside `createHandler` (`cloudflare:workers`, Vercel's request
 * context, forwarded headers).
 */
export function platformInput(
  request: Request,
  context: unknown,
  config: ResolvedConfig,
): Pick<HandleInput, 'env' | 'waitUntil' | 'ip' | 'cf'> {
  const req = request as PlatformRequest;
  const out: Pick<HandleInput, 'env' | 'waitUntil' | 'ip' | 'cf'> = {};
  const cloudflare = (context as CloudflareStartContext | null | undefined)?.cloudflare;
  if (cloudflare?.env && typeof cloudflare.env === 'object') out.env = cloudflare.env as HypDrivEnv;
  const ctx = cloudflare?.ctx;
  if (ctx && typeof ctx.waitUntil === 'function') out.waitUntil = (promise) => ctx.waitUntil(promise);
  else if (typeof req.waitUntil === 'function') {
    const waitUntil = req.waitUntil as (promise: Promise<unknown>) => void;
    out.waitUntil = (promise) => waitUntil.call(req, promise);
  }
  // The socket address (srvx on Node; Nitro's Vercel runtime derives it from Vercel's own x-forwarded-for) is the
  // client unless the config says the server sits behind proxies, whose forwarded headers decide instead.
  if (typeof req.ip === 'string' && req.ip && config.security.trustedProxies === 0) out.ip = req.ip;
  if (req.cf && typeof req.cf === 'object') out.cf = req.cf as GeoProperties;
  return out;
}

/** A middleware plus the handler behind it (tests, custom hosts). */
export type HypDrivMiddlewareWithHandler = HypDrivRequestMiddleware & { readonly handler: HypHandler };

/**
 * Creates TanStack Start global request middleware that runs the HypDriv Drivetrain around everything Start
 * answers — SSR documents, server routes, server functions, not-found pages, redirects — with `createHandler`
 * (`runner: 'host'`), owning the full response: internal routes (`/_hypdriv/*`), the HTTPS upgrade, security
 * headers, the CSP (a per-request nonce handed to Start through `next({ context: { nonce } })`), rate limits,
 * the bot shield, geo, flags, redirects, maintenance mode, Early Hints, logging and `Server-Timing`. Inside
 * HypDriv's Cloudflare Worker shell (or the `@hypdriv/tanstack-start/server-entry` wrapper) the stages already
 * ran around the request: the middleware only forwards the nonce.
 *
 * Register it first in `requestMiddleware` (`src/start.ts`), so it also wraps the responses of the middleware
 * after it (CSRF rejections included).
 */
export function createHypDrivMiddleware(
  options: CreateHypDrivMiddlewareOptions,
): HypDrivMiddlewareWithHandler {
  const { config, manifest, prerenderToken, ...rest } = options;
  const handler = createHandler({
    ...rest,
    config,
    manifest: renderedManifestSource(manifest),
    host: rest.host ?? HOST_LABEL,
  });
  const middleware = createMiddleware({ type: 'request' }).server<HypDrivStartContext>(
    async ({ request, context, next }) => {
      // Start's own prerender requests render the static document exactly as the application does.
      if (isPrerenderRequest(request, prerenderToken)) return next();
      return handler(nativeRequest(request), {
        ...platformInput(request, context, handler.config),
        upstream: async () => {
          const current = requestNonce();
          const result = await next<HypDrivStartContext>(
            current ? { context: { nonce: current } } : undefined,
          );
          return result.response;
        },
      });
    },
  );
  Object.defineProperty(middleware, 'handler', { value: handler, enumerable: false });
  return middleware as HypDrivMiddlewareWithHandler;
}
