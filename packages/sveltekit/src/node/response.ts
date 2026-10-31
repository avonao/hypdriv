import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http';
import { Writable } from 'node:stream';

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

type HeaderValue = number | string | readonly string[];

/**
 * A `ServerResponse` stand-in that turns what a Node request handler writes (adapter-node's static file server and
 * SvelteKit's `setResponse`) into a Web `Response`, streamed with backpressure: `response` resolves when the head is
 * sent (`writeHead`, the first `write`, or `end`), the body streams as it is written, and cancelling the body
 * destroys the stand-in (the handler sees a closed connection). It implements the subset of `ServerResponse`
 * those handlers use: headers, `writeHead`, `statusCode`, `write`/`end` (it is a `Writable`, so `pipe` and
 * `stream.pipeline` work), `headersSent`, `req` and the `finish` / `close` / `drain` events.
 */
export class CapturedResponse extends Writable {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;
  readonly req: IncomingMessage;
  sendDate = true;
  readonly response: Promise<Response>;
  readonly #headers = new Map<string, { name: string; value: HeaderValue }>();
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #body: ReadableStream<Uint8Array> | null = null;
  #closed = false;
  #waiting: (() => void) | null = null;
  #resolve!: (response: Response) => void;
  #reject!: (error: unknown) => void;
  readonly #method: string;

  constructor(req: IncomingMessage) {
    super({ highWaterMark: 64 * 1024, decodeStrings: true });
    this.req = req;
    this.#method = (req.method ?? 'GET').toUpperCase();
    this.response = new Promise<Response>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A rejection nobody awaits (the handler failed before the head) must not crash the process; errors reach the
    // consumer through `response` or the body stream, so the stream's own `error` event needs no listener.
    this.response.catch(() => undefined);
    this.on('error', () => undefined);
  }

  setHeader(name: string, value: HeaderValue): this {
    if (this.headersSent) throw headersSentError('set');
    this.#headers.set(name.toLowerCase(), { name, value });
    return this;
  }

  appendHeader(name: string, value: HeaderValue): this {
    if (this.headersSent) throw headersSentError('append');
    const key = name.toLowerCase();
    const current = this.#headers.get(key);
    if (!current) return this.setHeader(name, value);
    const list = [
      ...(Array.isArray(current.value) ? current.value : [String(current.value)]),
      ...(Array.isArray(value) ? value : [String(value)]),
    ];
    this.#headers.set(key, { name: current.name, value: list });
    return this;
  }

  getHeader(name: string): HeaderValue | undefined {
    return this.#headers.get(name.toLowerCase())?.value;
  }

  getHeaders(): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const [key, { value }] of this.#headers) out[key] = value as OutgoingHttpHeader;
    return out;
  }

  getHeaderNames(): string[] {
    return [...this.#headers.keys()];
  }

  hasHeader(name: string): boolean {
    return this.#headers.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    if (this.headersSent) throw headersSentError('remove');
    this.#headers.delete(name.toLowerCase());
  }

  writeHead(
    status: number,
    message?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ): this {
    if (this.headersSent) throw headersSentError('write');
    this.statusCode = status;
    let extra = headers;
    if (typeof message === 'string') this.statusMessage = message;
    else extra = message;
    if (Array.isArray(extra)) {
      for (let i = 0; i + 1 < extra.length; i += 2)
        this.appendHeader(String(extra[i]), extra[i + 1] as HeaderValue);
    } else if (extra) {
      for (const [name, value] of Object.entries(extra)) if (value !== undefined) this.setHeader(name, value);
    }
    this.#sendHead();
    return this;
  }

  flushHeaders(): void {
    this.#sendHead();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#sendHead();
    const controller = this.#controller;
    if (!controller || this.#closed || !chunk.length) {
      callback();
      return;
    }
    controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if ((controller.desiredSize ?? 1) > 0) callback();
    // Backpressure: continue when the consumer pulls.
    else this.#waiting = () => callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#sendHead();
    this.#close();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.headersSent) {
      this.headersSent = true;
      this.#reject(error ?? new Error('response destroyed before it was sent'));
    } else if (this.#controller && !this.#closed) {
      this.#closed = true;
      if (error) this.#controller.error(error);
      else this.#controller.close();
    }
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.();
    callback(error);
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#controller?.close();
    } catch {
      // already closed or cancelled
    }
  }

  #sendHead(): void {
    if (this.headersSent) return;
    this.headersSent = true;
    const headers = new Headers();
    for (const { name, value } of this.#headers.values()) {
      if (Array.isArray(value)) for (const v of value) headers.append(name, String(v));
      else headers.set(name, String(value));
    }
    const status = this.statusCode;
    const empty = NULL_BODY.has(status) || this.#method === 'HEAD';
    if (!empty) {
      this.#body = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            this.#controller = controller;
          },
          pull: () => {
            const waiting = this.#waiting;
            this.#waiting = null;
            waiting?.();
          },
          cancel: () => {
            this.#closed = true;
            this.destroy();
          },
        },
        { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
      );
    } else this.#closed = true;
    try {
      this.#resolve(
        new Response(this.#body, {
          status: status < 200 || status > 599 ? 200 : status,
          ...(this.statusMessage ? { statusText: this.statusMessage } : {}),
          headers,
        }),
      );
    } catch (err) {
      this.#reject(err);
    }
  }
}

function headersSentError(action: string): Error {
  const error = new Error(`Cannot ${action} headers after they are sent to the client`);
  (error as Error & { code?: string }).code = 'ERR_HTTP_HEADERS_SENT';
  return error;
}
