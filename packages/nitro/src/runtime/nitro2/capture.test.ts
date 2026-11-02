import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CaptureResponse, type NodeResponseLike, writeResponse } from './capture';

/** A Node-like response that records what is written to it. */
class RecordingResponse extends EventEmitter implements NodeResponseLike {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;
  writableEnded = false;
  socket: unknown = {};
  headers = new Map<string, unknown>();
  chunks: Uint8Array[] = [];
  destroyedWith: Error | undefined;
  /** Accept this many writes before reporting backpressure. */
  capacity = Number.POSITIVE_INFINITY;
  setHeader(name: string, value: unknown) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  getHeaderNames() {
    return [...this.headers.keys()];
  }
  removeHeader(name: string) {
    this.headers.delete(name.toLowerCase());
  }
  write(chunk: Uint8Array | string) {
    this.headersSent = true;
    this.chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    if (this.chunks.length >= this.capacity) {
      queueMicrotask(() => this.emit('drain'));
      return false;
    }
    return true;
  }
  end(chunk?: Uint8Array | string) {
    if (chunk) this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    return this;
  }
  destroy(error?: Error) {
    this.destroyedWith = error;
    return this;
  }
  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

describe('CaptureResponse', () => {
  it('turns a buffered send into a Response with status and headers', async () => {
    const capture = new CaptureResponse({ req: { method: 'GET' } });
    capture.statusCode = 201;
    capture.setHeader('Content-Type', 'text/html; charset=utf-8');
    capture.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
    expect(capture.headersSent).toBe(false);
    capture.end('<p>hi</p>');
    const response = await capture.response;
    expect(capture.headersSent).toBe(true);
    expect(capture.writableEnded).toBe(true);
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(await response.text()).toBe('<p>hi</p>');
  });

  it('resolves the head on the first write and streams the rest', async () => {
    const capture = new CaptureResponse({ req: { method: 'GET' } });
    capture.writeHead(200, { 'content-type': 'text/event-stream' });
    const response = await capture.response;
    const reader = response.body!.getReader();
    capture.write('data: 1\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n\n');
    capture.write(Buffer.from('data: 2\n\n'));
    capture.end();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 2\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('keeps headers mutable until the head is committed, like Node', () => {
    const capture = new CaptureResponse({});
    capture.setHeader('x-a', '1');
    capture.appendHeader('x-a', '2');
    expect(capture.getHeader('x-a')).toEqual(['1', '2']);
    expect(capture.getHeaders()).toEqual({ 'x-a': ['1', '2'] });
    expect(capture.hasHeader('X-A')).toBe(true);
    capture.removeHeader('x-a');
    expect(capture.getHeaderNames()).toEqual([]);
    capture.flushHeaders();
    expect(() => capture.setHeader('x-b', '1')).toThrow(/after they are sent/);
  });

  it('accepts writeHead with a reason phrase and raw header pairs', async () => {
    const capture = new CaptureResponse({});
    capture.writeHead(404, 'Gone Fishing', ['x-one', '1', 'x-two', '2']);
    capture.end();
    const response = await capture.response;
    expect(response.status).toBe(404);
    expect(response.statusText).toBe('Gone Fishing');
    expect(response.headers.get('x-one')).toBe('1');
    expect(response.headers.get('x-two')).toBe('2');
  });

  it('gives null-body statuses and HEAD requests no body', async () => {
    const noContent = new CaptureResponse({});
    noContent.statusCode = 204;
    noContent.end('ignored');
    expect((await noContent.response).body).toBeNull();
    const head = new CaptureResponse({ req: { method: 'HEAD' } });
    head.end('ignored');
    expect((await head.response).body).toBeNull();
  });

  it('drops hop-by-hop headers', async () => {
    const capture = new CaptureResponse({});
    capture.setHeader('transfer-encoding', 'chunked');
    capture.setHeader('connection', 'keep-alive');
    capture.end('x');
    const response = await capture.response;
    expect(response.headers.has('transfer-encoding')).toBe(false);
    expect(response.headers.has('connection')).toBe(false);
  });

  it('signals backpressure and drains when the reader catches up', async () => {
    const capture = new CaptureResponse({ highWaterMark: 4 });
    capture.flushHeaders();
    const response = await capture.response;
    expect(capture.write('12345')).toBe(false);
    expect(capture.writableNeedDrain).toBe(true);
    const drained = new Promise<void>((resolve) => capture.once('drain', () => resolve()));
    const reader = response.body!.getReader();
    await reader.read();
    await drained;
    expect(capture.writableNeedDrain).toBe(false);
  });

  it('emits finish and close after end, with writableFinished set', async () => {
    const capture = new CaptureResponse({});
    const events: string[] = [];
    capture.on('finish', () => events.push(`finish:${capture.writableFinished}`));
    capture.on('close', () => events.push('close'));
    capture.end('done');
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['finish:true', 'close']);
  });

  it('ends an untouched response with its current status', async () => {
    const capture = new CaptureResponse({});
    capture.statusCode = 404;
    capture.finishIfIdle();
    const response = await capture.response;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('rejects when destroyed before responding and errors a started body on fail()', async () => {
    const early = new CaptureResponse({});
    early.destroy(new Error('aborted'));
    await expect(early.response).rejects.toThrow('aborted');

    const late = new CaptureResponse({});
    late.write('partial');
    const response = await late.response;
    late.fail(new Error('stream broke'));
    await expect(response.text()).rejects.toThrow('stream broke');
  });

  it('drops writes after abandon() and tells producers to stop', async () => {
    const capture = new CaptureResponse({});
    capture.write('kept');
    const response = await capture.response;
    let closed = false;
    capture.on('close', () => {
      closed = true;
    });
    capture.abandon();
    capture.write('dropped');
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(true);
    expect(await response.text()).toBe('kept');
  });

  it('reuses the original socket so h3 streams through write()', () => {
    const socket = { remoteAddress: '203.0.113.1' };
    const capture = new CaptureResponse({ original: { socket } as unknown as NodeResponseLike });
    expect(capture.socket).toBe(socket);
    const fromRequest = new CaptureResponse({ req: { socket } });
    expect(fromRequest.socket).toBe(socket);
  });

  it('forwards Early Hints to the client response before the head', () => {
    const sent: unknown[] = [];
    const original = {
      headersSent: false,
      writeEarlyHints: (hints: unknown) => sent.push(hints),
    } as unknown as NodeResponseLike;
    const capture = new CaptureResponse({ original });
    capture.writeEarlyHints({ link: '</a.js>; rel=preload; as=script' });
    expect(sent).toEqual([{ link: '</a.js>; rel=preload; as=script' }]);
  });
});

describe('writeResponse', () => {
  it('writes status, headers, every set-cookie and the streamed body', async () => {
    const res = new RecordingResponse();
    res.setHeader('x-stale', '1');
    const headers = new Headers({ 'content-type': 'text/plain', 'content-length': '5' });
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    await writeResponse(res, new Response('hello', { status: 202, statusText: 'Accepted', headers }));
    expect(res.statusCode).toBe(202);
    expect(res.statusMessage).toBe('Accepted');
    expect(res.headers.get('x-stale')).toBeUndefined();
    expect(res.headers.get('set-cookie')).toEqual(['a=1', 'b=2']);
    // The body may have been transformed: the length is recomputed by the server.
    expect(res.headers.has('content-length')).toBe(false);
    expect(res.text()).toBe('hello');
    expect(res.writableEnded).toBe(true);
  });

  it('keeps content-length for an unchanged body', async () => {
    const res = new RecordingResponse();
    await writeResponse(res, new Response('hello', { headers: { 'content-length': '5' } }), {
      keepContentLength: true,
    });
    expect(res.headers.get('content-length')).toBe('5');
  });

  it('sends no body for HEAD and null-body statuses', async () => {
    const head = new RecordingResponse();
    await writeResponse(head, new Response('body'), { method: 'HEAD' });
    expect(head.chunks).toEqual([]);
    expect(head.writableEnded).toBe(true);
    const notModified = new RecordingResponse();
    await writeResponse(notModified, new Response(null, { status: 304 }));
    expect(notModified.statusCode).toBe(304);
    expect(notModified.writableEnded).toBe(true);
  });

  it('waits for drain under backpressure', async () => {
    const res = new RecordingResponse();
    res.capacity = 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'));
        controller.enqueue(new TextEncoder().encode('b'));
        controller.close();
      },
    });
    await writeResponse(res, new Response(body));
    expect(res.text()).toBe('ab');
  });

  it('buffers the body for in-memory responses without a socket (Nitro localFetch)', async () => {
    const res = new RecordingResponse();
    res.socket = null;
    await writeResponse(res, new Response('buffered'));
    expect(res.chunks).toHaveLength(1);
    expect(res.text()).toBe('buffered');
  });

  it('destroys the client response when the body errors mid-stream', async () => {
    const res = new RecordingResponse();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'));
        controller.error(new Error('upstream failed'));
      },
    });
    await writeResponse(res, new Response(body));
    expect(res.destroyedWith?.message).toBe('upstream failed');
  });

  it('stops reading when the client disconnects', async () => {
    const res = new RecordingResponse();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('tick'));
        queueMicrotask(() => res.emit('close'));
        return new Promise((r) => setTimeout(r, 5));
      },
      cancel() {
        cancelled = true;
      },
    });
    await writeResponse(res, new Response(body));
    expect(cancelled).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it('leaves a response that was already sent alone', async () => {
    const res = new RecordingResponse();
    res.headersSent = true;
    await writeResponse(res, new Response('late'));
    expect(res.chunks).toEqual([]);
  });
});
