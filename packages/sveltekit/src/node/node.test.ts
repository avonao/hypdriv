import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { emptyManifest, routePatternToRegex } from '@hypdriv/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HANDLER_SLOT } from '../handle';
import { clientAddress, createRequestListener, pipelineRequest } from './index';
import { CapturedResponse } from './response';

function fakeReq(method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(req, { method, url: '/', headers, rawHeaders: Object.entries(headers).flat(), socket: {} });
  return req;
}

describe('CapturedResponse', () => {
  it('turns writeHead/write/end into a streamed Response', async () => {
    const res = new CapturedResponse(fakeReq());
    res.setHeader('set-cookie', ['a=1', 'b=2']);
    res.setHeader('x-n', 3);
    res.writeHead(201, 'Created', { 'content-type': 'text/plain' });
    res.write('hello ');
    res.end('world');
    const response = await res.response;
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('x-n')).toBe('3');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await response.text()).toBe('hello world');
    expect(res.writableEnded).toBe(true);
    expect(() => res.setHeader('x', '1')).toThrow(/after they are sent/);
  });

  it('works as a pipeline destination and honours backpressure', async () => {
    const res = new CapturedResponse(fakeReq());
    const chunk = Buffer.alloc(32 * 1024, 120);
    const source = Readable.from(Array.from({ length: 16 }, () => chunk));
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const done = pipeline(source, res);
    const response = await res.response;
    const body = new Uint8Array(await response.arrayBuffer());
    await done;
    expect(body.byteLength).toBe(16 * 32 * 1024);
  });

  it('sends the head implicitly on the first write and uses null bodies for HEAD and 304', async () => {
    const implicit = new CapturedResponse(fakeReq());
    implicit.statusCode = 404;
    implicit.end('missing');
    expect((await implicit.response).status).toBe(404);
    const head = new CapturedResponse(fakeReq('HEAD'));
    head.writeHead(200, { 'content-length': '5' }).end();
    expect((await head.response).body).toBeNull();
    const notModified = new CapturedResponse(fakeReq());
    notModified.writeHead(304, { etag: '"x"' }).end();
    expect((await notModified.response).body).toBeNull();
  });

  it('rejects when destroyed before the head and is destroyed when the body is cancelled', async () => {
    const early = new CapturedResponse(fakeReq());
    early.destroy(new Error('boom'));
    await expect(early.response).rejects.toThrow('boom');
    const cancelled = new CapturedResponse(fakeReq());
    cancelled.writeHead(200);
    cancelled.write('partial');
    const response = await cancelled.response;
    await response.body!.cancel();
    expect(cancelled.destroyed).toBe(true);
  });
});

describe('pipelineRequest / clientAddress', () => {
  it('builds the pipeline request from the Node request without its body', () => {
    const req = fakeReq('POST', { host: 'shop.example.com', 'x-forwarded-proto': 'https', cookie: 'a=1' });
    req.url = '/cart?x=1';
    expect(pipelineRequest(req).url).toBe('http://shop.example.com/cart?x=1');
    const trusted = pipelineRequest(req, { trustProxy: true });
    expect(trusted.url).toBe('https://shop.example.com/cart?x=1');
    expect(trusted.method).toBe('POST');
    expect(trusted.body).toBeNull();
    expect(trusted.headers.get('cookie')).toBe('a=1');
    expect(pipelineRequest(req, { origin: 'https://www.example.com' }).url).toBe(
      'https://www.example.com/cart?x=1',
    );
  });

  it('reads the client address like adapter-node', () => {
    const req = fakeReq('GET', { 'x-forwarded-for': '203.0.113.1, 198.51.100.2' });
    Object.assign(req, { socket: { remoteAddress: '10.0.0.1' } });
    expect(clientAddress(req)).toBe('10.0.0.1');
    expect(clientAddress(req, true)).toBeUndefined();
    process.env.ADDRESS_HEADER = 'x-forwarded-for';
    process.env.XFF_DEPTH = '2';
    expect(clientAddress(req)).toBe('203.0.113.1');
    delete process.env.ADDRESS_HEADER;
    delete process.env.XFF_DEPTH;
  });
});

describe('createRequestListener', () => {
  let dir: string;
  let server: Server;
  let base: string;
  const UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

  beforeAll(async () => {
    delete (globalThis as Record<symbol, unknown>)[HANDLER_SLOT];
    dir = mkdtempSync(join(tmpdir(), 'hypdriv-sk-node-'));
    mkdirSync(join(dir, 'build'), { recursive: true });
    // A stand-in for adapter-node's handler: static files with `pipeline`, an SSR page written in chunks, a body reader.
    writeFileSync(
      join(dir, 'build', 'handler.js'),
      `import { Readable } from 'node:stream';
import { pipeline } from 'node:stream';
export const handler = (req, res, next) => {
  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': req.headers['accept-encoding'] ? 'identity' : 'identity' });
    pipeline(Readable.from(['User-agent: *\\n']), res, () => {});
    return;
  }
  if (req.url === '/about') {
    res.writeHead(200, { 'content-type': 'text/html', 'x-accept-encoding': String(req.headers['accept-encoding'] ?? '') });
    res.end('<html><head></head><body><script>prerendered()</script></body></html>');
    return;
  }
  if (req.url === '/ssr') {
    res.setHeader('content-type', 'text/html');
    res.writeHead(200);
    res.write('<html><head></head><body>');
    setTimeout(() => { res.write('<script>later()</script>'); res.end('</body></html>'); }, 5);
    return;
  }
  if (req.url === '/echo' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ body })); });
    return;
  }
  next();
};
`,
    );
    const manifest = emptyManifest({
      framework: { name: 'sveltekit', version: '3.1.1' },
      routes: [
        {
          id: 'page:/about',
          pathname: '/about',
          regex: routePatternToRegex('/about'),
          kind: 'page',
          classification: 'static',
          runtime: 'nodejs',
          dynamic: false,
          assets: { js: [], css: [], fonts: [] },
        },
      ],
      csp: { 'page:/about': { scriptHashes: ["'sha256-prerendered'"], styleHashes: [] } },
    });
    const listener = await createRequestListener({
      root: dir,
      config: { site: { name: 'node-test' } },
      manifest,
    });
    server = createServer(listener);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the pipeline around adapter-node's static files", async () => {
    const res = await fetch(`${base}/robots.txt`, { headers: { 'user-agent': UA } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('User-agent: *\n');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('gives prerendered pages their hash CSP and requests them uncompressed', async () => {
    const res = await fetch(`${base}/about`, {
      headers: { 'user-agent': UA, accept: 'text/html', 'accept-encoding': 'br, gzip' },
    });
    expect(res.headers.get('x-hypdriv-csp')).toBe('hash');
    expect(res.headers.get('content-security-policy')).toContain("'sha256-prerendered'");
    expect(res.headers.get('x-accept-encoding')).toBe('');
  });

  it('injects the nonce into streamed HTML', async () => {
    const res = await fetch(`${base}/ssr`, { headers: { 'user-agent': UA, accept: 'text/html' } });
    const body = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonce).toBeTruthy();
    expect(body).toContain(`<script nonce="${nonce}">later()</script>`);
  });

  it('leaves the request body to SvelteKit, answers internal routes and falls back to 404', async () => {
    const echo = await fetch(`${base}/echo`, {
      method: 'POST',
      body: 'payload',
      headers: { 'user-agent': UA, 'content-type': 'text/plain' },
    });
    expect(await echo.json()).toEqual({ body: 'payload' });
    const health = await fetch(`${base}/_hypdriv/health`, { headers: { 'user-agent': UA } });
    expect(((await health.json()) as { framework: string }).framework).toContain('SvelteKit');
    const missing = await fetch(`${base}/nowhere`, { headers: { 'user-agent': UA } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-request-id')).toBeTruthy();
  });
});
