import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { ResolvedConfig } from '@hypdriv/core';
import { applySecurityHeaders, buildSecurityHeaders } from '@hypdriv/security';

/**
 * `@hypdriv/runtime/node` — the Node ↔ Web bridge the server-framework hosts (Express, Fastify) build on. The
 * pipeline works on Web `Request`/`Response` objects; these frameworks hand applications the Node request
 * stream and write to the Node response, so the bridge has to meet two rules the plain `Readable.toWeb(req)`
 * conversion breaks:
 *
 * - The application, not the pipeline, owns the request body. `NodeRequestBody` is read only when a stage asks for
 *   it, and `release()` puts whatever it took back, so a body parser further down reads the complete body.
 * - Responses stream. `writeWebResponse()` writes chunk by chunk with backpressure and never buffers the body.
 */

/** Where a request's URL gets its scheme and host from. */
export interface RequestOriginOptions {
  /** The public origin (`https://example.com`); wins over everything else. */
  origin?: string;
  /** Trust `x-forwarded-proto` / `x-forwarded-host` (a reverse proxy in front of the server). */
  trustProxy?: boolean;
  /** The request target to use instead of `req.originalUrl ?? req.url` (a router that rewrites `req.url`). */
  url?: string;
}

const FALLBACK_ORIGIN = 'http://localhost';
const HOST_PATTERN = /^[A-Za-z0-9.\-_~%[\]:]+$/;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.split(',')[0]?.trim() || undefined;
}

/**
 * The absolute URL of a Node request. The request target is appended to the origin as text, never resolved against
 * it: `//evil.example/x` is a path on this host, not a protocol-relative URL for another one.
 */
export function requestUrl(req: IncomingMessage, options: RequestOriginOptions = {}): URL {
  const target =
    options.url ?? (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    // Absolute-form request target (a forward proxy): keep it.
    try {
      return new URL(target);
    } catch {
      return new URL('/', options.origin ?? FALLBACK_ORIGIN);
    }
  }
  const path = target.startsWith('/') ? target : `/${target === '*' ? '' : target}`;
  const proxied = options.trustProxy === true;
  const forwardedProto = proxied ? first(req.headers['x-forwarded-proto'])?.toLowerCase() : undefined;
  const protocol =
    forwardedProto === 'http' || forwardedProto === 'https'
      ? forwardedProto
      : (req.socket as { encrypted?: boolean } | undefined)?.encrypted
        ? 'https'
        : 'http';
  const forwardedHost = proxied ? first(req.headers['x-forwarded-host']) : undefined;
  const host = forwardedHost ?? first(req.headers.host);
  const origin =
    options.origin ?? (host && HOST_PATTERN.test(host) ? `${protocol}://${host}` : FALLBACK_ORIGIN);
  try {
    return new URL(`${origin.replace(/\/+$/, '')}${path}`);
  } catch {
    return new URL(path.startsWith('//') ? `/${path.replace(/^\/+/, '')}` : path, FALLBACK_ORIGIN);
  }
}

/** Web `Headers` from Node's parsed request headers (cookies already joined the way Node joins them). */
export function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(':')) continue;
    try {
      if (Array.isArray(value)) for (const v of value) out.append(name, v);
      else out.set(name, value);
    } catch {
      // A header name or value Web `Headers` refuses cannot have come through Node's parser; drop it.
    }
  }
  return out;
}

/** The headers of a Web `Response` as Node wants them: `set-cookie` as an array, the rest as strings. */
export function nodeHeaders(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  headers.forEach((value, name) => {
    if (name !== 'set-cookie') out[name] = value;
  });
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (cookies.length) out['set-cookie'] = cookies;
  return out;
}

/** The peer address of a request, or `undefined` when the socket has none (an in-memory exchange). */
export function remoteAddress(req: IncomingMessage): string | undefined {
  return req.socket?.remoteAddress ?? undefined;
}

type Waiter = () => void;

/**
 * A request body that is read from the Node request only when something on the Web side pulls it.
 *
 * Node request bodies are one-shot streams that body parsers further down the chain read. A stage that inspects the
 * body (the CSRF form token, a Turnstile token) must not take it away from them, so the bridge keeps what the Web
 * side consumed and `release()` hands it back with `unshift()`. The end of the body is detected from the parser's
 * state (`complete`) instead of by reading to the end, because reading the end of a stream is what schedules its
 * `end` event, after which nothing can be put back.
 */
export class NodeRequestBody {
  /** The lazy Web stream; give it to `new Request(url, { body, duplex: 'half' })`. */
  readonly stream: ReadableStream<Uint8Array>;
  readonly #req: IncomingMessage;
  #taken: Buffer[] = [];
  #released = false;
  #closed = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #wake: Waiter | null = null;

  constructor(req: IncomingMessage) {
    this.#req = req;
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => this.#pull(controller),
        cancel: () => {
          this.#wake?.();
        },
      },
      // Pull on demand only: nothing is read from the request until a reader asks.
      { highWaterMark: 0 },
    );
  }

  /** Bytes the Web side has read from the request so far. */
  get bytesRead(): number {
    return this.#taken.reduce((n, chunk) => n + chunk.length, 0);
  }

  /** Whether `release()` already handed the request back. */
  get released(): boolean {
    return this.#released;
  }

  #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    this.#controller = controller;
    const req = this.#req;
    return new Promise<void>((resolve) => {
      const done = () => {
        this.#wake = null;
        req.off('readable', retry);
        req.off('close', retry);
        req.off('error', retry);
        resolve();
      };
      const attempt = () => {
        if (this.#released && !this.#closed) {
          // The body belongs to the application now: a late read of the Web stream fails instead of hanging.
          this.#closed = true;
          controller.error(new Error('the request body was handed to the application'));
          return done();
        }
        if (this.#closed) return done();
        if (req.readableLength > 0) {
          // Reading exactly what is buffered keeps `read()` from scheduling the stream's `end` event.
          const chunk = req.read(req.readableLength) as Buffer | string | null;
          if (chunk !== null && chunk.length > 0) {
            const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            this.#taken.push(buffer);
            controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
            return done();
          }
        }
        if (req.complete && req.readableLength === 0) {
          this.#closed = true;
          controller.close();
          return done();
        }
        if (req.destroyed || req.errored) {
          this.#closed = true;
          controller.error(new Error('the request was aborted before its body was complete'));
          return done();
        }
        // Nothing buffered yet: wait for the next chunk (or for the connection to go away).
        req.once('readable', retry);
        req.once('close', retry);
        req.once('error', retry);
        this.#wake = done;
      };
      const retry = () => {
        req.off('readable', retry);
        req.off('close', retry);
        req.off('error', retry);
        attempt();
      };
      attempt();
    });
  }

  /**
   * Detaches the Web stream from the request and puts back every byte it took, so the application reads the
   * complete body from the Node request as if the pipeline had never looked at it. Idempotent. Further reads of
   * the Web stream fail: the body belongs to the application now.
   */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    const req = this.#req;
    const taken = this.#taken;
    this.#taken = [];
    this.#wake?.();
    if (taken.length && !req.destroyed && !req.readableEnded) {
      for (let i = taken.length - 1; i >= 0; i--) req.unshift(taken[i]!);
    }
    if (!this.#closed && this.#controller) {
      this.#closed = true;
      try {
        this.#controller.error(new Error('the request body was handed to the application'));
      } catch {
        // The stream was already closed or errored.
      }
    }
  }
}

/** A Node request as the pipeline sees it. */
export interface BridgedRequest {
  request: Request;
  /** The lazy body, or `null` for requests without one (GET, HEAD, no `content-length`). */
  body: NodeRequestBody | null;
  /** Aborts `request.signal` (the client went away). */
  abort(reason?: unknown): void;
}

function hasBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined) return true;
  return length !== undefined && length !== '0';
}

/**
 * Converts a Node request into a Web `Request` without consuming it. `request.body` is lazy: reading it reads the
 * Node request, and `bridged.body.release()` returns what was read.
 */
export function bridgeRequest(req: IncomingMessage, options: RequestOriginOptions = {}): BridgedRequest {
  const url = requestUrl(req, options);
  const method = (req.method ?? 'GET').toUpperCase();
  const controller = new AbortController();
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: toWebHeaders(req.headers),
    signal: controller.signal,
  };
  let body: NodeRequestBody | null = null;
  if (method !== 'GET' && method !== 'HEAD' && hasBody(req)) {
    body = new NodeRequestBody(req);
    init.body = body.stream;
    init.duplex = 'half';
  }
  return { request: new Request(url, init), body, abort: (reason) => controller.abort(reason) };
}

/**
 * Makes the Node request carry the pipeline's headers: the client's `x-hypdriv-*` and nonce headers are gone, the
 * stages' own (`x-hypdriv-route`, the nonce header…) are in, so the application reads exactly what the other hosts'
 * applications get in the forwarded `Request`. `req.headers` and `req.rawHeaders` are replaced together.
 */
export function syncRequestHeaders(req: IncomingMessage, headers: Headers): void {
  const next: IncomingHttpHeaders = {};
  const raw: string[] = [];
  headers.forEach((value, name) => {
    next[name] = value;
    raw.push(name, value);
  });
  req.headers = next;
  req.rawHeaders = raw;
}

/** What `writeWebResponse` calls; the defaults are the response's own methods. */
export interface ResponseWriters {
  /** Sends the status line and the headers currently set on the response. */
  writeHead(status: number, statusMessage?: string): void;
  write(chunk: Uint8Array): boolean;
  end(): void;
}

export interface WriteResponseOptions {
  /** The request method (`HEAD` responses carry no body). */
  method?: string;
  /**
   * Clears the headers already set on the response before the Web response's go in. Needed when the Web response
   * was derived from that very response (a middleware that captured it): its headers are already in the Web
   * response, the ones that the pipeline removed must not come back.
   */
  replaceHeaders?: boolean;
  /** Writers to use instead of the response's current methods (they may have been replaced by a capture). */
  writers?: ResponseWriters;
}

function defaultWriters(res: ServerResponse): ResponseWriters {
  return {
    writeHead: (status, statusMessage) => {
      if (statusMessage) res.writeHead(status, statusMessage);
      else res.writeHead(status);
    },
    write: (chunk) => res.write(chunk),
    end: () => {
      res.end();
    },
  };
}

function bodyless(status: number, method: string): boolean {
  return method === 'HEAD' || status === 204 || status === 205 || status === 304;
}

/**
 * Writes a Web `Response` to a Node response: the status line, the headers (`set-cookie` as separate fields),
 * then the body chunk by chunk, waiting for `drain` when the socket is slow and stopping when the client leaves.
 * The body is never buffered. A body that fails mid-stream destroys the response (the client sees a truncated
 * transfer, never a complete-looking one).
 */
export async function writeWebResponse(
  res: ServerResponse,
  response: Response,
  options: WriteResponseOptions = {},
): Promise<void> {
  const writers = options.writers ?? defaultWriters(res);
  const method = (options.method ?? 'GET').toUpperCase();
  if (options.replaceHeaders) for (const name of res.getHeaderNames()) res.removeHeader(name);
  for (const [name, value] of Object.entries(nodeHeaders(response.headers))) res.setHeader(name, value);
  // The status text only when the application set one: Node derives the standard text from the code.
  writers.writeHead(response.status, response.statusText || undefined);
  const body = response.body;
  if (!body || bodyless(response.status, method)) {
    writers.end();
    // Never await a body cancel: it may not settle (AGENTS.md pitfalls).
    void body?.cancel().catch(() => undefined);
    return;
  }
  const reader = body.getReader();
  let closed = false;
  const onClose = () => {
    closed = true;
    void reader.cancel().catch(() => undefined);
  };
  res.once('close', onClose);
  try {
    for (;;) {
      if (closed) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (!writers.write(value) && !closed) {
        await new Promise<void>((resolve) => {
          const resume = () => {
            res.off('drain', resume);
            res.off('close', resume);
            resolve();
          };
          res.once('drain', resume);
          res.once('close', resume);
        });
      }
    }
    if (!closed) writers.end();
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    res.off('close', onClose);
  }
}

/**
 * The security header preset on a response the pipeline did not see: static files (`express.static`,
 * `@fastify/static`, `res.sendFile`) that `skip` kept out of the stages. Headers the file response already carries
 * stay, `x-powered-by`/`server` go when `security.headers.stripFingerprints` is on. This is the Node-side
 * counterpart of the static header rules other hosts write into the platform's static configuration.
 */
export function withAssetHeaders(
  config: ResolvedConfig,
  request: Request,
  response: Response,
  options: { development?: boolean } = {},
): Response {
  const headers = config.security.headers;
  if (!headers) return response;
  const url = new URL(request.url);
  const proto = (
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '')
  ).toLowerCase();
  const built = buildSecurityHeaders(headers, {
    development: options.development ?? false,
    https: proto === 'https',
    pathname: url.pathname,
  });
  return applySecurityHeaders(response, built, { stripFingerprints: headers.stripFingerprints });
}
