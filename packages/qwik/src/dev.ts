import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { HypHandler } from '@hypdriv/runtime';
import { isViteInternal } from '@hypdriv/vite';

type Next = (error?: unknown) => void;
type Write = ServerResponse['write'];
type End = ServerResponse['end'];
type WriteHead = ServerResponse['writeHead'];

/** The methods of `ServerResponse` the capture replaces, as they were before. */
interface Originals {
  write: Write;
  end: End;
  writeHead: WriteHead;
  flushHeaders: () => void;
}

const BODYLESS = new Set([101, 204, 205, 304]);

/** A Web `Request` for the pipeline. The body is not attached: Qwik reads it from the Node request itself. */
export function pipelineRequest(req: IncomingMessage): Request {
  const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  const url = new URL(req.originalUrl ?? req.url ?? '/', `${proto}://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (!name.startsWith(':')) headers.append(name, req.rawHeaders[i + 1]!);
  }
  const method = req.method ?? 'GET';
  return new Request(url, { method, headers });
}

declare module 'node:http' {
  interface IncomingMessage {
    originalUrl?: string;
  }
}

const QWIK_LOADER = /\/q-loader-[^/]+\.json$/;

/** Whether the dev pipeline wraps the request: everything Vite itself serves (modules, HMR, assets) is left alone. */
export function wantsRequest(url: URL, method: string): boolean {
  if (url.pathname.startsWith('/_hypdriv/')) return true;
  // Route loader data (`<page>/q-loader-<id>.<hash>.json`) is a request to the application, not a JSON module.
  if (QWIK_LOADER.test(url.pathname)) return true;
  if (isViteInternal(url.pathname)) return false;
  // Hashed build files and media are never wrapped; documents, loaders, actions and endpoints are.
  if ((method === 'GET' || method === 'HEAD') && /\.[a-z0-9]{1,8}$/i.test(url.pathname)) {
    return /\.(?:json|xml|txt|html?)$/i.test(url.pathname);
  }
  return true;
}

function toBytes(chunk: unknown, encoding?: BufferEncoding): Uint8Array {
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding);
  if (chunk instanceof Uint8Array) return chunk;
  return Buffer.from(String(chunk));
}

function headersOf(res: ServerResponse): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.append(name, String(value));
  }
  return headers;
}

/**
 * Runs the rest of Vite's middleware stack (Qwik Router's dev SSR middleware) with the response captured: what the
 * stack writes becomes the `Response` the pipeline decorates. The captured methods replace `write`, `end` and
 * `writeHead` of the real response for the duration of the request; the originals send the final response.
 */
export function captureDownstream(
  req: IncomingMessage,
  res: ServerResponse,
  next: Next,
  forwarded: Request,
): Promise<Response> {
  // The pipeline's forwarded request is what Qwik's middleware sees: sanitised headers plus the stages' own.
  const headers: IncomingHttpHeaders = {};
  forwarded.headers.forEach((value, name) => {
    headers[name] = value;
  });
  req.headers = headers;

  return new Promise<Response>((resolve, reject) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    let started = false;
    let closed = false;
    const begin = () => {
      if (started) return;
      started = true;
      resolve(
        new Response(BODYLESS.has(res.statusCode) ? null : stream, {
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: headersOf(res),
        }),
      );
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      begin();
      try {
        controller.close();
      } catch {
        // the consumer cancelled the stream
      }
      // Qwik's response sink waits for the response to finish; the real `finish` follows when the pipeline's
      // response has been sent.
    };

    res.writeHead = ((status: number, ...rest: unknown[]) => {
      res.statusCode = status;
      const given = rest.find((value) => typeof value === 'object' && value !== null) as
        | Record<string, string | number | string[]>
        | unknown[]
        | undefined;
      if (Array.isArray(given)) {
        for (let i = 0; i + 1 < given.length; i += 2) res.setHeader(String(given[i]), given[i + 1] as string);
      } else if (given) {
        for (const [name, value] of Object.entries(given)) res.setHeader(name, value as string | string[]);
      }
      if (typeof rest[0] === 'string') res.statusMessage = rest[0];
      return res;
    }) as WriteHead;
    res.flushHeaders = () => undefined;
    res.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      begin();
      const encoding =
        typeof encodingOrCallback === 'string' ? (encodingOrCallback as BufferEncoding) : undefined;
      if (!closed && chunk !== undefined && chunk !== null) {
        try {
          controller.enqueue(toBytes(chunk, encoding));
        } catch {
          // the consumer cancelled the stream
        }
      }
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
      return true;
    }) as Write;
    res.end = ((chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      if (typeof chunk === 'function') {
        finish();
        queueMicrotask(chunk as () => void);
        return res;
      }
      if (chunk !== undefined && chunk !== null)
        (res.write as (c: unknown, e?: unknown) => boolean)(chunk, encodingOrCallback);
      finish();
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
      return res;
    }) as End;

    try {
      next();
    } catch (error) {
      reject(error);
    }
  });
}

/** Writes a Web `Response` to the real Node response with the methods `captureDownstream` replaced. */
export async function sendCaptured(
  res: ServerResponse,
  response: Response,
  method: string,
  originals: Originals,
): Promise<void> {
  const out: Record<string, string | string[]> = {};
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') out[name] = value;
  });
  // The captured headers were set on the real response; the pipeline's final set replaces them.
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  if (cookies.length) out['set-cookie'] = cookies;
  (originals.writeHead as (status: number, headers: Record<string, string | string[]>) => unknown).call(
    res,
    response.status,
    out,
  );
  if (!response.body || method === 'HEAD' || BODYLESS.has(response.status)) {
    (originals.end as () => unknown).call(res);
    void response.body?.cancel().catch(() => undefined);
    return;
  }
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  res.once('close', abort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(originals.write as (chunk: Uint8Array) => boolean).call(res, value))
        await new Promise<void>((resolve) => res.once('drain', resolve));
    }
    (originals.end as () => unknown).call(res);
  } catch (error) {
    res.destroy(error as Error);
  } finally {
    res.off('close', abort);
  }
}

/** Puts back the response methods `captureDownstream` replaced. */
export function restore(res: ServerResponse, originals: Originals): void {
  res.write = originals.write;
  res.end = originals.end;
  res.writeHead = originals.writeHead;
  res.flushHeaders = originals.flushHeaders;
}

/**
 * Connect middleware that runs the Hypdriv pipeline around Qwik Router's dev SSR: it sits in front of Qwik's
 * middleware, hands the request on through `next()` with the response captured, and sends what the pipeline
 * returns (security headers, CSP with the request's nonce injected into the document, rate limits, `/_hypdriv/*`).
 */
export function devMiddleware(input: {
  handler: () => Promise<HypHandler>;
  wants?: (url: URL, method: string) => boolean;
}): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  const wants = input.wants ?? wantsRequest;
  return (req, res, next) => {
    void (async () => {
      const real: Originals = {
        write: res.write,
        end: res.end,
        writeHead: res.writeHead,
        flushHeaders: res.flushHeaders,
      };
      try {
        const request = pipelineRequest(req);
        if (!wants(new URL(request.url), request.method)) return next();
        const handler = await input.handler();
        const response = await handler(request, {
          ip: req.socket.remoteAddress ?? '127.0.0.1',
          // Vite answers requests nothing handles with its own 404: the pipeline still decorates it.
          upstream: (forwarded) => captureDownstream(req, res, next, forwarded),
        });
        await sendCaptured(res, response, request.method, real);
      } catch (error) {
        restore(res, real);
        next(error);
      } finally {
        restore(res, real);
      }
    })();
  };
}
