import { isDev } from '@qwik.dev/core/build';
import { setServerPlatform } from '@qwik.dev/core/server';
import {
  _TextEncoderStream_polyfill,
  type ClientConn,
  getErrorHtml,
  isStaticPath,
  mergeHeadersCookies,
  requestHandler,
  ServerError,
  type ServerRenderOptions,
  type ServerRequestEvent,
} from '@qwik.dev/router/middleware/request-handler';

export { isStaticPath };

/** The default request body limit of Qwik's own adapters (10 MiB). */
export const DEFAULT_REQUEST_BODY_LIMIT = 10 * 1024 * 1024;

/** Qwik Router's render options plus the request body limit every Qwik adapter accepts. */
export interface QwikFetchOptions extends ServerRenderOptions {
  /** Largest request body in bytes before the request fails with 413 (default 10 MiB). */
  requestBodyLimit?: number;
}

/** What the platform contributes to one request. */
export interface QwikRequestContext {
  /** Reads an environment variable (`process.env` on Node, the bindings on Workers). */
  env(key: string): string | undefined;
  /** The `platform` object route handlers see (`requestEv.platform`). */
  platform: Record<string, unknown>;
  /** The client address and country (`requestEv.clientConn`). */
  clientConn(request: Request): ClientConn;
}

/** Qwik Router's request handler as a Web `fetch`: `null` when no route (and no static file) answers. */
export type QwikFetch = (request: Request, context: QwikRequestContext) => Promise<Response | null>;

/**
 * Qwik Router's `requestHandler` (the function every Qwik adapter calls) behind a Web `Request` → `Response`
 * interface, so one implementation serves Node, Vercel and Workers behind the Hypdriv Drivetrain. It follows Qwik's
 * own Web adapters (`@qwik.dev/router/middleware/cloudflare-pages`, `…/vercel-edge`): the same request event, the
 * same response streaming, the same request body limit.
 */
export function createQwikFetch(options: QwikFetchOptions): QwikFetch {
  try {
    new globalThis.TextEncoderStream();
  } catch {
    (globalThis as { TextEncoderStream?: unknown }).TextEncoderStream = _TextEncoderStream_polyfill;
  }
  if (options.manifest) setServerPlatform(options.manifest);
  const limit = options.requestBodyLimit ?? DEFAULT_REQUEST_BODY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new TypeError('requestBodyLimit must be a positive safe integer');

  return async (request, context) => {
    const serverRequestEv: ServerRequestEvent<Response> = {
      mode: 'server',
      locale: undefined,
      url: new URL(request.url),
      request: limitRequestBody(request, limit),
      env: { get: (key) => context.env(key) as string },
      platform: context.platform as ServerRequestEvent['platform'],
      getClientConn: () => context.clientConn(request),
      getWritableStream: (status, headers, cookies, resolve) => {
        const init = { status, headers: mergeHeadersCookies(headers, cookies) };
        if (status === 204 || status === 205 || status === 304) {
          resolve(new Response(null, init));
          return new WritableStream();
        }
        const { readable, writable } = new TransformStream();
        resolve(new Response(readable, init));
        return writable;
      },
    };
    const handled = await requestHandler(serverRequestEv, options);
    if (!handled) return null;
    void handled.completion.then((completion) => {
      if (completion) console.error(completion);
    });
    return (await handled.response) ?? null;
  };
}

/**
 * Fails the request with 413 once the body exceeds `limit` bytes (Qwik's `limitRequestBody`: the chunk that crosses
 * the limit raises a `ServerError`, which Qwik answers with the status).
 */
export function limitRequestBody(request: Request, limit: number): Request {
  if (!request.body) return request;
  let received = 0;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength > limit - received)
          throw new ServerError(413, `Request body exceeds ${limit} bytes`);
        received += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  return new Request(request, { body, duplex: 'half' } as RequestInit);
}

/** The response when nothing answered: Qwik's own error page for browsers, `Not Found` for everything else. */
export function notFoundResponse(request: Request): Response {
  const url = new URL(request.url);
  const html =
    request.headers.get('accept')?.includes('text/html') && !isStaticPath(request.method || 'GET', url);
  return new Response(html ? getErrorHtml(404, 'Not Found') : 'Not Found', {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-not-found': url.pathname },
  });
}

/** The response for an unhandled failure: the message in development, a generic body in production. */
export function errorResponse(error: unknown, source: string): Response {
  console.error(error);
  return new Response(isDev ? String(error || 'Error') : 'Internal Server Error', {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-error': source },
  });
}
