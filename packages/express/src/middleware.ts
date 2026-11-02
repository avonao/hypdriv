import type { IncomingMessage, ServerResponse } from 'node:http';
import { type HypDrivConfig, type HypDrivEnv, normalizeIp, type ResolvedConfig } from '@hypdriv/core';
import {
  type CreateHandlerOptions,
  createHandler,
  type HypHandler,
  isStaticRequest,
  type ManifestSource,
  REVALIDATE_HEADER,
  nonce as requestNonce,
} from '@hypdriv/runtime';
import {
  bridgeRequest,
  remoteAddress,
  syncRequestHeaders,
  withAssetHeaders,
  writeWebResponse,
} from '@hypdriv/runtime/node';
import { ResponseCapture } from './capture';
import { type ExpressHandler, expressFetch, isDetached } from './fetch';
import { type ExpressRoutesSource, expressManifest } from './manifest';
import { checkOrder } from './order';

/** The label reported in logs and `/_hypdriv/health`. */
export const HOST_LABEL = 'express';

type Next = (error?: unknown) => void;

/** Locals the middleware sets on `res.locals` (`res.locals.hypdrivNonce`, for the templates of a view engine). */
export interface HypDrivExpressLocals {
  /** The request's CSP nonce (nonce mode), for `<script nonce>` tags the app renders itself. */
  hypdrivNonce?: string;
}

declare global {
  namespace Express {
    interface Locals extends HypDrivExpressLocals {}
  }
}

export interface HypDrivExpressOptions extends Omit<CreateHandlerOptions, 'config' | 'manifest' | 'host'> {
  /** The Hypdriv config (`defineConfig({...})`). */
  config: HypDrivConfig | ResolvedConfig;
  /** A manifest, or a loader; default: none (`useHypDriv(app)` and `expressManifest(app)` derive it from the routes). */
  manifest?: ManifestSource;
  /** The framework label (default `express`). */
  host?: string;
  /** More route patterns for the derived manifest (`useHypDriv`): see `expressManifest`. */
  routes?: readonly string[];
  /**
   * The Express app behind the middleware (`useHypDriv(app)` sets it). Background revalidation
   * (stale-while-revalidate) renders through it, because the request that served the stale entry is long finished.
   */
  app?: ExpressHandler;
  /**
   * Trust `x-forwarded-proto` / `x-forwarded-host` for the request URL (a reverse proxy in front of the server).
   * Default: on when `security.trustedProxies > 0`, on Vercel, or with `HYPDRIV_TRUST_PROXY=1`.
   */
  trustProxy?: boolean;
  /** The public origin of the site (`https://example.com`), when the `Host` header cannot be trusted. */
  origin?: string;
  /**
   * Static-file responses (the requests `skip` keeps out of the stages: `express.static`, `res.sendFile`) get the
   * security header preset of the config. Default `true`.
   */
  staticHeaders?: boolean;
}

/** A middleware plus the handler behind it (tests, custom hosts). */
export type HypDrivExpressMiddleware = ((
  req: IncomingMessage,
  res: ServerResponse,
  next: Next,
) => Promise<void>) & {
  readonly handler: HypHandler;
};

type Env = Record<string, string | undefined>;

const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

function errorResponse(): Response {
  return new Response('Internal Server Error', {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Express middleware that runs the Hypdriv Drivetrain around everything the app answers — pages, API routes,
 * static files, not-found responses, errors — with `createHandler` (`runner: 'host'`), owning the full response:
 * internal routes (`/_hypdriv/*`), the HTTPS upgrade, security headers, the CSP (a per-request nonce, set as
 * `res.locals.hypdrivNonce` and `nonce()`), rate limits, the bot shield, geo, flags, redirects, maintenance mode,
 * Early Hints, logging and `Server-Timing`.
 *
 * Register it first (`app.use(hypdriv({ config }))`), so it wraps the routes and middleware registered after it.
 * What the app writes is captured as a streaming Web `Response`, runs through the pipeline, and the pipeline's
 * response is what goes out on the socket; request bodies stay with the app (body parsers read them as usual,
 * even after a stage inspected a form field).
 */
export function hypdriv(options: HypDrivExpressOptions): HypDrivExpressMiddleware {
  const {
    config,
    manifest,
    host,
    app,
    routes: _routes,
    trustProxy,
    origin,
    staticHeaders = true,
    skip: userSkip,
    ...rest
  } = options;
  const skip = userSkip ?? ((url: URL) => isStaticRequest(url));
  const handler = createHandler({
    ...rest,
    config,
    ...(manifest !== undefined ? { manifest } : {}),
    host: host ?? HOST_LABEL,
    skip,
  });
  const env = processEnv();
  const trust = (): boolean =>
    trustProxy ??
    (handler.config.security.trustedProxies > 0 || env.HYPDRIV_TRUST_PROXY === '1' || env.VERCEL === '1');
  // The socket address is the client only when nothing sits in front of the server: behind a proxy (or on Vercel,
  // whose proxy is the peer) the forwarded headers decide, according to `security.trustedProxies`.
  const useSocketAddress = (): boolean => handler.config.security.trustedProxies === 0 && env.VERCEL !== '1';

  let orderChecked = false;
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> => {
    // A request `expressFetch` created for background revalidation: the app answers it directly.
    if (isDetached(req)) return next();
    if (!orderChecked) {
      // On the first request the app has registered everything: say what would bypass or defeat the Drivetrain.
      orderChecked = true;
      if (app)
        void handler
          .ready()
          .then(({ platform }) => {
            for (const problem of checkOrder(app as never, middleware)) platform.log.warn(problem);
          })
          .catch(() => undefined);
    }
    let bridged: ReturnType<typeof bridgeRequest>;
    try {
      bridged = bridgeRequest(req, { trustProxy: trust(), ...(origin ? { origin } : {}) });
    } catch (error) {
      return next(error);
    }
    const { request, body } = bridged;
    // The client went away before the response was complete.
    res.once('close', () => {
      if (!res.writableFinished) bridged.abort(new Error('client disconnected'));
    });
    const address = remoteAddress(req);
    let capture: ResponseCapture | null = null;
    let entered = false;
    let written = false;
    try {
      const response = await handler(request, {
        ...(address && useSocketAddress() ? { ip: normalizeIp(address) } : {}),
        upstream: async (forwarded) => {
          if (forwarded.headers.has(REVALIDATE_HEADER)) {
            if (!app)
              throw new Error(
                'stale-while-revalidate needs the app behind the middleware: register it with useHypDriv(app, { config }) or pass `app` to hypdriv()',
              );
            return expressFetch(app, forwarded, address ? { ip: address } : {});
          }
          const asset = skip(new URL(forwarded.url), forwarded);
          // The application reads the body from the Node request: put back whatever a stage took from it, and let
          // the app see the pipeline's request headers (the client's x-hypdriv-* gone, the stages' own in).
          body?.release();
          syncRequestHeaders(req, forwarded.headers);
          const current = requestNonce();
          const locals = (res as ServerResponse & { locals?: HypDrivExpressLocals }).locals;
          if (current && locals) locals.hypdrivNonce = current;
          capture = new ResponseCapture(req, res);
          entered = true;
          next();
          const answered = await capture.response;
          return asset && staticHeaders
            ? withAssetHeaders(handler.config, forwarded, answered, {
                development: env.NODE_ENV === 'development',
              })
            : answered;
        },
      });
      const writers = capture ? (capture as ResponseCapture).writers : undefined;
      await writeWebResponse(res, response, {
        method: request.method,
        replaceHeaders: true,
        ...(writers
          ? {
              writers: {
                ...writers,
                writeHead: (status, message) => {
                  written = true;
                  writers.writeHead(status, message);
                },
              },
            }
          : {}),
      });
    } catch (error) {
      (capture as ResponseCapture | null)?.fail(error);
      if (!entered && !written && !res.headersSent) return next(error);
      if (!written) {
        try {
          await writeWebResponse(res, errorResponse(), {
            method: request.method,
            replaceHeaders: true,
            ...(capture ? { writers: (capture as ResponseCapture).writers } : {}),
          });
          return;
        } catch {
          // fall through to destroying the response
        }
      }
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
      body?.release();
    }
  };
  Object.defineProperty(middleware, 'handler', { value: handler, enumerable: false });
  Object.defineProperty(middleware, 'name', { value: 'hypdriv' });
  return middleware as HypDrivExpressMiddleware;
}

/** The part of an Express app `useHypDriv()` needs. */
export type ExpressAppLike = ExpressRoutesSource & ExpressHandler & { use(...handlers: never[]): unknown };

/**
 * `app.use(hypdriv({ config, manifest: () => expressManifest(app) }))` in one call: registers the middleware on
 * every path, gives the Drivetrain the app's own routes (evaluated on the first request, after the app registered
 * them all) and lets stale-while-revalidate render through the app. On the first request it warns, once, when
 * something registered before it would answer without the Drivetrain, or a `compression()` registered after it
 * would compress the body before the pipeline reads it.
 */
export function useHypDriv(app: ExpressAppLike, options: HypDrivExpressOptions): HypDrivExpressMiddleware {
  const middleware = hypdriv({
    manifest: () => expressManifest(app, options.routes ? { routes: options.routes } : {}),
    app,
    ...options,
  });
  (app.use as unknown as (handler: unknown) => unknown).call(app, middleware);
  return middleware;
}

export type { HypDrivEnv };
