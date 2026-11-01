import type { GeoProperties, HypDrivConfig, HypDrivEnv, ResolvedConfig } from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  type HandleInput,
  type HypHandler,
  type ManifestSource,
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
}

/** A middleware plus the handler behind it (tests, custom hosts). */
export type HypDrivHonoMiddleware = MiddlewareHandler & { readonly handler: HypHandler };

interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
}

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } };
}

/** `@hono/node-server` hands `{ incoming, outgoing }` to `fetch` as the bindings: not an environment. */
function isNodeBindings(env: unknown): env is NodeBindings & object {
  return typeof env === 'object' && env !== null && 'incoming' in env && 'outgoing' in env;
}

/**
 * The platform facts a Hono call exposes, as `createHandler` input: Cloudflare bindings and `ctx.waitUntil`, the
 * socket address on Node (`@hono/node-server`; used unless the config says the server sits behind proxies, whose
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
  if (isNodeBindings(env)) {
    const address = env.incoming?.socket?.remoteAddress;
    if (address && config.security.trustedProxies === 0) out.ip = address;
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
 * Middleware cannot rewrite the request the app sees; `wrapHono()` wraps the whole app and forwards the
 * pipeline's request.
 */
export function hypdriv(options: HypDrivHonoOptions): HypDrivHonoMiddleware {
  const { config, manifest, host, ...rest } = options;
  const handler = createHandler({
    ...rest,
    config,
    ...(manifest !== undefined ? { manifest } : {}),
    host: host ?? HOST_LABEL,
  });
  const middleware: MiddlewareHandler = async (c, next) => {
    const response = await handler(c.req.raw, {
      ...platformInput(c.req.raw, c.env, executionContext(c), handler.config),
      upstream: async () => {
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
  app: HonoRoutesSource & { use(...handlers: MiddlewareHandler[]): unknown },
  options: HypDrivHonoOptions,
): HypDrivHonoMiddleware {
  const middleware = hypdriv({ manifest: () => honoManifest(app), ...options });
  app.use(middleware);
  return middleware;
}
