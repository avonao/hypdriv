import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentContext } from '@hypdriv/core';
import { createStaticHandler, sendWebResponse, toWebRequest } from '@hypdriv/vite/node';
import type { ClientConn } from '@qwik.dev/router/middleware/request-handler';
import { type HypDrivRuntimeOptions, handlerFor, plainAddress, type WrapOptions } from './entry';
import {
  createQwikFetch,
  errorResponse,
  isStaticPath,
  notFoundResponse,
  type QwikFetchOptions,
} from './fetch';

/** `Cache-Control` of content-hashed build assets (Qwik's `/build/` and `/assets/`). */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Hypdriv's options in the Node entry. */
export interface HypDrivNodeOptions extends HypDrivRuntimeOptions {
  /**
   * Trust `x-forwarded-proto` / `x-forwarded-host` for the request URL (a reverse proxy in front of the server).
   * Default: `security.trustedProxies > 0` in `hypdriv.config.ts`, or `HYPDRIV_TRUST_PROXY=1`. `ORIGIN` (or the
   * `origin` option) states the public origin outright and wins.
   */
  trustProxy?: boolean;
}

/** The options of Qwik's own Node middleware (`@qwik.dev/router/middleware/node`) plus Hypdriv's. */
export interface QwikRouterNodeOptions extends QwikFetchOptions {
  /** The directory of the client build (default `../dist` next to the server entry). */
  static?: {
    root?: string;
    /** `Cache-Control` for every static file (default: immutable for hashed assets, revalidate otherwise). */
    cacheControl?: string;
  };
  /** The public origin of the server (`https://example.com`), else `ORIGIN`, else derived from the request. */
  origin?: string;
  /** Computes the origin per request (overrides `origin`). */
  getOrigin?: (req: IncomingMessage) => string;
  /** Computes `requestEv.clientConn` per request (default: what the Drivetrain resolved, else the socket address). */
  getClientConn?: (req: IncomingMessage) => ClientConn;
  hypdriv?: HypDrivNodeOptions;
}

type Next = (error?: unknown) => void;
type Env = Record<string, string | undefined>;

/**
 * What `createQwikRouter` returns. `router`, `staticFile` and `notFound` have the shapes of Qwik's own Node
 * middleware, so entries written for it keep working; `listener` is the complete `http` request listener.
 */
export interface HypDrivQwikNodeRouter {
  /** Static files and Qwik Router behind the Drivetrain (every request, pages and files alike). */
  router(req: IncomingMessage, res: ServerResponse, next: Next): Promise<void>;
  /**
   * Qwik's `staticFile` middleware, kept for entries that chain it before `router`. It passes the request on: static
   * files are served by `router` so they run through the Drivetrain like every other response.
   */
  staticFile(req: IncomingMessage, res: ServerResponse, next: Next): void;
  /** Kept for entries written for Qwik's middleware; `router` answers unknown paths itself. */
  notFound(req: IncomingMessage, res: ServerResponse, next: Next): void;
  /** `router` as an `http` request listener: `createServer(listener).listen(port)`. */
  listener(req: IncomingMessage, res: ServerResponse): void;
  /** The same pipeline for a Web `Request` (tests, other servers). */
  fetch(request: Request, input?: { ip?: string }): Promise<Response>;
}

const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/** The directory of the client build: `static.root`, else `../dist` of the server entry, else `./dist`. */
export function staticRoot(configured: string | undefined, entryUrl: string = import.meta.url): string {
  if (configured) return resolve(configured);
  const here = dirname(fileURLToPath(entryUrl));
  const candidates = [join(here, '..', 'dist'), join(here, 'dist'), join(process.cwd(), 'dist')];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!;
}

/** The public origin of a request, as Qwik's Node middleware computes it (`ORIGIN`, `PROTOCOL_HEADER`, `HOST_HEADER`). */
export function originFor(
  req: IncomingMessage,
  options: QwikRouterNodeOptions,
  env: Env,
): string | undefined {
  const explicit = options.getOrigin?.(req) ?? options.origin ?? env.ORIGIN;
  if (explicit) return explicit;
  const { PROTOCOL_HEADER, HOST_HEADER } = env;
  if (!PROTOCOL_HEADER && !HOST_HEADER) return undefined;
  const proto =
    (PROTOCOL_HEADER && headerOf(req, PROTOCOL_HEADER)) ||
    ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = headerOf(req, HOST_HEADER ?? 'host');
  return host ? `${proto}://${host}` : undefined;
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** The request with Qwik's base pathname stripped (`/docs/about/` → `/about/`), for the static file lookup. */
function withoutBase(request: Request): Request {
  const base =
    (globalThis as { __QWIK_ROUTER_BASE_PATHNAME__?: string }).__QWIK_ROUTER_BASE_PATHNAME__ ?? '/';
  if (base === '/') return request;
  const url = new URL(request.url);
  if (url.pathname === base.slice(0, -1)) url.pathname = '/';
  else if (url.pathname.startsWith(base)) url.pathname = `/${url.pathname.slice(base.length)}`;
  else return request;
  return new Request(url, request);
}

/** The pathnames of the prerendered documents the manifest names, and whether pages end with a slash. */
export interface DocumentIndex {
  paths: Set<string>;
  trailingSlash: boolean;
}

/** Prerendered documents of the manifest (static page routes the static layer answers), by pathname. */
export function documentIndex(manifest: {
  trailingSlash: boolean;
  routes: Array<{ kind: string; pathname: string; dynamic: boolean; servedStatically?: boolean }>;
}): DocumentIndex {
  const paths = new Set<string>();
  for (const route of manifest.routes)
    if (route.kind === 'page' && route.servedStatically === true && !route.dynamic) paths.add(route.pathname);
  return { paths, trailingSlash: manifest.trailingSlash };
}

/**
 * Whether a request is for a prerendered document: a GET or HEAD for exactly the URL the application uses for the
 * page (`/about/` with trailing slashes, `/about` without), so the framework's own redirect for the other spelling
 * still happens. Qwik's static path list carries the same documents after an adapter build; the manifest covers
 * server bundles built without one (the preview build).
 */
export function isDocumentRequest(index: DocumentIndex, method: string, pathname: string): boolean {
  if ((method !== 'GET' && method !== 'HEAD') || !index.paths.size) return false;
  if (pathname === '/') return index.paths.has('/');
  if (pathname.endsWith('/') !== index.trailingSlash) return false;
  return index.paths.has(index.trailingSlash ? pathname.slice(0, -1) : pathname);
}

/**
 * Qwik Router's Node entry behind the Drivetrain: the static files of the client build (prerendered pages,
 * content-hashed assets with immutable caching) and Qwik's request handler, both behind `createHandler`. Every
 * response passes the pipeline: security headers, the CSP (a hash policy for prerendered pages, a nonce policy for
 * the pages Qwik renders), rate limits, the bot shield, flags, redirects, logging and `/_hypdriv/*`.
 */
export function wrapNode(
  qwik: QwikRouterNodeOptions,
  options: WrapOptions & HypDrivNodeOptions,
): HypDrivQwikNodeRouter {
  const { trustProxy, ...wrap } = options;
  const handler = handlerFor(wrap);
  const qwikFetch = createQwikFetch(qwik);
  const env = processEnv();
  const dir = staticRoot(qwik.static?.root);
  const cacheControl = qwik.static?.cacheControl;

  let serveStatic: Promise<(request: Request) => Promise<Response | null>> | null = null;
  const staticHandler = () => {
    serveStatic ??= handler
      .ready()
      .then((runtime) => runtime.platform.manifest.staticFiles.immutablePrefixes)
      .catch(() => [] as string[])
      .then((prefixes) =>
        createStaticHandler({ dir, immutablePrefixes: prefixes.length ? prefixes : ['/build/', '/assets/'] }),
      );
    return serveStatic;
  };

  let documents: Promise<DocumentIndex> | null = null;
  const documentsOf = () => {
    documents ??= handler
      .ready()
      .then((runtime) => documentIndex(runtime.platform.manifest))
      .catch(() => ({ paths: new Set<string>(), trailingSlash: true }));
    return documents;
  };

  const upstream = async (request: Request, req?: IncomingMessage): Promise<Response> => {
    try {
      const staticPath = isStaticPath(request.method, new URL(request.url));
      const local = withoutBase(request);
      if (staticPath || isDocumentRequest(await documentsOf(), request.method, new URL(local.url).pathname)) {
        const file = await (await staticHandler())(local);
        if (file) {
          if (!cacheControl) return file;
          const out = new Response(file.body, file);
          out.headers.set('cache-control', cacheControl);
          return out;
        }
        // A listed static file that is missing is a 404; a document that is not on disk is rendered.
        if (staticPath) return notFoundResponse(request);
      }
      const response = await qwikFetch(request, {
        env: (key) => env[key],
        platform: { ssr: true, ...(req ? { incomingMessage: req } : {}), node: process.versions.node },
        clientConn: () => {
          if (req && qwik.getClientConn) return qwik.getClientConn(req);
          // What the Drivetrain resolved (trusted proxies, forwarded headers), else the socket's address.
          const ip =
            getCurrentContext()?.ip ||
            (req?.socket.remoteAddress ? plainAddress(req.socket.remoteAddress) : '');
          return ip ? { ip } : {};
        },
      });
      return response ?? notFoundResponse(request);
    } catch (error) {
      return errorResponse(error, 'node');
    }
  };

  const trust = (): boolean =>
    trustProxy ?? (handler.config.security.trustedProxies > 0 || env.HYPDRIV_TRUST_PROXY === '1');

  const router: HypDrivQwikNodeRouter['router'] = async (req, res, next) => {
    try {
      const origin = originFor(req, qwik, env);
      const request = toWebRequest(req, { trustProxy: trust(), ...(origin ? { origin } : {}) });
      const address = req.socket.remoteAddress;
      const response = await handler(request, {
        ...(address && handler.config.security.trustedProxies === 0 ? { ip: plainAddress(address) } : {}),
        upstream: (forwarded) => upstream(forwarded, req),
      });
      await sendWebResponse(res, response, request.method);
    } catch (error) {
      next(error);
    }
  };

  return {
    router,
    staticFile: (_req, _res, next) => next(),
    notFound: (_req, _res, next) => next(),
    listener: (req, res) => {
      void router(req, res, (error) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('Internal Server Error');
        } else res.destroy(error instanceof Error ? error : undefined);
      });
    },
    fetch: (request, input) =>
      handler(request, {
        ...(input?.ip ? { ip: input.ip } : {}),
        upstream: (forwarded) => upstream(forwarded),
      }),
  };
}
