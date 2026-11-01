import {
  type GeoProperties,
  type HypDrivConfig,
  type HypDrivEnv,
  normalizeIp,
  type ResolvedConfig,
} from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  type HandleInput,
  type HypHandler,
  type ManifestSource,
  REVALIDATE_HEADER,
  nonce as requestNonce,
} from '@hypdriv/runtime';
import type { Context, MiddlewareHandler } from 'hono';
import { type HonoRoutesSource, honoManifest } from './manifest';

/** The label reported in logs and `/_hypdriv/health`. */
export const HOST_LABEL = 'hono';

/** Variables the Hypdriv middleware sets on the Hono context (`c.get('hypdrivNonce')`). */
export interface HypDrivHonoVariables {
  /** The request's CSP nonce (nonce mode), for `<script nonce>` tags the app renders itself. */
  hypdrivNonce?: string;
}

export interface HypDrivHonoOptions extends Omit<CreateHandlerOptions, 'config' | 'manifest' | 'host'> {
  /** The Hypdriv config (`defineConfig({...})`). */
  config: HypDrivConfig | ResolvedConfig;
  /** A manifest, or a loader; default: none (use `useHypDriv(app)` or `honoManifest(app)` to derive it from the routes). */
  manifest?: ManifestSource;
  /** The framework label (default `hono`). */
  host?: string;
  /** Paths of apps mounted with `app.mount()`, listed in the derived manifest as endpoints (see `honoManifest`). */
  mounted?: readonly string[];
  /**
   * The Hono app behind the middleware (`useHypDriv(app)` sets it). Background revalidation
   * (stale-while-revalidate) renders through `app.fetch`, because the request that served the stale entry is
   * long finished by then.
   */
  app?: AppFetch;
}

/** The part of a Hono app the middleware calls for background revalidation. */
export interface AppFetch {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}

/** A middleware plus the handler behind it (tests, custom hosts). */
export type HypDrivHonoMiddleware = MiddlewareHandler & { readonly handler: HypHandler };

interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
}

/**
 * What the server runtimes hand to `fetch` as its second argument instead of an environment:
 * `@hono/node-server` passes `{ incoming, outgoing }`, `Bun.serve` its `server` (with `requestIP()`), `Deno.serve`
 * a `{ remoteAddr, completed }` info object. They carry the socket address and no bindings.
 */
interface ConnectionBindings {
  incoming?: { socket?: { remoteAddress?: string } };
  outgoing?: unknown;
  requestIP?: (request: Request) => { address?: string } | null | undefined;
  remoteAddr?: { hostname?: string; transport?: string };
  completed?: unknown;
}

function isConnectionBindings(env: unknown): env is ConnectionBindings {
  if (typeof env !== 'object' || env === null) return false;
  const e = env as ConnectionBindings;
  return (
    ('incoming' in e && 'outgoing' in e) ||
    typeof e.requestIP === 'function' ||
    (typeof e.remoteAddr === 'object' && e.remoteAddr !== null && 'completed' in e)
  );
}

function socketAddress(env: ConnectionBindings, request: Request): string | undefined {
  if (env.incoming) return env.incoming.socket?.remoteAddress;
  if (typeof env.requestIP === 'function') {
    try {
      return env.requestIP(request)?.address;
    } catch {
      return undefined;
    }
  }
  return env.remoteAddr?.hostname;
}

/**
 * The platform facts a Hono call exposes, as `createHandler` input: Cloudflare bindings and `ctx.waitUntil`, the
 * socket address on Node, Bun and Deno (used unless the config says the server sits behind proxies, whose
 * forwarded headers decide instead), `request.cf`. Anything missing falls back inside `createHandler`
 * (`process.env`, Vercel's request context, forwarded headers).
 */
export function platformInput(
  request: Request,
  env: unknown,
  ctx: ExecutionContextLike | undefined,
  config: ResolvedConfig,
): Pick<HandleInput, 'env' | 'waitUntil' | 'ip' | 'cf'> {
  const out: Pick<HandleInput, 'env' | 'waitUntil' | 'ip' | 'cf'> = {};
  if (isConnectionBindings(env)) {
    const address = socketAddress(env, request);
    if (address && config.security.trustedProxies === 0) out.ip = normalizeIp(address);
  } else if (env && typeof env === 'object') {
    out.env = env as HypDrivEnv;
  }
  if (ctx && typeof ctx.waitUntil === 'function') {
    const waitUntil = ctx.waitUntil.bind(ctx);
    out.waitUntil = (promise) => waitUntil(promise);
  }
  const cf = (request as Request & { cf?: unknown }).cf;
  if (cf && typeof cf === 'object') out.cf = cf as GeoProperties;
  return out;
}

function executionContext(c: Context): ExecutionContextLike | undefined {
  try {
    return c.executionCtx;
  } catch {
    // Hono throws when the runtime has no execution context (Node, Bun, Deno, Vercel).
    return undefined;
  }
}

/**
 * Replaces the context's response. `Context#res` merges the previous response's headers into a new one, which
 * would put the application's own header values back over the ones the Drivetrain just decided (a rewritten
 * `Cache-Control`, a security header); clearing it first makes the Drivetrain's response the response.
 */
function replaceResponse(c: Context, response: Response): void {
  (c as { res: Response | undefined }).res = undefined;
  c.res = response;
}

/**
 * Hono middleware that runs the Hypdriv Drivetrain around everything the app answers — pages, API routes,
 * not-found responses, errors — with `createHandler` (`runner: 'host'`), owning the full response: internal
 * routes (`/_hypdriv/*`), the HTTPS upgrade, security headers, the CSP (a per-request nonce, set as
 * `c.get('hypdrivNonce')` and `nonce()`), rate limits, the bot shield, geo, flags, redirects, maintenance mode,
 * Early Hints, logging and `Server-Timing`.
 *
 * Register it first (`app.use(hypdriv({ config }))`), so it also wraps the responses of the middleware after it.
 * The app receives the pipeline's request (sanitised headers, the stages' `x-hypdriv-*` headers, the body).
 * Background revalidation (stale-while-revalidate) renders through `options.app`, which `useHypDriv(app)` sets;
 * `wrapHono()` wraps the whole app and needs no such wiring.
 */
export function hypdriv(options: HypDrivHonoOptions): HypDrivHonoMiddleware {
  const { config, manifest, host, app, mounted: _mounted, ...rest } = options;
  const handler = createHandler({
    ...rest,
    config,
    ...(manifest !== undefined ? { manifest } : {}),
    host: host ?? HOST_LABEL,
  });
  // Requests the middleware itself sends back into the app (background revalidation) must not enter the
  // Drivetrain again: the app answers them directly.
  const direct = new WeakSet<Request>();
  const middleware: MiddlewareHandler = async (c, next) => {
    if (direct.has(c.req.raw)) return next();
    const env = c.env;
    const exec = executionContext(c);
    const response = await handler(c.req.raw, {
      ...platformInput(c.req.raw, env, exec, handler.config),
      upstream: async (forwarded) => {
        if (forwarded.headers.has(REVALIDATE_HEADER)) {
          if (!app)
            throw new Error(
              'stale-while-revalidate needs the app behind the middleware: register it with useHypDriv(app, { config }) or pass `app` to hypdriv()',
            );
          direct.add(forwarded);
          return app.fetch(forwarded, env, exec);
        }
        // The app sees the pipeline's request: sanitised headers, the stages' x-hypdriv-* headers, and the body
        // (the pipeline moved it out of the original request).
        c.req.raw = forwarded;
        const current = requestNonce();
        if (current) (c as Context<{ Variables: HypDrivHonoVariables }>).set('hypdrivNonce', current);
        await next();
        return c.res;
      },
    });
    replaceResponse(c, response);
  };
  Object.defineProperty(middleware, 'handler', { value: handler, enumerable: false });
  return middleware as HypDrivHonoMiddleware;
}

/**
 * `app.use(hypdriv({ config, manifest: () => honoManifest(app) }))` in one call: registers the middleware on
 * every path and gives the Drivetrain the app's own routes (evaluated on the first request, after the app
 * registered them all).
 */
export function useHypDriv(
  app: HonoRoutesSource & { use(...handlers: MiddlewareHandler[]): unknown } & Partial<AppFetch>,
  options: HypDrivHonoOptions,
): HypDrivHonoMiddleware {
  const middleware = hypdriv({
    manifest: () => honoManifest(app, { mounted: options.mounted }),
    app: app as unknown as AppFetch,
    ...options,
  });
  app.use(middleware);
  return middleware;
}
