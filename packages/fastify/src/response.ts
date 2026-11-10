import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';

/** Connection-level headers that belong to one hop, not to a response that is replayed or re-framed. */
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Responses to these never carry a body. */
export function bodyless(status: number, method: string): boolean {
  return method === 'HEAD' || status === 204 || status === 205 || status === 304;
}

const noop = () => undefined;

function isNodeStream(payload: unknown): payload is Readable {
  return typeof (payload as { pipe?: unknown } | null)?.pipe === 'function';
}

function isWebStream(payload: unknown): payload is ReadableStream<Uint8Array> {
  return typeof (payload as { getReader?: unknown } | null)?.getReader === 'function';
}

const encoder = new TextEncoder();

/**
 * A Node stream as a Web byte stream, pulled one chunk at a time (no read-ahead, so backpressure reaches the route's
 * stream). Unlike `Readable.toWeb()` it takes object-mode streams of strings, the idiom
 * `reply.send(Readable.from(generator()))` uses, which Fastify itself writes to the socket as text.
 */
function webBody(stream: Readable): ReadableStream<Uint8Array> {
  const chunks = stream[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await chunks.next();
          if (done) controller.close();
          else if (typeof value === 'string') controller.enqueue(encoder.encode(value));
          else if (value instanceof Uint8Array) controller.enqueue(value);
          else throw new TypeError('A Fastify stream payload must produce strings or Buffers');
        } catch (error) {
          controller.error(error);
          stream.destroy(error instanceof Error ? error : undefined);
        }
      },
      cancel() {
        stream.destroy();
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * The Web `Response` for what a Fastify route answered, at the `onSend` hook: the status, the headers set so far and
 * the payload (a string or Buffer from the serializers, a stream when the route sent one). Streams are wrapped, not
 * read: the body flows through the pipeline as the route produces it.
 */
export function payloadResponse(reply: FastifyReply, method: string, payload: unknown): Response {
  const status = reply.statusCode;
  const headers = new Headers();
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, String(v));
    else headers.set(name, String(value));
  }
  const noBody = bodyless(status, method);
  let body: BodyInit | null = null;
  let length: number | undefined;
  if (typeof payload === 'string') {
    length = Buffer.byteLength(payload);
    body = payload;
  } else if (payload instanceof Uint8Array) {
    length = payload.byteLength;
    body = payload as Uint8Array<ArrayBuffer>;
  } else if (isNodeStream(payload)) {
    body = webBody(payload);
  } else if (isWebStream(payload)) {
    body = payload;
  }
  if (noBody) {
    if (body instanceof ReadableStream) void body.cancel().catch(noop);
    // A HEAD response states the length of the body its GET would have.
    if (method === 'HEAD' && length !== undefined && status !== 204 && status !== 205 && status !== 304)
      if (!headers.has('content-length')) headers.set('content-length', String(length));
    return new Response(null, { status, headers });
  }
  // Fastify frames string and Buffer payloads after the hooks run; the pipeline sees the length they will have.
  if (length !== undefined && !headers.has('content-length')) headers.set('content-length', String(length));
  return new Response(body, { status, headers });
}

/**
 * Makes a Fastify reply carry a Web `Response`: the status, exactly its headers (what the route had set and the
 * pipeline removed does not stay), and the body as the Node stream Fastify sends (`null` for responses without
 * one). Returns the payload to give to `reply.send()` or to return from an `onSend` hook.
 *
 * A HEAD response gets an empty stream rather than `null`: the HEAD routes Fastify generates for every GET route
 * end with an `onSend` handler that sizes or drains the payload it is given, and the headers set here (the length
 * of the body the GET would send) are the ones that go out.
 */
export function applyResponse(reply: FastifyReply, response: Response, method: string): Readable | null {
  reply.code(response.status);
  if (response.statusText) reply.raw.statusMessage = response.statusText;
  for (const name of Object.keys(reply.getHeaders())) reply.removeHeader(name);
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie' && !HOP_BY_HOP.has(name)) reply.header(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  const body = response.body;
  if (!body || bodyless(response.status, method)) {
    // Never await a body cancel: it may not settle (AGENTS.md pitfalls).
    void body?.cancel().catch(noop);
    return method === 'HEAD' ? Readable.from([]) : null;
  }
  return Readable.fromWeb(body as never);
}
