import { getCurrentContext, isRscRequest } from '@hypdriv/core';
import { type CreateHandlerOptions, createHandler, type HypHandler } from '@hypdriv/runtime';
import { CSP_DECISION_KEY } from '@hypdriv/security';
import { PRERENDER_TOKEN_DEFINE, PRERENDER_TOKEN_ENV } from './constants';

/**
 * `@hypdriv/vinext/runtime` — the request hook the Hypdriv vinext plugin installs around vinext's App Router
 * request handler (the default export of vinext's generated RSC entry). Every request vinext answers — pages,
 * Route Handlers, Server Actions, RSC navigations, metadata routes, public files — runs through Hypdriv's
 * Drivetrain with `runner: 'host'`, owning the full response, and application code sees `hyp()`.
 */

export { PRERENDER_TOKEN_DEFINE, PRERENDER_TOKEN_ENV };

declare const __HYPDRIV_VINEXT_PRERENDER_TOKEN__: string | undefined;

/** The prerender token baked into this build (null in development and outside a Hypdriv vinext build). */
export function bakedPrerenderToken(): string | null {
  return typeof __HYPDRIV_VINEXT_PRERENDER_TOKEN__ === 'string' && __HYPDRIV_VINEXT_PRERENDER_TOKEN__
    ? __HYPDRIV_VINEXT_PRERENDER_TOKEN__
    : null;
}

const processEnv = (): Record<string, string | undefined> | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

/**
 * Whether this process is vinext's build-time prerender of the build that baked `token`: vinext sets
 * `VINEXT_PRERENDER=1` in its prerender servers and the Hypdriv plugin puts the build's random token into the
 * build's environment, which those servers inherit. Neither can be set by a client, and a deployed server never
 * has the token in its environment.
 */
export function isBuildPrerender(token: string | null | undefined = bakedPrerenderToken()): boolean {
  if (!token) return false;
  const env = processEnv();
  return env?.VINEXT_PRERENDER === '1' && env[PRERENDER_TOKEN_ENV] === token;
}

/** vinext's execution context (Node server, Worker `ctx`). */
interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
}

type AppHandler = (request: Request, ...rest: unknown[]) => unknown;

export interface WrapAppHandlerOptions extends Omit<CreateHandlerOptions, 'host'> {
  /**
   * The build's prerender token: requests of vinext's build-time prerender bypass the pipeline. Default: the
   * token the plugin baked into the build.
   */
  prerenderToken?: string | null;
  /** The framework label in logs and `/_hypdriv/health` (default `vinext`). */
  host?: string;
}

const CACHED_CLASSIFICATIONS = new Set(['static', 'isr']);

/**
 * The request vinext renders. For documents vinext may serve from (or write to) its page cache — routes
 * Hypdriv classifies `static` or `isr` — the nonce policy is not forwarded: vinext renders a nonce-bearing
 * document per request and never caches it, so the page would lose ISR. The csp stage injects the request's
 * nonce into the response instead (`runner: 'host'` owns the body), which covers vinext's own scripts.
 */
export function upstreamRequest(forwarded: Request): Request {
  const ctx = getCurrentContext();
  if (!ctx || !forwarded.headers.has('content-security-policy')) return forwarded;
  const decision = ctx.state.get(CSP_DECISION_KEY);
  const classification = ctx.route?.route.classification;
  if (
    decision?.mode !== 'nonce' ||
    !decision.inject ||
    !classification ||
    !CACHED_CLASSIFICATIONS.has(classification) ||
    (forwarded.method !== 'GET' && forwarded.method !== 'HEAD') ||
    isRscRequest(forwarded.headers)
  )
    return forwarded;
  const headers = new Headers(forwarded.headers);
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  return new Request(forwarded, { headers });
}

/**
 * The request as a platform-native `Request`. Node servers built on srvx (`@vitejs/plugin-rsc`'s dev server,
 * Nitro's Node presets) hand over a lazy `Request` look-alike that undici cannot use as the input of
 * `new Request(input, init)`, which the pipeline does to forward headers; it is rebuilt from its parts.
 */
export function nativeRequest(request: Request): Request {
  const Native = globalThis.Request;
  if (typeof Native !== 'function' || Object.getPrototypeOf(request) === Native.prototype) return request;
  const method = request.method;
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: new Headers(request.headers),
    signal: request.signal,
    redirect: request.redirect,
  };
  if (method !== 'GET' && method !== 'HEAD' && request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Native(request.url, init);
}

/** Headers through which a response is stored by shared caches (CDNs) in front of the application. */
const SHARED_CACHE_HEADERS = [
  'cdn-cache-control',
  'vercel-cdn-cache-control',
  'cloudflare-cdn-cache-control',
  'surrogate-control',
];

/**
 * A document that carries the request's nonce is never stored by a shared cache: every visitor would receive the
 * same nonce. vinext marks its own nonce-bearing renders `no-store`; a page vinext served from its page cache
 * (`isr`, `static` in nonce mode) gets the nonce injected after the fact, so its cacheable `Cache-Control` is made
 * private here. Hypdriv's own edge cache stores the document before the injection.
 */
export function privateNonceDocument(response: Response): Response {
  if (response.headers.get('x-hypdriv-csp') !== 'nonce') return response;
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;
  const cacheControl = response.headers.get('cache-control') ?? '';
  const shared =
    /(?:^|,)\s*(?:public|s-maxage\s*=)/i.test(cacheControl) ||
    SHARED_CACHE_HEADERS.some((h) => response.headers.has(h));
  if (!shared) return response;
  const out = new Response(response.body, response);
  out.headers.set('cache-control', 'private, no-store');
  for (const name of SHARED_CACHE_HEADERS) out.headers.delete(name);
  return out;
}

/** A handler result as a Response (vinext's handlers return a Response; older shapes return text or null). */
function toResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (result === null || result === undefined)
    return new Response('This page could not be found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  return new Response(String(result), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const SKIPPED_PROPERTIES = new Set<PropertyKey>(['length', 'name', 'prototype', 'arguments', 'caller']);

/**
 * Wraps vinext's request handler (`(request, ctx) => Promise<Response>`) with `createHandler()`. Properties of
 * the handler (`handleResponseStage`) are kept; anything that is not a function is returned untouched.
 * `handler` may also be a loader (`load: true`) that resolves the current handler per request, which keeps the
 * hook in step with vinext's hot-reloaded entry in development.
 */
export function wrapAppHandler<T>(
  handler: T,
  options: WrapAppHandlerOptions,
  mode: { load?: boolean } = {},
): T & { hypdriv: HypHandler } {
  if (typeof handler !== 'function') return handler as T & { hypdriv: HypHandler };
  const { prerenderToken = bakedPrerenderToken(), host, ...rest } = options;
  const hypdriv = createHandler({ ...rest, host: host ?? 'vinext' });
  const resolve = mode.load
    ? (handler as unknown as () => Promise<AppHandler>)
    : () => Promise.resolve(handler as unknown as AppHandler);
  const wrapped = async function hypdrivVinextHandler(
    this: unknown,
    request: Request,
    ...args: unknown[]
  ): Promise<unknown> {
    const app = await resolve();
    // vinext's build-time prerender renders the application as built; Hypdriv's posture applies at run time.
    if (isBuildPrerender(prerenderToken)) return app.call(this, request, ...args);
    const ctx = args[0] as ExecutionContextLike | undefined;
    const response = await hypdriv(nativeRequest(request), {
      upstream: async (forwarded) => toResponse(await app.call(this, upstreamRequest(forwarded), ...args)),
      ...(ctx && typeof ctx.waitUntil === 'function'
        ? { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil!(promise) }
        : {}),
    });
    return privateNonceDocument(response);
  };
  if (!mode.load) {
    for (const key of Reflect.ownKeys(handler as object)) {
      if (SKIPPED_PROPERTIES.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(handler, key);
      if (descriptor) Object.defineProperty(wrapped, key, descriptor);
    }
  }
  Object.defineProperty(wrapped, 'hypdriv', { value: hypdriv });
  return wrapped as unknown as T & { hypdriv: HypHandler };
}
