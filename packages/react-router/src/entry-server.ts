import { nonce as requestNonce } from '@hypdriv/runtime';
import { isbot } from 'isbot';
import { createElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { type EntryContext, type RouterContextProvider, ServerRouter } from 'react-router';

/**
 * `@hypdriv/react-router/entry.server` — React Router's server entry with Hypdriv's CSP nonce: `ServerRouter` and
 * React put the request's nonce on every script they render (hydration data, module imports, streamed chunks,
 * `<Scripts>`, `<ScrollRestoration>`). Re-export it from `app/entry.server.tsx`:
 *
 * ```ts
 * export { default, streamTimeout } from '@hypdriv/react-router/entry.server';
 * ```
 *
 * It renders with Web streams (`renderToReadableStream`) on every platform — Node 22+, Cloudflare Workers and
 * Vercel — like React Router's default entry. Prerendered pages render without a nonce (their scripts are allowed
 * by hash); requests outside a Hypdriv runner render without one too.
 */

/** Milliseconds React Router waits for deferred data before aborting the stream. */
export const streamTimeout = 5_000;

export interface HandleRequestOptions {
  /** Milliseconds before pending deferred data is aborted (default `streamTimeout`). */
  streamTimeout?: number;
  /**
   * Wait for every Suspense boundary before responding. Default: crawlers (`isbot`), SPA mode and React Router's
   * prerendering, like React Router's default entry.
   */
  waitForAll?: (request: Request, context: EntryContext) => boolean;
  /** Reports errors thrown while streaming after the shell rendered (default `console.error`). */
  onError?: (error: unknown) => void;
  /** The nonce of the request (default: Hypdriv's, `nonce()`). */
  nonce?: (request: Request) => string | undefined;
}

export type HandleRequestFunction = (
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) => Promise<Response>;

function defaultWaitForAll(request: Request, context: EntryContext): boolean {
  const userAgent = request.headers.get('user-agent');
  return (
    (userAgent !== null && isbot(userAgent)) ||
    context.isSpaMode ||
    request.headers.get('x-react-router-prerender') === 'yes'
  );
}

/** Creates a `handleRequest` (the default export of `entry.server`) with Hypdriv's nonce. */
export function createHandleRequest(options: HandleRequestOptions = {}): HandleRequestFunction {
  const timeout = options.streamTimeout ?? streamTimeout;
  const waitForAll = options.waitForAll ?? defaultWaitForAll;
  const report = options.onError ?? ((error: unknown) => console.error(error));
  return async (request, responseStatusCode, responseHeaders, routerContext) => {
    // https://httpwg.org/specs/rfc9110.html#HEAD
    if (request.method.toUpperCase() === 'HEAD')
      return new Response(null, { status: responseStatusCode, headers: responseHeaders });
    const nonce = options.nonce ? options.nonce(request) : requestNonce();
    let status = responseStatusCode;
    let shellRendered = false;
    const body = await renderToReadableStream(
      createElement(ServerRouter, { context: routerContext, url: request.url, ...(nonce ? { nonce } : {}) }),
      {
        ...(nonce ? { nonce } : {}),
        signal: AbortSignal.timeout(timeout + 1000),
        onError(error: unknown) {
          status = 500;
          // Errors of the initial shell reject `renderToReadableStream` and React Router logs them.
          if (shellRendered) report(error);
        },
      },
    );
    shellRendered = true;
    if (waitForAll(request, routerContext)) await body.allReady;
    responseHeaders.set('Content-Type', 'text/html');
    return new Response(body, { headers: responseHeaders, status });
  };
}

/** React Router's `handleRequest` with Hypdriv's CSP nonce. */
const handleRequest: HandleRequestFunction = createHandleRequest();
export default handleRequest;
