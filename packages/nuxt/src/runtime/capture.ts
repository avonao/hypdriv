import { MiniEmitter } from './emitter';

/** A header value as Node's `OutgoingMessage` stores it. */
export type OutgoingHeaderValue = string | number | readonly string[];

/** The parts of Node's `ServerResponse` (or Nitro's in-memory one) the integration writes the final response to. */
export interface NodeResponseLike {
  statusCode: number;
  statusMessage: string;
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  socket?: unknown;
  setHeader(name: string, value: OutgoingHeaderValue): unknown;
  getHeaderNames?(): string[];
  getHeaders?(): Record<string, unknown>;
  removeHeader(name: string): void;
  write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean;
  end(chunk?: Uint8Array | string): unknown;
  flushHeaders?(): void;
  destroy?(error?: Error): unknown;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  writeEarlyHints?(hints: Record<string, string | string[]>, callback?: () => void): void;
}

const encoder = new TextEncoder();
/** Statuses whose responses never carry a body (the Fetch `Response` constructor refuses one). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
/** Connection-level headers that describe the hop, not the response. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']);
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

function toBytes(chunk: unknown, encoding?: string): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') {
    if (!encoding || /^utf-?8$/i.test(encoding)) return encoder.encode(chunk);
    const NodeBuffer = (globalThis as { Buffer?: { from(value: string, encoding: string): Uint8Array } })
      .Buffer;
    return NodeBuffer ? NodeBuffer.from(chunk, encoding) : encoder.encode(chunk);
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return encoder.encode(String(chunk ?? ''));
}

function headersSentError(action: string): Error {
  const error = new Error(`Cannot ${action} headers after they are sent to the client`) as Error & {
    code?: string;
  };
  error.code = 'ERR_HTTP_HEADERS_SENT';
  return error;
}

type Callback = (error?: Error | null) => void;

/**
 * A stand-in for Node's `ServerResponse` that turns what Nitro writes into a Web `Response` with a streaming body.
 * The integration installs it as `event.node.res` while the application renders, so Hypdriv's pipeline can
 * post-process the response (headers, CSP nonces, Server-Timing) before it reaches the client. The `response`
 * promise settles as soon as the head is known (first `writeHead`, `write`, `flushHeaders` or `end`); the body
 * keeps streaming afterwards, with backpressure (`write()` returns `false` and `drain` fires when the reader
 * catches up).
 */
export class CaptureResponse extends MiniEmitter {
  statusCode = 200;
  statusMessage = '';
  sendDate = false;
  chunkedEncoding = false;
  shouldKeepAlive = false;
  useChunkedEncodingByDefault = true;
  strictContentLength = false;
  upgrading = false;
  writable = true;
  writableEnded = false;
  writableFinished = false;
  writableCorked = 0;
  writableObjectMode = false;
  readonly writableHighWaterMark: number;
  destroyed = false;
  closed = false;
  errored: Error | null = null;
  /** Set by h3's `sendStream` (it records the stream before piping it through `write`). */
  _data: unknown = undefined;
  readonly req: unknown;
  readonly socket: unknown;
  readonly connection: unknown;
  /** Settles with the response head (and its streaming body) once the application starts responding. */
  readonly response: Promise<Response>;

  #resolve!: (response: Response) => void;
  #reject!: (error: unknown) => void;
  #headers = new Map<string, { name: string; value: OutgoingHeaderValue }>();
  #head: Response | null = null;
  #stream: ReadableStream<Uint8Array>;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #streamClosed = false;
  #needDrain = false;
  #abandoned = false;
  #method: string;
  #original: NodeResponseLike | undefined;

  constructor(input: {
    /** The response the final answer is written to (its socket is reused for h3's streaming checks). */
    original?: NodeResponseLike;
    req?: { socket?: unknown; method?: string };
    highWaterMark?: number;
  }) {
    super();
    this.#original = input.original;
    this.req = input.req;
    this.socket = input.original?.socket ?? input.req?.socket ?? null;
    this.connection = this.socket;
    this.#method = (input.req?.method ?? 'GET').toUpperCase();
    this.writableHighWaterMark = input.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.response = new Promise<Response>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A response that is never consumed must not surface as an unhandled rejection.
    this.response.catch(() => undefined);
    this.#stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => {
          if (this.#needDrain) {
            this.#needDrain = false;
            this.emit('drain');
          }
        },
        cancel: () => {
          this.abandon();
        },
      },
      { highWaterMark: this.writableHighWaterMark, size: (chunk) => chunk?.byteLength ?? 0 },
    );
  }

  get headersSent(): boolean {
    return this.#head !== null;
  }

  get finished(): boolean {
    return this.writableEnded;
  }

  get writableLength(): number {
    const desired = this.#controller?.desiredSize ?? this.writableHighWaterMark;
    return Math.max(0, this.writableHighWaterMark - (desired ?? 0));
  }

  get writableNeedDrain(): boolean {
    return this.#needDrain;
  }

  /** Whether the head was committed and the body finished. */
  get complete(): boolean {
    return this.#head !== null && this.writableEnded;
  }

  // --- headers -------------------------------------------------------------------------------------------

  setHeader(name: string, value: OutgoingHeaderValue): this {
    if (this.#head) throw headersSentError('set');
    this.#headers.set(name.toLowerCase(), { name, value: Array.isArray(value) ? [...value] : value });
    return this;
  }

  appendHeader(name: string, value: OutgoingHeaderValue): this {
    if (this.#head) throw headersSentError('append');
    const key = name.toLowerCase();
    const existing = this.#headers.get(key);
    if (!existing) return this.setHeader(name, value);
    const values = [
      ...(Array.isArray(existing.value) ? existing.value : [String(existing.value)]),
      ...(Array.isArray(value) ? value : [String(value)]),
    ];
    this.#headers.set(key, { name: existing.name, value: values });
    return this;
  }

  setHeaders(headers: Headers | Map<string, OutgoingHeaderValue>): this {
    if (headers instanceof Headers) {
      const cookies = headers.getSetCookie();
      headers.forEach((value, name) => {
        if (name !== 'set-cookie') this.setHeader(name, value);
      });
      if (cookies.length) this.setHeader('set-cookie', cookies);
      return this;
    }
    for (const [name, value] of headers) this.setHeader(name, value);
    return this;
  }

  getHeader(name: string): OutgoingHeaderValue | undefined {
    return this.#headers.get(name.toLowerCase())?.value;
  }

  getHeaders(): Record<string, OutgoingHeaderValue> {
    const out: Record<string, OutgoingHeaderValue> = Object.create(null);
    for (const [key, { value }] of this.#headers) out[key] = value;
    return out;
  }

  getHeaderNames(): string[] {
    return [...this.#headers.keys()];
  }

  getRawHeaderNames(): string[] {
    return [...this.#headers.values()].map((h) => h.name);
  }

  hasHeader(name: string): boolean {
    return this.#headers.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    if (this.#head) throw headersSentError('remove');
    this.#headers.delete(name.toLowerCase());
  }

  writeHead(
    statusCode: number,
    reasonOrHeaders?: string | Record<string, OutgoingHeaderValue> | OutgoingHeaderValue[],
    headers?: Record<string, OutgoingHeaderValue> | OutgoingHeaderValue[],
  ): this {
    if (this.#head) throw headersSentError('write');
    this.statusCode = statusCode;
    let extra = headers;
    if (typeof reasonOrHeaders === 'string') this.statusMessage = reasonOrHeaders;
    else if (reasonOrHeaders) extra = reasonOrHeaders;
    if (Array.isArray(extra)) {
      // Raw pairs: [name, value, name, value…] or [[name, value]…].
      const flat = (extra as unknown[]).flat() as string[];
      for (let i = 0; i + 1 < flat.length; i += 2) this.appendHeader(String(flat[i]), String(flat[i + 1]));
    } else if (extra) {
      for (const [name, value] of Object.entries(extra)) if (value !== undefined) this.setHeader(name, value);
    }
    this.#commit();
    return this;
  }

  flushHeaders(): void {
    this.#commit();
  }

  writeEarlyHints(hints: Record<string, string | string[]>, callback?: () => void): void {
    const original = this.#original;
    if (original?.writeEarlyHints && !original.headersSent) original.writeEarlyHints(hints, callback);
    else if (callback) queueMicrotask(callback);
  }

  // --- body ----------------------------------------------------------------------------------------------

  write(chunk: unknown, encodingOrCallback?: string | Callback, callback?: Callback): boolean {
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    if (this.writableEnded || this.destroyed) {
      if (cb) queueMicrotask(() => cb(new Error('write after end')));
      return false;
    }
    this.#commit();
    this.#enqueue(chunk, encoding);
    if (cb) queueMicrotask(() => cb(null));
    const desired = this.#controller?.desiredSize ?? 1;
    if (!this.#abandoned && !this.#streamClosed && desired !== null && desired <= 0) {
      this.#needDrain = true;
      return false;
    }
    return true;
  }

  end(chunkOrCallback?: unknown, encodingOrCallback?: string | Callback, callback?: Callback): this {
    let chunk: unknown = chunkOrCallback;
    let encoding: string | undefined;
    let cb: Callback | undefined;
    if (typeof chunkOrCallback === 'function') {
      chunk = undefined;
      cb = chunkOrCallback as Callback;
    } else if (typeof encodingOrCallback === 'function') cb = encodingOrCallback;
    else {
      encoding = encodingOrCallback;
      cb = callback;
    }
    if (this.writableEnded) {
      if (cb) queueMicrotask(() => cb(null));
      return this;
    }
    this.#commit();
    if (chunk !== undefined && chunk !== null) this.#enqueue(chunk, encoding);
    this.#closeStream();
    this.writableEnded = true;
    this.writable = false;
    this.writableFinished = true;
    queueMicrotask(() => {
      this.emit('finish');
      this.#emitClose();
      if (cb) cb(null);
    });
    return this;
  }

  cork(): void {
    this.writableCorked++;
  }

  uncork(): void {
    if (this.writableCorked > 0) this.writableCorked--;
  }

  setTimeout(_ms: number, callback?: () => void): this {
    if (callback) this.once('timeout', callback);
    return this;
  }

  setDefaultEncoding(): this {
    return this;
  }

  addTrailers(): void {}

  writeContinue(): void {}

  writeProcessing(): void {}

  assignSocket(): void {}

  detachSocket(): void {}

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    if (error) {
      this.errored = error;
      if (this.#head) this.#errorStream(error);
      else this.#reject(error);
    } else if (!this.#head) {
      this.#reject(new Error('response destroyed before it was sent'));
    } else this.#closeStream();
    queueMicrotask(() => this.#emitClose());
    return this;
  }

  // --- integration API -----------------------------------------------------------------------------------

  /** Ends an untouched response with its current status and headers (the application never wrote one). */
  finishIfIdle(): void {
    if (!this.#head && !this.writableEnded && !this.destroyed) this.end();
  }

  /** Fails a response whose head was already sent (an error while streaming the body). */
  fail(error: Error): void {
    if (!this.#head) {
      this.#reject(error);
      return;
    }
    this.errored = error;
    this.#errorStream(error);
  }

  /**
   * Stops collecting the body (the final response does not use it, or the client went away): later writes are
   * dropped and producers listening for `close` stop.
   */
  abandon(): void {
    if (this.#abandoned) return;
    this.#abandoned = true;
    this.#closeStream();
    if (!this.closed) queueMicrotask(() => this.#emitClose());
  }

  /** Forwards the client connection's `close` (a disconnect) to listeners of this response. */
  clientClosed(): void {
    if (this.writableFinished) return;
    this.abandon();
  }

  #emitClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  #enqueue(chunk: unknown, encoding?: string): void {
    if (this.#abandoned || this.#streamClosed || !this.#controller) return;
    const bytes = toBytes(chunk, encoding);
    if (!bytes.byteLength) return;
    try {
      this.#controller.enqueue(bytes);
    } catch {
      this.#streamClosed = true;
    }
  }

  #closeStream(): void {
    if (this.#streamClosed) return;
    this.#streamClosed = true;
    try {
      this.#controller?.close();
    } catch {
      // already closed or errored
    }
  }

  #errorStream(error: Error): void {
    if (this.#streamClosed) return;
    this.#streamClosed = true;
    try {
      this.#controller?.error(error);
    } catch {
      // already closed
    }
  }

  #commit(): void {
    if (this.#head) return;
    const headers = new Headers();
    for (const { name, value } of this.#headers.values()) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      try {
        if (Array.isArray(value)) for (const v of value) headers.append(name, String(v));
        else headers.set(name, String(value));
      } catch {
        // invalid header value: Node would have thrown on setHeader already
      }
    }
    let status = this.statusCode;
    if (!Number.isInteger(status) || status < 200 || status > 599) status = status === 103 ? 200 : 500;
    const nullBody = NULL_BODY.has(status) || this.#method === 'HEAD';
    if (nullBody) this.#closeStream();
    let head: Response;
    try {
      head = new Response(nullBody ? null : this.#stream, {
        status,
        ...(this.statusMessage ? { statusText: this.statusMessage } : {}),
        headers,
      });
    } catch {
      head = new Response(nullBody ? null : this.#stream, { status, headers });
    }
    this.#head = head;
    this.#resolve(head);
  }
}

/** Waits until a Node response can take more data (or the connection closed). */
function drained(res: NodeResponseLike): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      res.off?.('drain', done);
      res.off?.('close', done);
      resolve();
    };
    res.once?.('drain', done);
    res.once?.('close', done);
  });
}

export interface WriteResponseOptions {
  /** The request method (`HEAD` responses carry no body). */
  method?: string;
  /**
   * Keep the response's `content-length` (only when the body is the one the application produced unchanged).
   * Default false: pipeline stages may rewrite the body.
   */
  keepContentLength?: boolean;
}

/**
 * Writes a Web `Response` to a Node `ServerResponse` (or Nitro's in-memory response): status, headers (every
 * `set-cookie` separately) and the body, streamed with backpressure. Responses without a socket (Nitro's
 * `localFetch`, which the Cloudflare preset uses) receive the body buffered, since they buffer it anyway.
 */
export async function writeResponse(
  res: NodeResponseLike,
  response: Response,
  options: WriteResponseOptions = {},
): Promise<void> {
  if (res.headersSent || res.writableEnded) {
    void response.body?.cancel().catch(() => undefined);
    return;
  }
  for (const name of res.getHeaderNames?.() ?? Object.keys(res.getHeaders?.() ?? {})) res.removeHeader(name);
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie' || HOP_BY_HOP.has(name)) return;
    if (name === 'content-length' && !options.keepContentLength) return;
    res.setHeader(name, value);
  });
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;
  const method = (options.method ?? 'GET').toUpperCase();
  if (!response.body || method === 'HEAD' || NULL_BODY.has(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    res.end();
    return;
  }
  if (!res.socket) {
    res.end(new Uint8Array(await response.arrayBuffer()));
    return;
  }
  const reader = response.body.getReader();
  let closed = false;
  const onClose = () => {
    if (res.writableEnded) return;
    closed = true;
    void reader.cancel().catch(() => undefined);
  };
  res.once?.('close', onClose);
  try {
    // Event streams must reach the client before their first event.
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) res.flushHeaders?.();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (value?.byteLength && !res.write(value)) await drained(res);
    }
    if (!closed) res.end();
  } catch (error) {
    if (!closed) res.destroy?.(error as Error);
  } finally {
    res.off?.('close', onClose);
  }
}
