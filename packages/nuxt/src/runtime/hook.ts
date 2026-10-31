import { getCurrentContext, type HypContext } from '@hypdriv/core';
import { publicFlags } from '@hypdriv/flags';
import { type HypHandler, isStaticRequest, requestContextFrom } from '@hypdriv/runtime';
import { CaptureResponse, type NodeResponseLike, writeResponse } from './capture';
import { FACTS_KEY, type HypEventContext } from './facts';
import {
  applyForwardedHeaders,
  type H3EventLike,
  isInternalSubRequest,
  platformOf,
  toWebRequest,
} from './request';

/** An h3 error as Nitro's error handlers expect it. */
export interface H3ErrorLike extends Error {
  statusCode?: number;
  statusMessage?: string;
  unhandled?: boolean;
  fatal?: boolean;
  data?: unknown;
}

/** The parts of the Nitro 2 app the hook uses. */
export interface NitroAppLike {
  h3App: {
    handler: (event: H3EventLike) => unknown;
    options: { onError?: (error: H3ErrorLike, event: H3EventLike) => unknown };
  };
  captureError?: (error: Error, context: { event?: unknown; tags?: string[] }) => void;
}

export interface NitroHookOptions {
  /** The HypDriv handler (`createHandler({ config, manifest, host: 'nuxt', skip })`). */
  handler: HypHandler;
  /**
   * Requests answered by the application without the pipeline (the same predicate passed to `createHandler`'s
   * `skip`): they are rendered straight onto the client response.
   */
  skip: (url: URL) => boolean;
  /** Reads (and caches on the request) the raw body: h3's `readRawBody(event, false)`. */
  readRawBody: (event: H3EventLike) => Promise<Uint8Array | undefined>;
  /**
   * Normalises a thrown value the way h3's Node listener does before calling the app's `onError`
   * (`createError`, `unhandled` for non-h3 errors, the response status).
   */
  normalizeError: (error: unknown, event: H3EventLike) => H3ErrorLike;
  /** Whether Nitro caches this route's rendered body (`cache` / `swr` route rules). */
  cachedRender?: (event: H3EventLike) => boolean;
  /** Hand the CSP nonce to the Nuxt app so it stamps it on the tags it renders (default true). */
  nonce?: boolean;
  /**
   * Use the socket address as the client IP (Node servers without a trusted proxy). Default false: the
   * pipeline reads `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` according to `security.trustedProxies`.
   */
  socketIp?: boolean;
}

/** The request-path predicate for Nuxt: build assets and media, plus everything under `buildAssetsDir`. */
export function nuxtSkip(buildAssetsPath = '/_nuxt/'): (url: URL) => boolean {
  const prefix = buildAssetsPath.endsWith('/') ? buildAssetsPath : `${buildAssetsPath}/`;
  return (url) => url.pathname.startsWith(prefix) || isStaticRequest(url);
}

/** Request facts for the Nuxt app (`useHyp()`, the nonce plugin), stored on `event.context.hypdriv`. */
export function factsFor(ctx: HypContext, options: { nonce: boolean }): HypEventContext {
  const view = requestContextFrom(ctx);
  return {
    requestId: view.requestId,
    runner: view.runner,
    route: view.route,
    country: view.country,
    locale: view.locale,
    cspMode: view.cspMode,
    flags: publicFlags(view.flags, ctx.config.flags.definitions),
    ...(options.nonce && view.nonce ? { nonce: view.nonce } : {}),
  };
}

function attachFacts(event: H3EventLike, ctx: HypContext, options: NitroHookOptions): void {
  const nonce = options.nonce !== false && !(options.cachedRender?.(event) ?? false);
  event.context[FACTS_KEY] = factsFor(ctx, { nonce });
}

/** Whether a HypDriv runner already owns this request (the Cloudflare Worker entry, or an outer host request). */
function ownedByOuterRunner(ctx: HypContext | undefined): ctx is HypContext {
  return !!ctx && (ctx.runner === 'worker' || ctx.runner === 'host');
}

function fallbackError(capture: CaptureResponse, error: H3ErrorLike): void {
  const statusCode = error.statusCode ?? 500;
  const statusMessage = error.unhandled ? 'Server Error' : (error.statusMessage ?? 'Server Error');
  capture.statusCode = statusCode;
  capture.setHeader('content-type', 'application/json');
  capture.end(JSON.stringify({ statusCode, statusMessage }));
}

/**
 * Wraps Nitro's h3 app handler (`nitroApp.h3App.handler`, the single function every request of every preset goes
 * through) with the HypDriv pipeline:
 *
 * - The pipeline's request stages run first; a short-circuit (rate limit, bot block, redirect, maintenance,
 *   `/_hypdriv/*`) answers without rendering.
 * - Otherwise Nitro renders into a `CaptureResponse` inside the request's `AsyncLocalStorage` context (so `hyp()`
 *   works in handlers, pages and error pages); the captured head and streaming body go through the response
 *   stages (security headers, CSP with nonce injection, Server-Timing…) and the result is written to the client.
 * - Errors are rendered by Nitro's error handler (Nuxt's error page) inside the same capture, so error responses
 *   get the full pipeline too.
 * - Requests inside an outer HypDriv runner (the Cloudflare Worker entry, Nitro sub-requests made while rendering)
 *   and Nitro's own in-memory sub-requests pass straight through.
 */
export function createNitroHandler(
  inner: (event: H3EventLike) => unknown,
  nitroApp: NitroAppLike,
  options: NitroHookOptions,
): (event: H3EventLike) => Promise<unknown> {
  const renderError = async (error: unknown, event: H3EventLike, capture: CaptureResponse) => {
    if (capture.headersSent) {
      nitroApp.captureError?.(error as Error, { event, tags: ['request'] });
      capture.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const normalized = options.normalizeError(error, event);
    try {
      await nitroApp.h3App.options.onError?.(normalized, event);
    } catch (handlerError) {
      nitroApp.captureError?.(handlerError as Error, { event, tags: ['request'] });
    }
    if (!event.handled && !capture.headersSent) fallbackError(capture, normalized);
  };

  const render = async (event: H3EventLike, capture: CaptureResponse) => {
    try {
      await inner(event);
    } catch (error) {
      await renderError(error, event, capture);
    } finally {
      capture.finishIfIdle();
    }
  };

  return async function hypdrivNitroHandler(event: H3EventLike): Promise<unknown> {
    const current = getCurrentContext();
    if (ownedByOuterRunner(current)) {
      attachFacts(event, current, options);
      return inner(event);
    }
    const req = event.node.req;
    if (isInternalSubRequest(req)) return inner(event);

    const original = event.node.res as NodeResponseLike;
    const method = (req.method ?? 'GET').toUpperCase();
    const abort = new AbortController();
    const state: {
      capture: CaptureResponse | null;
      rendering: Promise<void> | null;
      body: ReadableStream<Uint8Array> | null;
    } = { capture: null, rendering: null, body: null };
    const onClientClose = () => {
      if (original.writableEnded) return;
      abort.abort();
      state.capture?.clientClosed();
    };
    original.once?.('close', onClientClose);

    const request = toWebRequest(event, () => options.readRawBody(event), abort.signal);
    const skipped = options.skip(new URL(request.url));
    const direct = new Response(null, { status: 204 });
    const ip = options.socketIp ? req.socket?.remoteAddress : undefined;

    let response: Response;
    try {
      response = await options.handler(request, {
        ...platformOf(req),
        ...(ip ? { ip } : {}),
        upstream: async (forwarded) => {
          // Build assets: rendered straight onto the client response, exactly as without HypDriv.
          if (skipped) {
            await inner(event);
            return direct;
          }
          applyForwardedHeaders(event, forwarded.headers);
          const ctx = getCurrentContext();
          if (ctx) attachFacts(event, ctx, options);
          const capture = new CaptureResponse({ original, req });
          state.capture = capture;
          event.node.res = capture;
          state.rendering = render(event, capture);
          const head = await capture.response;
          state.body = head.body;
          return head;
        },
      });
    } catch (error) {
      // Nothing rendered yet: Nitro's own error handling answers (outside the pipeline).
      if (!state.capture) {
        original.off?.('close', onClientClose);
        throw error;
      }
      nitroApp.captureError?.(error as Error, { event, tags: ['request'] });
      response = new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (response === direct) {
      original.off?.('close', onClientClose);
      return;
    }
    try {
      await writeResponse(original, response, {
        method,
        keepContentLength: state.body !== null && response.body === state.body,
      });
    } finally {
      original.off?.('close', onClientClose);
    }
    const { capture, rendering } = state;
    if (!capture || !rendering) return;
    const done = rendering
      .catch(() => undefined)
      .finally(() => {
        event.node.res = original;
      });
    // A body the final response did not consume is dropped from here on.
    const consumed = capture.complete;
    capture.abandon();
    // The application finished writing the body the client received: let its `afterResponse` hooks settle.
    if (consumed) await done;
  };
}

/** Installs the HypDriv handler around a Nitro 2 app (called from the Nitro plugin). */
export function installNitroHook(nitroApp: NitroAppLike, options: NitroHookOptions): void {
  const inner = nitroApp.h3App.handler;
  nitroApp.h3App.handler = createNitroHandler(inner, nitroApp, options);
}
