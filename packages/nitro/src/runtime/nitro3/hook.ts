import { getCurrentContext, type HypContext } from '@hypdriv/core';
import type { HypHandler } from '@hypdriv/runtime';
import { FACTS_KEY, factsFor } from '../facts';

/** The request properties Nitro 3's presets and srvx stamp on the Web `Request` (`req.runtime`, `req.waitUntil`…). */
export interface Nitro3Request extends Request {
  runtime?: {
    name?: string;
    cloudflare?: {
      env?: Record<string, unknown>;
      context?: { waitUntil?(promise: Promise<unknown>): void };
    };
    vercel?: { context?: { waitUntil?(promise: Promise<unknown>): void } };
    [key: string]: unknown;
  };
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
  /** The client address srvx reports (the socket address, or the first `x-forwarded-for` entry on Vercel). */
  ip?: string | undefined;
  /** Nitro's per-request context; becomes `event.context` of the h3 event. */
  context?: Record<string, unknown>;
  cf?: Record<string, unknown>;
}

/** The parts of the Nitro 3 app the hook uses (`nitroApp` of a runtime plugin). */
export interface Nitro3AppLike {
  fetch: (request: Request) => Response | Promise<Response>;
  captureError?: (error: Error, context: { event?: unknown; tags?: string[] }) => void;
}

export interface Nitro3HookOptions {
  /** The Hypdriv handler (`createHandler({ config, manifest, host, skip })`). */
  handler: HypHandler;
  /** Hand the CSP nonce to the application (`event.context.hypdriv.nonce`; default true). */
  nonce?: boolean;
  /** Whether Nitro caches this request's rendered body (`cache` / `swr` route rules). */
  cachedRender?: (request: Request) => boolean;
  /**
   * Use the client address srvx reports as the client IP (Node servers without a trusted proxy). Default false:
   * the pipeline reads `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` according to `security.trustedProxies`.
   */
  socketIp?: boolean;
}

/** Whether a Hypdriv runner already owns this request (the Cloudflare Worker entry, or an outer host request). */
function ownedByOuterRunner(ctx: HypContext | undefined): ctx is HypContext {
  return !!ctx && (ctx.runner === 'worker' || ctx.runner === 'host');
}

function attachFacts(request: Nitro3Request, ctx: HypContext, options: Nitro3HookOptions): void {
  const nonce = options.nonce !== false && !(options.cachedRender?.(request) ?? false);
  request.context = { ...(request.context ?? {}), [FACTS_KEY]: factsFor(ctx, { nonce }) };
}

/** The platform facts the Nitro 3 presets hand to the request (Cloudflare bindings, `waitUntil`, `request.cf`). */
export function platformOf(request: Nitro3Request): {
  env?: Record<string, unknown>;
  waitUntil?: (promise: Promise<unknown>) => void;
  cf?: Record<string, unknown>;
} {
  const cloudflare = request.runtime?.cloudflare;
  const vercel = request.runtime?.vercel;
  const waitUntil =
    request.waitUntil ??
    (cloudflare?.context?.waitUntil
      ? (promise: Promise<unknown>) => cloudflare.context?.waitUntil?.(promise)
      : vercel?.context?.waitUntil
        ? (promise: Promise<unknown>) => vercel.context?.waitUntil?.(promise)
        : undefined);
  return {
    ...(cloudflare?.env ? { env: cloudflare.env } : {}),
    ...(waitUntil ? { waitUntil } : {}),
    ...(request.cf ? { cf: request.cf } : {}),
  };
}

/** Carries the properties Nitro's presets set on the original request over to the request the pipeline forwards. */
function carryOver(from: Nitro3Request, to: Nitro3Request): void {
  if (from === to) return;
  if (from.runtime && !to.runtime) to.runtime = from.runtime;
  if (from.waitUntil && !to.waitUntil) to.waitUntil = from.waitUntil;
  if (from.ip !== undefined && to.ip === undefined) to.ip = from.ip;
  if (from.context && !to.context) to.context = { ...from.context };
}

/**
 * Wraps Nitro 3's app fetch (`nitroApp.fetch`, the single function every request of every preset passes through)
 * with the Hypdriv pipeline:
 *
 * - The pipeline's request stages run first; a short-circuit (rate limit, bot block, redirect, maintenance,
 *   `/_hypdriv/*`) answers without rendering.
 * - Otherwise Nitro renders the forwarded request inside the request's `AsyncLocalStorage` context (so `hyp()`
 *   works in handlers, renderers and error handlers) and the response stages post-process the streaming `Response`
 *   (security headers, CSP with nonce injection, Server-Timing…).
 * - Requests inside an outer Hypdriv runner (the Cloudflare Worker entry, Nitro sub-requests made while rendering)
 *   pass straight through, with the request facts attached.
 */
export function createNitro3Fetch(
  inner: (request: Request) => Response | Promise<Response>,
  options: Nitro3HookOptions,
): (request: Request) => Promise<Response> {
  return async function hypdrivNitroFetch(request: Request): Promise<Response> {
    const original = request as Nitro3Request;
    const current = getCurrentContext();
    if (ownedByOuterRunner(current)) {
      attachFacts(original, current, options);
      return inner(request);
    }
    const ip = options.socketIp ? original.ip : undefined;
    return options.handler(request, {
      ...platformOf(original),
      ...(ip ? { ip } : {}),
      upstream: async (forwarded) => {
        const next = forwarded as Nitro3Request;
        carryOver(original, next);
        const ctx = getCurrentContext();
        if (ctx) attachFacts(next, ctx, options);
        return inner(next);
      },
    });
  };
}

/** Installs the Hypdriv handler around a Nitro 3 app (called from the Nitro plugin). */
export function installNitro3Hook(nitroApp: Nitro3AppLike, options: Nitro3HookOptions): void {
  const inner = nitroApp.fetch.bind(nitroApp);
  nitroApp.fetch = createNitro3Fetch(inner, options);
}
