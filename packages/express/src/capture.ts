import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { ResponseWriters } from '@hypdriv/runtime/node';

type Callback = (error?: Error | null) => void;
type WriteHead = (status: number, a?: unknown, b?: unknown) => ServerResponse;
type Write = (chunk: unknown, a?: unknown, b?: unknown) => boolean;
type End = (a?: unknown, b?: unknown, c?: unknown) => ServerResponse;

const BODY_QUEUE_BYTES = 64 * 1024;

/** The methods and properties a capture replaces on the response instance, to put back afterwards. */
const PATCHED = ['writeHead', 'write', 'end', 'flushHeaders'] as const;

function httpError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function toBytes(chunk: unknown, encoding: unknown): Uint8Array {
  if (typeof chunk === 'string')
    return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw httpError(
    'ERR_INVALID_ARG_TYPE',
    'The "chunk" argument must be of type string or an instance of Buffer, TypedArray, or DataView.',
  );
}

function headerPairs(headers: unknown): Array<[string, string | string[]]> {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    const flat = headers as unknown[];
    const out: Array<[string, string | string[]]> = [];
    if (flat.length && Array.isArray(flat[0]))
      for (const pair of flat as Array<[string, string]>) out.push([pair[0], pair[1]]);
    else for (let i = 0; i + 1 < flat.length; i += 2) out.push([String(flat[i]), String(flat[i + 1])]);
    return out;
  }
  return Object.entries(headers as OutgoingHttpHeaders)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [
      name,
      Array.isArray(value) ? value.map(String) : String(value as string | number),
    ]);
}

/**
 * Takes over the response of an Express request so that what the application writes becomes a Web `Response` —
 * status and headers as soon as the application commits them, the body as a stream that is fed by
 * `res.write()`/`res.end()` and applies backpressure — instead of going out on the socket.
 *
 * This is the interception technique Express' own ecosystem uses (`compression`, `on-headers`, `response-time`,
 * `express-session` replace `res.writeHead`/`write`/`end` on the response they are handed): it replaces them on the
 * one response object for the one request, with no change to Express or to `http`. `res.headersSent` answers
 * for the captured head, so `finalhandler`, `send` and error handlers behave as on an ordinary response. Headers
 * stay in `res`'s header store (`getHeader()` keeps working); `writers` are the methods the response had before
 * the capture, which the pipeline's final response is written with.
 */
export class ResponseCapture {
  /** Resolves with the application's response when it commits its status and headers. */
  readonly response: Promise<Response>;
  /** The response's own writers from before the capture (an outer `compression` layer's included). */
  readonly writers: ResponseWriters;

  readonly #req: IncomingMessage;
  readonly #res: ServerResponse;
  readonly #originals: Record<(typeof PATCHED)[number], (...args: never[]) => unknown>;
  #resolve!: (response: Response) => void;
  #reject!: (error: unknown) => void;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #headSent = false;
  #ended = false;
  #cancelled = false;
  #needsDrain = false;
  #patched = false;

  constructor(req: IncomingMessage, res: ServerResponse) {
    this.#req = req;
    this.#res = res;
    const target = res as unknown as Record<string, (...args: never[]) => unknown>;
    this.#originals = {
      writeHead: target.writeHead!.bind(res) as never,
      write: target.write!.bind(res) as never,
      end: target.end!.bind(res) as never,
      flushHeaders: target.flushHeaders!.bind(res) as never,
    };
    const original = this.#originals as unknown as {
      writeHead: (status: number, message?: string) => void;
      write: (chunk: Uint8Array) => boolean;
      end: () => void;
    };
    this.writers = {
      writeHead: (status, message) =>
        message ? original.writeHead(status, message) : original.writeHead(status),
      write: (chunk) => original.write(chunk),
      end: () => original.end(),
    };
    this.response = new Promise<Response>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.#install();
  }

  /** Whether the application committed status and headers. */
  get headSent(): boolean {
    return this.#headSent;
  }

  /** Whether the application ended the response. */
  get ended(): boolean {
    return this.#ended;
  }

  #install(): void {
    const res = this.#res as unknown as Record<string, unknown>;
    res.writeHead = ((status: number, a?: unknown, b?: unknown) =>
      this.#writeHead(status, a, b)) as WriteHead;
    res.write = ((chunk: unknown, a?: unknown, b?: unknown) => this.#write(chunk, a, b)) as Write;
    res.end = ((a?: unknown, b?: unknown, c?: unknown) => this.#end(a, b, c)) as End;
    res.flushHeaders = () => this.#commit();
    Object.defineProperty(res, 'headersSent', { configurable: true, get: () => this.#headSent });
    this.#patched = true;
  }

  /** Puts the response's own methods back (the response is done, or the capture is abandoned). */
  restore(): void {
    if (!this.#patched) return;
    this.#patched = false;
    const res = this.#res as unknown as Record<string, unknown>;
    for (const name of PATCHED) res[name] = this.#originals[name];
    delete res.headersSent;
  }

  /** The application will never answer (an error before it did): fails the pending response. */
  fail(error: unknown): void {
    if (this.#headSent) {
      try {
        this.#controller?.error(error);
      } catch {
        // already closed
      }
      return;
    }
    this.#headSent = true;
    this.#reject(error);
  }

  #bodyless(status: number): boolean {
    return this.#req.method === 'HEAD' || status === 204 || status === 205 || status === 304;
  }

  /** Commits the head with the response's status and headers now (the implicit header of Node's `write`/`end`). */
  #commit(): ServerResponse {
    if (!this.#headSent) {
      // Through the property, so layers that wrapped `writeHead` after the capture (`on-headers`) still run.
      (this.#res.writeHead as unknown as (status: number) => unknown)(this.#res.statusCode);
    }
    return this.#res;
  }

  #writeHead(status: number, a?: unknown, b?: unknown): ServerResponse {
    const res = this.#res;
    if (this.#headSent)
      throw httpError('ERR_HTTP_HEADERS_SENT', 'Cannot write headers after they are sent to the client');
    const code = Number(status);
    if (!Number.isInteger(code) || code < 200 || code > 599)
      throw Object.assign(
        new RangeError(
          `Invalid status code: ${String(status)}. Responses captured by Hypdriv need a status from 200 to 599.`,
        ),
        { code: 'ERR_HTTP_INVALID_STATUS_CODE' },
      );
    const message = typeof a === 'string' ? a : undefined;
    const given = typeof a === 'string' ? b : a;
    res.statusCode = code;
    if (message) res.statusMessage = message;
    const headers = new Headers();
    const add = (name: string, value: string | string[], replace: boolean) => {
      if (replace) headers.delete(name);
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    };
    for (const [name, value] of Object.entries(res.getHeaders()))
      if (value !== undefined) add(name, Array.isArray(value) ? value : String(value), false);
    for (const [name, value] of headerPairs(given)) add(name, value, true);
    this.#headSent = true;
    const body = this.#bodyless(code)
      ? null
      : new ReadableStream<Uint8Array>(
          {
            start: (controller) => {
              this.#controller = controller;
            },
            pull: () => {
              if (this.#needsDrain) {
                this.#needsDrain = false;
                this.#res.emit('drain');
              }
            },
            cancel: () => {
              this.#cancelled = true;
              if (this.#needsDrain) {
                this.#needsDrain = false;
                this.#res.emit('drain');
              }
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark: BODY_QUEUE_BYTES }),
        );
    try {
      this.#resolve(new Response(body, { status: code, statusText: res.statusMessage || '', headers }));
    } catch (error) {
      this.#reject(error);
    }
    return res;
  }

  #write(chunk: unknown, a?: unknown, b?: unknown): boolean {
    const callback = (typeof a === 'function' ? a : b) as Callback | undefined;
    const encoding = typeof a === 'function' ? undefined : a;
    if (this.#ended) {
      const error = httpError('ERR_STREAM_WRITE_AFTER_END', 'write after end');
      queueMicrotask(() => {
        this.#res.emit('error', error);
        callback?.(error);
      });
      return true;
    }
    this.#commit();
    const bytes = toBytes(chunk, encoding);
    let accepting = true;
    if (bytes.byteLength && this.#controller && !this.#cancelled) {
      try {
        this.#controller.enqueue(bytes);
        accepting = (this.#controller.desiredSize ?? 0) > 0;
      } catch {
        // The body stream is closed or errored (the client left): drop the chunk.
      }
    }
    if (!accepting) this.#needsDrain = true;
    if (callback) queueMicrotask(() => callback());
    return accepting;
  }

  #end(a?: unknown, b?: unknown, c?: unknown): ServerResponse {
    const res = this.#res;
    let chunk: unknown;
    let encoding: unknown;
    let callback: Callback | undefined;
    if (typeof a === 'function') callback = a as Callback;
    else {
      chunk = a;
      if (typeof b === 'function') callback = b as Callback;
      else {
        encoding = b;
        if (typeof c === 'function') callback = c as Callback;
      }
    }
    if (this.#ended) {
      if (callback) queueMicrotask(() => callback());
      return res;
    }
    if (chunk !== undefined && chunk !== null && chunk !== '') this.#write(chunk, encoding);
    this.#commit();
    this.#ended = true;
    try {
      this.#controller?.close();
    } catch {
      // closed by a cancel
    }
    // Node calls the end callback on `finish`, i.e. when the pipeline's response has been written.
    if (callback) res.once('finish', () => callback?.());
    return res;
  }
}
