import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HypHandler } from '@hypdriv/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { devMiddleware, pipelineRequest, wantsRequest } from './dev';

describe('wantsRequest', () => {
  const wants = (path: string, method = 'GET') => wantsRequest(new URL(path, 'http://localhost'), method);

  it('wraps documents, loaders, actions, endpoints and Hypdriv’s own routes', () => {
    expect(wants('/')).toBe(true);
    expect(wants('/about/')).toBe(true);
    expect(wants('/api/hello')).toBe(true);
    expect(wants('/dynamic/q-loader-abc.def.json')).toBe(true);
    expect(wants('/robots.txt')).toBe(true);
    expect(wants('/sitemap.xml')).toBe(true);
    expect(wants('/about/', 'POST')).toBe(true);
    expect(wants('/_hypdriv/health')).toBe(true);
  });

  it('leaves modules, Vite’s own routes and media to Vite', () => {
    expect(wants('/@vite/client')).toBe(false);
    expect(wants('/@id/@qwik-hmr-bridge')).toBe(false);
    expect(wants('/@fs/home/app/node_modules/x.js')).toBe(false);
    expect(wants('/node_modules/.vite/deps/a.js')).toBe(false);
    expect(wants('/src/root.tsx')).toBe(false);
    expect(wants('/src/global.css')).toBe(false);
    expect(wants('/favicon.ico')).toBe(false);
    expect(wants('/photo.png')).toBe(false);
  });
});

describe('pipelineRequest', () => {
  it('builds the Web request from the Node request: original URL, raw headers, no body', () => {
    const req = {
      url: '/stripped',
      originalUrl: '/blog/hello/?x=1',
      method: 'POST',
      headers: { host: 'localhost:5173' },
      rawHeaders: ['Host', 'localhost:5173', 'X-Thing', 'a', 'X-Thing', 'b', ':authority', 'ignored'],
      socket: {},
    } as unknown as IncomingMessage;
    const request = pipelineRequest(req);
    expect(request.url).toBe('http://localhost:5173/blog/hello/?x=1');
    expect(request.method).toBe('POST');
    expect(request.headers.get('x-thing')).toBe('a, b');
    expect(request.body).toBeNull();
  });
});

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/** Serves `downstream` behind the dev middleware, like Qwik Router’s dev SSR behind Vite’s connect stack. */
async function serve(
  handler: HypHandler,
  downstream: (req: IncomingMessage, res: ServerResponse) => void,
  wants?: (url: URL, method: string) => boolean,
): Promise<string> {
  const middleware = devMiddleware({ handler: async () => handler, ...(wants ? { wants } : {}) });
  server = createServer((req, res) => {
    middleware(req, res, (error) => {
      if (error) {
        res.writeHead(500);
        res.end(String(error));
        return;
      }
      downstream(req, res);
    });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** A pipeline stand-in: forwards the request, then decorates the response. */
const decorating: HypHandler = (async (
  request: Request,
  input: { upstream(request: Request): Promise<Response> },
) => {
  const forwarded = new Request(request, {
    headers: new Headers([...request.headers, ['x-forwarded-by', 'pipeline']]),
  });
  const response = await input.upstream(forwarded);
  const out = new Response(response.body, response);
  out.headers.set('x-pipeline', 'ran');
  out.headers.append('set-cookie', 'a=1');
  out.headers.append('set-cookie', 'b=2');
  return out;
}) as unknown as HypHandler;

const get = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((done, fail) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.once('error', fail);
    req.end();
  });

describe('devMiddleware', () => {
  it('captures what the dev SSR writes, runs the pipeline over it and sends the result', async () => {
    const seen: string[] = [];
    const base = await serve(decorating, (req, res) => {
      seen.push(String(req.headers['x-forwarded-by']));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-qwik': 'dev' });
      res.write('<html>');
      res.write(Buffer.from('<body>hi</body>'));
      res.end('</html>');
    });
    const response = await get(`${base}/page/`);
    expect(response.status).toBe(200);
    expect(response.body).toBe('<html><body>hi</body></html>');
    expect(response.headers['x-pipeline']).toBe('ran');
    expect(response.headers['x-qwik']).toBe('dev');
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    // The downstream saw the request the pipeline forwarded, with the stages’ headers.
    expect(seen).toEqual(['pipeline']);
  });

  it('keeps the status of the dev SSR, including bodyless ones', async () => {
    const base = await serve(decorating, (req, res) => {
      if (req.url === '/gone') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('gone');
      } else {
        res.writeHead(304);
        res.end();
      }
    });
    expect((await get(`${base}/gone`)).status).toBe(404);
    const cached = await get(`${base}/cached`);
    expect(cached.status).toBe(304);
    expect(cached.body).toBe('');
    expect(cached.headers['x-pipeline']).toBe('ran');
  });

  it('answers a HEAD request without a body', async () => {
    const base = await serve(decorating, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });
    const head = await get(`${base}/page/`, {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['x-pipeline']).toBe('ran');
  });

  it('passes requests the pipeline does not want to the next middleware untouched', async () => {
    const base = await serve(decorating, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('export {}');
    });
    const module = await get(`${base}/src/root.tsx`);
    expect(module.body).toBe('export {}');
    expect(module.headers['x-pipeline']).toBeUndefined();
  });

  it('lets the pipeline answer without the dev SSR (internal routes, shield, rate limits)', async () => {
    const answering: HypHandler = (async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as HypHandler;
    let reached = false;
    const base = await serve(answering, (_req, res) => {
      reached = true;
      res.end('downstream');
    });
    const health = await get(`${base}/_hypdriv/health`);
    expect(health.body).toBe('{"ok":true}');
    expect(reached).toBe(false);
  });

  it('passes a failing pipeline to the next error handler', async () => {
    const failing: HypHandler = (async () => {
      throw new Error('pipeline failed');
    }) as unknown as HypHandler;
    const base = await serve(failing, (_req, res) => res.end('downstream'));
    const response = await get(`${base}/page/`);
    expect(response.status).toBe(500);
    expect(response.body).toContain('pipeline failed');
  });

  it('streams the body as the dev SSR writes it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = await serve(decorating, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('first;');
      void gate.then(() => res.end('second'));
    });
    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${base}/stream/`, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          chunks.push(chunk);
          if (chunks.join('') === 'first;') release();
        });
        res.on('end', resolve);
      });
      req.once('error', reject);
      req.end();
    });
    await done;
    expect(chunks.join('')).toBe('first;second');
  });
});
