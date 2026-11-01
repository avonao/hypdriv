import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveConfig } from '@hypdriv/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bridgeRequest,
  NodeRequestBody,
  nodeHeaders,
  requestUrl,
  syncRequestHeaders,
  toWebHeaders,
  withAssetHeaders,
  writeWebResponse,
} from './index';

const servers: Server[] = [];

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function fakeRequest(
  url: string,
  headers: Record<string, string | string[]> = {},
  extra: Record<string, unknown> = {},
): IncomingMessage {
  return { url, headers, socket: {}, ...extra } as unknown as IncomingMessage;
}

describe('requestUrl', () => {
  it('builds the URL from the Host header and the socket', () => {
    expect(requestUrl(fakeRequest('/a?b=1', { host: 'shop.example' })).href).toBe(
      'http://shop.example/a?b=1',
    );
    expect(
      requestUrl(fakeRequest('/a', { host: 'shop.example' }, { socket: { encrypted: true } })).href,
    ).toBe('https://shop.example/a');
  });

  it('keeps a request target that starts with two slashes a path on this host', () => {
    const url = requestUrl(fakeRequest('//evil.example/x', { host: 'shop.example' }));
    expect(url.host).toBe('shop.example');
    expect(url.pathname).toBe('//evil.example/x');
  });

  it('uses originalUrl when a router stripped the mount path from url', () => {
    const req = fakeRequest('/inner', { host: 'shop.example' }, { originalUrl: '/api/inner' });
    expect(requestUrl(req).pathname).toBe('/api/inner');
  });

  it('trusts the forwarded scheme and host only when told to', () => {
    const headers = {
      host: 'internal:3000',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'www.example.com',
    };
    expect(requestUrl(fakeRequest('/', headers)).href).toBe('http://internal:3000/');
    expect(requestUrl(fakeRequest('/', headers), { trustProxy: true }).href).toBe('https://www.example.com/');
    // Only the first hop, and only http/https.
    expect(
      requestUrl(fakeRequest('/', { host: 'a', 'x-forwarded-proto': 'ftp, https' }), { trustProxy: true })
        .protocol,
    ).toBe('http:');
  });

  it('an explicit origin wins, and a malformed Host falls back to localhost', () => {
    expect(requestUrl(fakeRequest('/p', { host: 'a' }), { origin: 'https://www.example.com/' }).href).toBe(
      'https://www.example.com/p',
    );
    expect(requestUrl(fakeRequest('/p', { host: 'bad host\\x' })).host).toBe('localhost');
    expect(requestUrl(fakeRequest('/p', {})).host).toBe('localhost');
  });

  it('accepts absolute-form targets', () => {
    expect(requestUrl(fakeRequest('http://upstream.example/x?y=1', { host: 'proxy' })).href).toBe(
      'http://upstream.example/x?y=1',
    );
  });
});

describe('headers', () => {
  it('converts Node headers, keeping every set-cookie', () => {
    const headers = toWebHeaders({ cookie: 'a=1; b=2', 'set-cookie': ['x=1', 'y=2'], ':authority': 'h2' });
    expect(headers.get('cookie')).toBe('a=1; b=2');
    expect(headers.getSetCookie()).toEqual(['x=1', 'y=2']);
    expect([...new Set(headers.keys())].sort()).toEqual(['cookie', 'set-cookie']);
  });

  it('writes set-cookie as an array for Node', () => {
    const headers = new Headers({ 'content-type': 'text/plain' });
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    expect(nodeHeaders(headers)).toEqual({ 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] });
  });

  it('replaces the headers of a Node request with the pipeline forwarded', () => {
    const req = fakeRequest('/', { host: 'a', 'x-hypdriv-route': 'forged' });
    syncRequestHeaders(req, new Headers({ host: 'a', 'x-hypdriv-runner': 'host' }));
    expect(req.headers).toEqual({ host: 'a', 'x-hypdriv-runner': 'host' });
    expect(req.rawHeaders).toEqual(['host', 'a', 'x-hypdriv-runner', 'host']);
  });
});

describe('bridgeRequest and NodeRequestBody', () => {
  /** Echoes, as JSON, what the application would read after the bridge looked at the body. */
  async function echo(
    inspect: (bridged: ReturnType<typeof bridgeRequest>) => Promise<void> | void,
    body: BodyInit | ReadableStream<Uint8Array>,
    init: RequestInit = {},
  ) {
    const { url } = await listen(async (req, res) => {
      const bridged = bridgeRequest(req);
      await inspect(bridged);
      bridged.body?.release();
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const data = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ length: data.length, text: data.length < 200 ? data.toString() : undefined }));
    });
    const response = await fetch(`${url}/`, {
      method: 'POST',
      body,
      duplex: 'half',
      ...init,
    } as RequestInit);
    return (await response.json()) as { length: number; text?: string };
  }

  it('creates no body for GET, HEAD and bodiless POST', async () => {
    const seen: Array<boolean> = [];
    const { url } = await listen((req, res) => {
      seen.push(bridgeRequest(req).body === null);
      res.end();
    });
    await fetch(`${url}/`);
    await fetch(`${url}/`, { method: 'HEAD' });
    await fetch(`${url}/`, { method: 'POST' });
    expect(seen).toEqual([true, true, true]);
  });

  it('does not touch the request until the Web body is read', async () => {
    const result = await echo(async () => {
      // Construct and forward the request the way the pipeline does: a copy with other headers.
    }, 'hello world');
    expect(result).toEqual({ length: 11, text: 'hello world' });
  });

  it('gives back the first chunk the request copy pulled (undici reads one chunk when it copies a request)', async () => {
    const result = await echo(async ({ request }) => {
      const headers = new Headers(request.headers);
      headers.set('x-hypdriv-runner', 'host');
      const copy = new Request(request, { headers });
      expect(copy.method).toBe('POST');
      await new Promise((r) => setTimeout(r, 20));
    }, 'copied body');
    expect(result).toEqual({ length: 11, text: 'copied body' });
  });

  it('gives back the whole body after a stage cloned and parsed it', async () => {
    const result = await echo(
      async ({ request, body }) => {
        const form = await request.clone().formData();
        expect(form.get('_csrf')).toBe('tok');
        expect(body?.bytesRead).toBeGreaterThan(0);
      },
      'a=1&_csrf=tok&b=2',
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    );
    expect(result).toEqual({ length: 17, text: 'a=1&_csrf=tok&b=2' });
  });

  it('gives back a large chunked body that the Web side read to the end', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const make = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 40; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
    const result = await echo(async ({ request }) => {
      const read = await new Response(request.body).arrayBuffer();
      expect(read.byteLength).toBe(40 * 64 * 1024);
    }, make());
    expect(result.length).toBe(40 * 64 * 1024);
  });

  it('gives back the part of a slow body that was read before release', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('first-'));
        await new Promise((r) => setTimeout(r, 30));
        controller.enqueue(encoder.encode('second-'));
        await new Promise((r) => setTimeout(r, 30));
        controller.enqueue(encoder.encode('third'));
        controller.close();
      },
    });
    const result = await echo(async ({ request }) => {
      const reader = request.body!.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe('first-');
      reader.releaseLock();
    }, stream);
    expect(result).toEqual({ length: 18, text: 'first-second-third' });
  });

  it('errors the Web stream after release instead of stealing from the application', async () => {
    const { url } = await listen(async (req, res) => {
      const bridged = bridgeRequest(req);
      bridged.body!.release();
      expect(bridged.body!.released).toBe(true);
      await expect(new Response(bridged.request.body).text()).rejects.toThrow(/handed to the application/);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      res.end(Buffer.concat(chunks));
    });
    const response = await fetch(`${url}/`, { method: 'POST', body: 'still here' });
    expect(await response.text()).toBe('still here');
  });

  it('a body that has ended before the bridge looked at it reads as empty', async () => {
    const { url } = await listen(async (req, res) => {
      for await (const _ of req) {
        // consumed by an earlier middleware
      }
      const bridged = bridgeRequest(req);
      const text = await new Response(bridged.request.body).text();
      bridged.body?.release();
      res.end(`[${text}]`);
    });
    const response = await fetch(`${url}/`, { method: 'POST', body: 'taken' });
    expect(await response.text()).toBe('[]');
  });

  it('aborts the Web request on demand', () => {
    const bridged = bridgeRequest(fakeRequest('/', { host: 'a' }));
    expect(bridged.request.signal.aborted).toBe(false);
    bridged.abort(new Error('gone'));
    expect(bridged.request.signal.aborted).toBe(true);
  });

  it('exposes the class for hosts that build their own requests', () => {
    expect(typeof NodeRequestBody).toBe('function');
  });
});

describe('writeWebResponse', () => {
  it('streams a body in chunks without waiting for the end', async () => {
    const { url } = await listen(async (_req, res) => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('one,'));
          await new Promise((r) => setTimeout(r, 120));
          controller.enqueue(encoder.encode('two'));
          controller.close();
        },
      });
      await writeWebResponse(res, new Response(body, { headers: { 'content-type': 'text/plain' } }));
    });
    const response = await fetch(url);
    const reader = response.body!.getReader();
    const started = Date.now();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('one,');
    // The first chunk arrived long before the stream ended.
    expect(Date.now() - started).toBeLessThan(100);
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toBe('two');
  });

  it('sends status text, every set-cookie and no body for HEAD, 204 and 304', async () => {
    const { url } = await listen(async (req, res) => {
      if (req.url === '/head') {
        const headers = new Headers({ 'content-length': '4' });
        await writeWebResponse(res, new Response('body', { headers }), { method: 'HEAD' });
        return;
      }
      if (req.url === '/nocontent') return writeWebResponse(res, new Response(null, { status: 204 }));
      const headers = new Headers();
      headers.append('set-cookie', 'a=1; Path=/');
      headers.append('set-cookie', 'b=2; Path=/');
      await writeWebResponse(res, new Response('ok', { status: 201, statusText: 'Made', headers }));
    });
    const created = await fetch(`${url}/cookies`);
    expect(created.status).toBe(201);
    expect(created.statusText).toBe('Made');
    expect(created.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    const head = await fetch(`${url}/head`, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('4');
    expect(await head.text()).toBe('');
    expect((await fetch(`${url}/nocontent`)).status).toBe(204);
  });

  it('cancels the source when the client leaves', async () => {
    let cancelled: () => void = () => undefined;
    const wasCancelled = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const { url } = await listen(async (_req, res) => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024).fill(1));
          return new Promise((r) => setTimeout(r, 5));
        },
        cancel() {
          cancelled();
        },
      });
      await writeWebResponse(res, new Response(body));
    });
    const abort = new AbortController();
    const response = await fetch(url, { signal: abort.signal });
    await response.body!.getReader().read();
    abort.abort();
    await wasCancelled;
  });

  it('waits for drain when the client reads slowly', async () => {
    const total = 8 * 1024 * 1024;
    let produced = 0;
    const { url } = await listen(async (_req, res) => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced >= total) return controller.close();
          produced += 256 * 1024;
          controller.enqueue(new Uint8Array(256 * 1024));
        },
      });
      await writeWebResponse(res, new Response(body));
    });
    const response = await fetch(url);
    const reader = response.body!.getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 100));
    // The producer is held back by backpressure well before the whole body was produced.
    expect(produced).toBeLessThan(total);
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
    expect(received).toBeGreaterThan(0);
  });

  it('destroys the response when the body fails, so the client never sees a complete-looking body', async () => {
    const { url } = await listen(async (_req, res) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
        },
        pull() {
          throw new Error('boom');
        },
      });
      await writeWebResponse(res, new Response(body));
    });
    await expect(fetch(url).then((r) => r.text())).rejects.toThrow();
  });

  it('replaceHeaders drops what the response carried before', async () => {
    const { url } = await listen(async (_req, res) => {
      res.setHeader('x-powered-by', 'Express');
      res.setHeader('x-keep', 'no');
      await writeWebResponse(res, new Response('x', { headers: { 'x-keep': 'yes' } }), {
        replaceHeaders: true,
      });
    });
    const response = await fetch(url);
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('x-keep')).toBe('yes');
  });

  it('writes through the given writers', async () => {
    const calls: string[] = [];
    const res = {
      once: () => undefined,
      off: () => undefined,
      getHeaderNames: () => [],
      removeHeader: () => undefined,
      setHeader: (name: string) => calls.push(`header:${name}`),
    } as unknown as ServerResponse;
    await writeWebResponse(res, new Response('abc', { headers: { 'x-a': '1' } }), {
      writers: {
        writeHead: (status) => calls.push(`head:${status}`),
        write: (chunk) => {
          calls.push(`write:${new TextDecoder().decode(chunk)}`);
          return true;
        },
        end: () => calls.push('end'),
      },
    });
    expect(calls).toEqual(['header:content-type', 'header:x-a', 'head:200', 'write:abc', 'end']);
  });
});

describe('withAssetHeaders()', () => {
  const asset = (init: ResponseInit = {}) => new Response('body', init);

  it('adds the security header preset to a file response and keeps what the file already carries', () => {
    const config = resolveConfig({ site: { name: 'assets' } });
    const response = withAssetHeaders(
      config,
      new Request('https://shop.example/assets/app.js'),
      asset({
        headers: { 'cache-control': 'public, max-age=31536000, immutable', 'x-powered-by': 'Express' },
      }),
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('strict-transport-security')).toContain('max-age=');
  });

  it('adds no HSTS to plain HTTP and honours the forwarded protocol', () => {
    const config = resolveConfig({ site: { name: 'assets' } });
    const plain = withAssetHeaders(config, new Request('http://shop.example/a.css'), asset());
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    const forwarded = withAssetHeaders(
      config,
      new Request('http://shop.example/a.css', { headers: { 'x-forwarded-proto': 'https, http' } }),
      asset(),
    );
    expect(forwarded.headers.get('strict-transport-security')).toContain('max-age=');
  });

  it('leaves the response alone when security headers are off', () => {
    const config = resolveConfig({ site: { name: 'assets' }, security: { headers: false } });
    const original = asset({ headers: { 'x-powered-by': 'Express' } });
    const response = withAssetHeaders(config, new Request('https://shop.example/a.css'), original);
    expect(response).toBe(original);
    expect(response.headers.get('x-powered-by')).toBe('Express');
  });
});
