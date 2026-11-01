import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { emptyManifest, type HypManifest } from '@hypdriv/core';
import { toHypRoute } from '@hypdriv/vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetched: string[] = [];
let answer: (request: Request) => Response | null = () =>
  new Response('<html><body>rendered</body></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

// Qwik's own request handler needs the application's router config: the wrapper is tested against a stand-in.
vi.mock('./fetch', async (importOriginal) => {
  const original = await importOriginal<typeof import('./fetch')>();
  return {
    ...original,
    isStaticPath: (method: string, url: URL) =>
      method === 'GET' && (url.pathname.startsWith('/build/') || url.pathname === '/robots.txt'),
    createQwikFetch: () => async (request: Request) => {
      fetched.push(`${request.method} ${new URL(request.url).pathname}`);
      return answer(request);
    },
  };
});

const { documentIndex, isDocumentRequest, originFor, staticRoot, wrapNode } = await import('./node');

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};

const roots: string[] = [];
let server: Server | undefined;

function site(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-qwik-node-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function manifestOf(pathnames: string[], trailingSlash = true): HypManifest {
  const documents = pathnames.map((pathname) => ({
    ...toHypRoute({ pathname, kind: 'page', prerendered: true }),
    servedStatically: true,
  }));
  return emptyManifest({
    buildId: 'build-1',
    trailingSlash,
    staticFiles: { count: 3, immutablePrefixes: ['/build/', '/assets/'] },
    routes: [...documents, toHypRoute({ pathname: '/dynamic', kind: 'page' })],
    // The build hashed the inline scripts of every prerendered document.
    csp: Object.fromEntries(
      documents.map((route) => [route.id, { scriptHashes: ["'sha256-AAAA'"], styleHashes: [] }]),
    ),
  });
}

beforeEach(() => {
  fetched.length = 0;
  answer = () =>
    new Response('<html><body>rendered</body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
});

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  server?.closeAllConnections();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

describe('documentIndex', () => {
  it('lists the static page routes and the trailing slash convention', () => {
    const index = documentIndex(manifestOf(['/', '/about', '/blog/hello']));
    expect([...index.paths].sort()).toEqual(['/', '/about', '/blog/hello']);
    expect(index.trailingSlash).toBe(true);
  });

  it('leaves out dynamic routes, endpoints and routes the application renders', () => {
    const manifest = emptyManifest({
      routes: [
        { ...toHypRoute({ pathname: '/blog/[slug]', kind: 'page' }), servedStatically: true },
        {
          ...toHypRoute({ pathname: '/api/hello', kind: 'endpoint', prerendered: true }),
          servedStatically: true,
        },
        toHypRoute({ pathname: '/about', kind: 'page', prerendered: true }),
      ],
    });
    expect(documentIndex(manifest).paths.size).toBe(0);
  });
});

describe('isDocumentRequest', () => {
  const index = documentIndex(manifestOf(['/', '/about']));
  const plain = documentIndex(manifestOf(['/', '/about'], false));

  it('matches the exact URL the application uses for the page', () => {
    expect(isDocumentRequest(index, 'GET', '/')).toBe(true);
    expect(isDocumentRequest(index, 'GET', '/about/')).toBe(true);
    expect(isDocumentRequest(index, 'HEAD', '/about/')).toBe(true);
    expect(isDocumentRequest(plain, 'GET', '/about')).toBe(true);
  });

  it('leaves the other spelling to the framework’s redirect', () => {
    expect(isDocumentRequest(index, 'GET', '/about')).toBe(false);
    expect(isDocumentRequest(plain, 'GET', '/about/')).toBe(false);
  });

  it('only answers reads of listed pages', () => {
    expect(isDocumentRequest(index, 'POST', '/about/')).toBe(false);
    expect(isDocumentRequest(index, 'GET', '/dynamic/')).toBe(false);
    expect(isDocumentRequest(documentIndex(manifestOf([])), 'GET', '/')).toBe(false);
  });
});

describe('staticRoot', () => {
  it('uses the configured directory', () => {
    expect(staticRoot('/srv/app/dist')).toBe('/srv/app/dist');
  });

  it('finds dist next to the server entry', () => {
    const root = site({ 'dist/index.html': '', 'server/entry.node.js': '' });
    expect(staticRoot(undefined, `file://${join(root, 'server', 'entry.node.js')}`)).toBe(join(root, 'dist'));
  });
});

describe('originFor', () => {
  const req = (headers: Record<string, string>, encrypted = false) =>
    ({ headers, socket: { encrypted } }) as unknown as IncomingMessage;

  it('prefers the option, then ORIGIN', () => {
    expect(
      originFor(req({}), { origin: 'https://a.example' } as never, { ORIGIN: 'https://b.example' }),
    ).toBe('https://a.example');
    expect(originFor(req({}), {} as never, { ORIGIN: 'https://b.example' })).toBe('https://b.example');
    expect(
      originFor(req({}), { getOrigin: () => 'https://c.example', origin: 'https://a.example' } as never, {}),
    ).toBe('https://c.example');
  });

  it('builds it from the proxy headers Qwik documents', () => {
    expect(
      originFor(req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'shop.example' }), {} as never, {
        PROTOCOL_HEADER: 'x-forwarded-proto',
        HOST_HEADER: 'x-forwarded-host',
      }),
    ).toBe('https://shop.example');
    expect(originFor(req({ host: 'localhost:3000' }), {} as never, { HOST_HEADER: 'host' })).toBe(
      'http://localhost:3000',
    );
  });

  it('leaves the origin to the request URL when nothing names it', () => {
    expect(originFor(req({ host: 'localhost' }), {} as never, {})).toBeUndefined();
  });
});

describe('wrapNode', () => {
  const options = (manifest: HypManifest) => ({
    config: { site: { name: 'qwik-node-test' } },
    manifest,
    development: false,
  });

  function listen(router: ReturnType<typeof wrapNode>): Promise<string> {
    server = createServer(router.listener);
    return new Promise((done) =>
      server!.listen(0, '127.0.0.1', () =>
        done(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`),
      ),
    );
  }

  const get = (url: string, headers: Record<string, string> = BROWSER, method = 'GET') =>
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

  it('serves prerendered documents and hashed files from disk through the pipeline', async () => {
    const root = site({
      'index.html': '<html><body>home</body></html>',
      'about/index.html': '<html><body>about</body></html>',
      'build/q-abc.js': 'export {}',
      'robots.txt': 'User-agent: *\n',
    });
    const base = await listen(wrapNode({ static: { root } } as never, options(manifestOf(['/', '/about']))));
    const home = await get(`${base}/`);
    expect(home.body).toContain('home');
    expect(home.headers['x-frame-options']).toBe('DENY');
    expect(home.headers['x-hypdriv-csp']).toBe('hash');
    expect((await get(`${base}/about/`)).body).toContain('about');
    const asset = await get(`${base}/build/q-abc.js`, { ...BROWSER, accept: '*/*' });
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toMatch(/immutable/);
    expect((await get(`${base}/robots.txt`, { ...BROWSER, accept: '*/*' })).status).toBe(200);
    // None of it reached Qwik.
    expect(fetched).toEqual([]);
  });

  it('renders everything else with Qwik, with a nonce policy', async () => {
    const root = site({ 'index.html': 'home' });
    const base = await listen(wrapNode({ static: { root } } as never, options(manifestOf(['/']))));
    const page = await get(`${base}/dynamic/`);
    expect(page.body).toContain('rendered');
    expect(page.headers['x-hypdriv-csp']).toBe('nonce');
    expect(/'nonce-([^']+)'/.exec(String(page.headers['content-security-policy']))?.[1]).toBeTruthy();
    expect(fetched).toEqual(['GET /dynamic/']);
  });

  it('renders a listed document that is not on disk, and 404s a listed static file that is not', async () => {
    const root = site({ 'index.html': 'home' });
    const base = await listen(wrapNode({ static: { root } } as never, options(manifestOf(['/', '/about']))));
    expect((await get(`${base}/about/`)).body).toContain('rendered');
    expect(fetched).toEqual(['GET /about/']);
    const missing = await get(`${base}/build/q-gone.js`, { ...BROWSER, accept: '*/*' });
    expect(missing.status).toBe(404);
    expect(fetched).toEqual(['GET /about/']);
  });

  it('lets the other spelling of a page reach Qwik for its redirect', async () => {
    const root = site({ 'about/index.html': 'about' });
    answer = () => new Response(null, { status: 301, headers: { location: '/about/' } });
    const base = await listen(wrapNode({ static: { root } } as never, options(manifestOf(['/about']))));
    const response = await get(`${base}/about`);
    expect(response.status).toBe(301);
    expect(response.headers.location).toBe('/about/');
    expect(fetched).toEqual(['GET /about']);
  });

  it('answers 404 when Qwik has no route and applies a configured Cache-Control to files', async () => {
    const root = site({ 'build/q-abc.js': 'export {}' });
    answer = () => null;
    const base = await listen(
      wrapNode({ static: { root, cacheControl: 'public, max-age=60' } } as never, options(manifestOf([]))),
    );
    expect((await get(`${base}/nowhere/`)).status).toBe(404);
    const asset = await get(`${base}/build/q-abc.js`, { ...BROWSER, accept: '*/*' });
    expect(asset.headers['cache-control']).toBe('public, max-age=60');
  });

  it('exposes the Web fetch of the same pipeline and Qwik’s middleware shapes', async () => {
    const root = site({ 'index.html': 'home' });
    const router = wrapNode({ static: { root } } as never, options(manifestOf(['/'])));
    const response = await router.fetch(new Request('https://shop.example/dynamic/', { headers: BROWSER }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    let passed = 0;
    router.staticFile({} as never, {} as never, () => passed++);
    router.notFound({} as never, {} as never, () => passed++);
    expect(passed).toBe(2);
  });
});
