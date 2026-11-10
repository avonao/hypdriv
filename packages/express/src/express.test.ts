import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import compression from 'compression';
import express, { type Express } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  flag,
  type HypDrivExpressOptions,
  hyp,
  hypdriv,
  jobHandler,
  nonce,
  useHypDriv,
  webHandler,
} from './index';

/** Temporary directories the tests create, removed when the file's tests are done. */
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};
const SUBRESOURCE = { ...BROWSER, accept: '*/*' };

const options = (overrides: Partial<HypDrivExpressOptions> = {}): HypDrivExpressOptions => ({
  config: { site: { name: 'express-test' } },
  target: 'node',
  development: false,
  ...overrides,
});

const servers: Server[] = [];

async function listen(app: Express) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const hits = { count: 0, seen: [] as Array<Record<string, string | undefined>> };

/** An app whose page renders the request's nonce on its own script tag, with a few more routes. */
function routes(app: Express) {
  app.get('/', (_req, res) => {
    res
      .type('html')
      .send(
        `<!doctype html><html><head><script nonce="${nonce() ?? ''}">boot()</script></head><body><p>${res.locals.hypdrivNonce ?? ''}</p><script>late()</script></body></html>`,
      );
  });
  app.get('/users/:id', (req, res) => {
    res.json({ id: req.params.id, route: hyp()?.route ?? null });
  });
  app.get('/api/time', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/facts', (_req, res) => {
    const ctx = hyp();
    res.json({ runner: ctx?.runner ?? null, requestId: ctx?.requestId ?? null, flag: flag('beta', false) });
  });
  app.get('/count', (_req, res) => {
    hits.count += 1;
    res.send('counted');
  });
  app.get('/seen-headers', (req, res) => {
    res.json({
      runner: req.get('x-hypdriv-runner') ?? null,
      route: req.get('x-hypdriv-route') ?? null,
      forged: req.get('x-hypdriv-forged') ?? null,
      nonce: req.get('x-nonce') ?? null,
    });
  });
  app.get('/own-headers', (_req, res) => {
    res.set({ 'x-app': 'yes', 'x-powered-by': 'app' }).send('ok');
  });
  app.get('/cookies', (_req, res) => {
    res.cookie('a', '1').cookie('b', '2').send('cookies');
  });
  app.get('/redirect', (_req, res) => res.redirect(302, '/'));
  app.get('/empty', (_req, res) => res.status(204).end());
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  app.get('/async-boom', async () => {
    throw new Error('async kaboom');
  });
  app.get('/stream', async (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: one\n\n');
    await new Promise((r) => setTimeout(r, 150));
    res.write('data: two\n\n');
    res.end();
  });
  return app;
}

async function boot(overrides: Partial<HypDrivExpressOptions> = {}, setup?: (app: Express) => void) {
  const app = express();
  const middleware = useHypDriv(app, options(overrides));
  setup?.(app);
  routes(app);
  const url = await listen(app);
  return { app, url, middleware };
}

beforeAll(() => {
  hits.count = 0;
});

describe('hypdriv() middleware', () => {
  it('runs the pipeline around the app and hands the request nonce to the page', async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/`, { headers: BROWSER });
    const csp = response.headers.get('content-security-policy') ?? '';
    const found = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(found).toBeTruthy();
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body).toContain(`<script nonce="${found}">boot()</script>`);
    expect(body).toContain(`<p>${found}</p>`);
    // The tag the app did not mark gets the nonce from the portable injection.
    expect(body).toContain(`<script nonce="${found}">late()</script>`);
  });

  it('issues a new nonce for every request', async () => {
    const { url } = await boot();
    const nonces = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${url}/`, { headers: BROWSER });
      nonces.add(/'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1] ?? '');
      await response.text();
    }
    expect(nonces.size).toBe(3);
    expect(nonces.has('')).toBe(false);
  });

  it('answers not-found responses and errors through the pipeline too', async () => {
    const { url } = await boot();
    const missing = await fetch(`${url}/nothing-here`, { headers: BROWSER });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
    expect(missing.headers.get('x-request-id')).toBeTruthy();
    const sync = await fetch(`${url}/boom`, { headers: BROWSER });
    expect(sync.status).toBe(500);
    expect(sync.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await sync.text()).toContain('Error');
    const rejected = await fetch(`${url}/async-boom`, { headers: BROWSER });
    expect(rejected.status).toBe(500);
    expect(rejected.headers.get('x-request-id')).toBeTruthy();
  });

  it('lets the pipeline remove a header the app set', async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/own-headers`, { headers: BROWSER });
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('x-app')).toBe('yes');
  });

  it('keeps several set-cookie headers, redirects and empty responses', async () => {
    const { url } = await boot();
    const cookies = await fetch(`${url}/cookies`, { headers: BROWSER });
    expect(cookies.headers.getSetCookie().map((c) => c.split(';')[0])).toEqual(['a=1', 'b=2']);
    const redirect = await fetch(`${url}/redirect`, { headers: BROWSER, redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/');
    const empty = await fetch(`${url}/empty`, { headers: BROWSER });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
  });

  it('serves the internal routes and reports the host', async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/_hypdriv/health`, { headers: BROWSER });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('Express');
    expect(text).toContain('"runner":"host"');
  });

  it('gives the routes of the app route ids', async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/users/42`, { headers: BROWSER });
    expect(await response.json()).toMatchObject({ id: '42', route: expect.stringContaining('users') });
  });

  it('makes hyp() and flag() available to route handlers', async () => {
    const { url } = await boot({
      config: { site: { name: 'express-test' }, flags: { definitions: { beta: { default: true } } } },
    });
    const body = (await (await fetch(`${url}/facts`, { headers: BROWSER })).json()) as Record<
      string,
      unknown
    >;
    expect(body.runner).toBe('host');
    expect(body.requestId).toBeTruthy();
    expect(body.flag).toBe(true);
  });

  it('rate-limits without calling the app, keyed by the socket address', async () => {
    hits.count = 0;
    const { url } = await boot({
      config: {
        site: { name: 'express-test' },
        security: { rateLimit: [{ id: 'count', match: '/count', limit: 2, window: '1m', key: ['ip'] }] },
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const response = await fetch(`${url}/count`, { headers: BROWSER });
      statuses.push(response.status);
      if (response.status === 429) expect(response.headers.get('retry-after')).toBeTruthy();
      await response.text();
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(hits.count).toBe(2);
  });

  it('blocks automated clients with the bot shield before the app runs', async () => {
    hits.count = 0;
    const { url } = await boot({
      config: { site: { name: 'express-test' }, security: { bots: { likelyAutomated: 'block' } } },
    });
    const response = await fetch(`${url}/count`, { headers: { 'user-agent': 'curl/8.4.0' } });
    expect(response.status).toBe(403);
    expect(hits.count).toBe(0);
  });

  it('strips client-sent x-hypdriv-* and nonce headers and forwards the stages own', async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/seen-headers`, {
      headers: {
        ...BROWSER,
        'x-hypdriv-runner': 'forged',
        'x-hypdriv-route': 'forged',
        'x-hypdriv-forged': '1',
        'x-nonce': 'attacker',
      },
    });
    const seen = (await response.json()) as Record<string, string | null>;
    expect(seen.runner).toBe('host');
    expect(seen.route).not.toBe('forged');
    expect(seen.forged).toBeNull();
    expect(seen.nonce).not.toBe('attacker');
    expect(seen.nonce).toBeTruthy();
  });
});

describe('streaming', () => {
  it('passes a streamed response through without buffering it', async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/stream`, { headers: BROWSER });
    const reader = response.body!.getReader();
    const started = Date.now();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: one\n\n');
    expect(Date.now() - started).toBeLessThan(120);
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('data: two\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('still injects nonces into HTML that is written in pieces', async () => {
    const { url } = await boot({}, (app) => {
      app.get('/pieces', async (_req, res) => {
        res.type('html');
        res.write('<!doctype html><html><head></head><body><scr');
        await new Promise((r) => setTimeout(r, 30));
        res.end('ipt>late()</script></body></html>');
      });
    });
    const response = await fetch(`${url}/pieces`, { headers: BROWSER });
    const found = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(await response.text()).toContain(`<script nonce="${found}">late()</script>`);
  });

  it('streams a file with res.sendFile and conditional requests', async () => {
    const dir = tempDir('hypdriv-express-');
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    const { url } = await boot({}, (app) => {
      app.get('/big', (_req, res) => res.sendFile(join(dir, 'big.bin')));
    });
    // A subresource request (`Accept: */*`): navigations that carry a nonce never get a validator-based 304.
    const response = await fetch(`${url}/big`, { headers: SUBRESOURCE });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer()).length).toBe(3 * 1024 * 1024);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    // fetch adds `Cache-Control: no-cache` to conditional requests unless one is given; that would defeat freshness.
    const conditional = await fetch(`${url}/big`, {
      headers: { ...SUBRESOURCE, 'if-none-match': etag!, 'cache-control': 'max-age=0' },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
  });

  it('answers HEAD requests without a body but with the headers', async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/`, { method: 'HEAD', headers: BROWSER });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toBeTruthy();
    expect(await response.text()).toBe('');
  });

  it('stops the app when the client leaves', async () => {
    let closed: () => void = () => undefined;
    const sawClose = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const { url } = await boot({}, (app) => {
      app.get('/forever', (_req, res) => {
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: hi\n\n');
        res.on('close', closed);
      });
    });
    const abort = new AbortController();
    const response = await fetch(`${url}/forever`, { headers: BROWSER, signal: abort.signal });
    await response.body!.getReader().read();
    abort.abort();
    await sawClose;
  });
});

describe('request bodies', () => {
  it('lets body parsers read JSON and forms registered below the middleware', async () => {
    const { url } = await boot({}, (app) => {
      app.post('/json', express.json(), (req, res) => {
        res.json({ got: req.body, length: req.get('content-length') });
      });
      app.post('/form', express.urlencoded({ extended: false }), (req, res) => {
        res.json({ got: req.body });
      });
    });
    const json = await fetch(`${url}/json`, {
      method: 'POST',
      headers: { ...BROWSER, 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(await json.json()).toEqual({ got: { hello: 'world' }, length: '17' });
    const form = await fetch(`${url}/form`, {
      method: 'POST',
      headers: { ...BROWSER, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=two',
    });
    expect(await form.json()).toEqual({ got: { a: '1', b: 'two' } });
  });

  it('streams a large upload to the app without the pipeline taking it', async () => {
    const { url } = await boot({}, (app) => {
      app.post('/upload', (req, res) => {
        const hash = createHash('sha256');
        let length = 0;
        req.on('data', (chunk: Buffer) => {
          hash.update(chunk);
          length += chunk.length;
        });
        req.on('end', () => res.json({ length, sha: hash.digest('hex') }));
      });
    });
    const chunk = Buffer.alloc(256 * 1024, 5);
    const expected = createHash('sha256');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 24; i++) {
          controller.enqueue(chunk);
          expected.update(chunk);
        }
        controller.close();
      },
    });
    const response = await fetch(`${url}/upload`, {
      method: 'POST',
      headers: BROWSER,
      body,
      duplex: 'half',
    } as RequestInit);
    expect(await response.json()).toEqual({ length: 24 * 256 * 1024, sha: expected.digest('hex') });
  });

  it('checks the CSRF form field without taking the form from the app', async () => {
    const { url } = await boot(
      { config: { site: { name: 'express-test' }, security: { csrf: { match: '/form/**' } } } },
      (app) => {
        app.post('/form/save', express.urlencoded({ extended: false }), (req, res) => {
          res.json({ got: req.body });
        });
      },
    );
    const headers = {
      ...BROWSER,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: 'hyp_csrf=token-1',
      'sec-fetch-site': 'cross-site',
    };
    const ok = await fetch(`${url}/form/save`, {
      method: 'POST',
      headers,
      body: 'x-csrf-token=token-1&name=Ada',
    });
    expect(ok.status).toBe(200);
    // The stage read the form; the application still gets every field.
    expect(await ok.json()).toEqual({ got: { 'x-csrf-token': 'token-1', name: 'Ada' } });
    const rejected = await fetch(`${url}/form/save`, {
      method: 'POST',
      headers,
      body: 'x-csrf-token=other&name=Ada',
    });
    expect(rejected.status).toBe(403);
  });

  it('serves the POST internal routes with their bodies', async () => {
    const { url } = await boot({
      config: { site: { name: 'express-test' }, observe: { vitals: { sink: 'log' } } },
    });
    const response = await fetch(`${url}/_hypdriv/csp-report`, {
      method: 'POST',
      headers: { ...BROWSER, 'content-type': 'application/csp-report' },
      body: JSON.stringify({
        'csp-report': { 'blocked-uri': 'https://evil.example', 'violated-directive': 'script-src' },
      }),
    });
    expect(response.status).toBeLessThan(300);
  });
});

describe('static files and compression', () => {
  it('serves express.static files with the security header preset, outside the stages', async () => {
    const dir = tempDir('hypdriv-express-static-');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const { url } = await boot({}, (app) => {
      app.use('/assets', express.static(dir, { immutable: true, maxAge: '1y' }));
    });
    const response = await fetch(`${url}/assets/app.js`, { headers: BROWSER });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log(1)');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('immutable');
    // No stages ran: no request id, no CSP.
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('can leave static files alone', async () => {
    const dir = tempDir('hypdriv-express-static-');
    writeFileSync(join(dir, 'app.css'), 'a{}');
    const { url } = await boot({ staticHeaders: false }, (app) => {
      app.use(express.static(dir));
    });
    const response = await fetch(`${url}/app.css`, { headers: BROWSER });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBeNull();
  });

  it('honours a custom skip rule', async () => {
    const { url } = await boot({ skip: (u) => u.pathname === '/count' }, () => undefined);
    const response = await fetch(`${url}/count`, { headers: BROWSER });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBeNull();
  });

  it('works under compression() registered before it: the pipeline sees plain HTML, the client gets gzip', async () => {
    const app = express();
    app.use(compression({ threshold: 0 }));
    useHypDriv(app, options());
    routes(app);
    const url = await listen(app);
    const response = await fetch(`${url}/`, { headers: { ...BROWSER, 'accept-encoding': 'gzip' } });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const found = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    // fetch decoded the gzip body: the nonce injection happened before compression.
    expect(await response.text()).toContain(`<script nonce="${found}">late()</script>`);
  });

  it('works when the app is mounted below compression() and express.static of an outer app (examples/express)', async () => {
    const dir = tempDir('hypdriv-express-outer-');
    writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\n');
    const inner = express();
    useHypDriv(inner, options());
    routes(inner);
    const outer = express();
    outer.use(compression({ threshold: 0 }));
    outer.use(inner);
    outer.use(express.static(dir));
    const url = await listen(outer);
    const page = await fetch(`${url}/`, { headers: { ...BROWSER, 'accept-encoding': 'gzip' } });
    expect(page.headers.get('content-encoding')).toBe('gzip');
    const found = /'nonce-([^']+)'/.exec(page.headers.get('content-security-policy') ?? '')?.[1];
    expect(await page.text()).toContain(`<script nonce="${found}">late()</script>`);
    // A path the inner app does not answer falls through to the outer app's static files, with the security headers.
    const file = await fetch(`${url}/robots.txt`, { headers: SUBRESOURCE });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('User-agent: *\n');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    const missing = await fetch(`${url}/nope.txt`, { headers: SUBRESOURCE });
    expect(missing.status).toBe(404);
  });
});

describe('mounting and platform facts', () => {
  it('builds URLs from originalUrl when the middleware is mounted below a path', async () => {
    const app = express();
    const seen: string[] = [];
    app.use(
      '/shop',
      hypdriv(
        options({
          config: {
            site: { name: 'express-test' },
            redirects: { rules: [{ from: '/shop/old', to: '/shop/new' }] },
          },
        }),
      ),
    );
    app.get('/shop/page', (req, res) => {
      seen.push(req.originalUrl);
      res.send('page');
    });
    const url = await listen(app);
    const redirect = await fetch(`${url}/shop/old`, { headers: BROWSER, redirect: 'manual' });
    expect(redirect.status).toBeGreaterThanOrEqual(301);
    expect(redirect.headers.get('location')).toContain('/shop/new');
    expect((await fetch(`${url}/shop/page`, { headers: BROWSER })).status).toBe(200);
    expect(seen).toEqual(['/shop/page']);
  });

  it('upgrades plain HTTP before anything answers, internal routes and assets included', async () => {
    const dir = tempDir('hypdriv-express-https-');
    writeFileSync(join(dir, 'logo.png'), 'png');
    const { url } = await boot(
      { config: { site: { name: 'express-test', origin: 'https://shop.example' } } },
      (app) => {
        app.use(express.static(dir));
      },
    );
    const target = new URL(url);
    const get = (path: string) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          { host: target.hostname, port: target.port, path, headers: { host: 'shop.example', ...BROWSER } },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });
    for (const path of ['/', '/_hypdriv/health', '/logo.png']) {
      const response = await get(path);
      expect(response.statusCode, path).toBe(308);
      expect(response.headers.location).toBe(`https://shop.example${path}`);
      response.resume();
    }
  });

  it('takes the client address from the forwarded headers when proxies are configured', async () => {
    hits.count = 0;
    const { url } = await boot({
      config: {
        site: { name: 'express-test' },
        security: {
          trustedProxies: 1,
          rateLimit: [{ id: 'count', match: '/count', limit: 1, window: '1m', key: ['ip'] }],
        },
      },
    });
    const call = (ip: string) =>
      fetch(`${url}/count`, { headers: { ...BROWSER, 'x-forwarded-for': `${ip}, 10.0.0.1` } }).then(
        async (r) => {
          await r.text();
          return r.status;
        },
      );
    expect(await call('203.0.113.1')).toBe(200);
    expect(await call('203.0.113.2')).toBe(200);
    expect(await call('203.0.113.1')).toBe(429);
  });

  it('trusts x-forwarded-proto for the URL behind a proxy', async () => {
    const { url } = await boot({
      trustProxy: true,
      config: { site: { name: 'express-test' }, redirects: { forceHttps: true } },
    });
    const response = await fetch(`${url}/`, { headers: { ...BROWSER, 'x-forwarded-proto': 'https' } });
    expect(response.status).toBe(200);
  });
});

describe('webHandler', () => {
  it('mounts a Web-standard handler and streams its response', async () => {
    const { url } = await boot({}, (app) => {
      app.post(
        '/web',
        webHandler(async (request) => {
          const body = await request.text();
          return Response.json({ method: request.method, path: new URL(request.url).pathname, body });
        }),
      );
    });
    const response = await fetch(`${url}/web`, { method: 'POST', headers: BROWSER, body: 'ping' });
    expect(await response.json()).toEqual({ method: 'POST', path: '/web', body: 'ping' });
  });

  it('runs Hypdriv jobs behind the cron secret', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret');
    vi.stubEnv('HYPDRIV_INTERNAL_SECRET', 'internal-secret');
    try {
      const { url } = await boot({}, (app) => {
        app.post('/jobs/ping', webHandler(jobHandler({}, async ({ job, payload }) => ({ job, payload }))));
      });
      const body = JSON.stringify({ payload: { n: 1 } });
      const headers = { ...BROWSER, 'content-type': 'application/json' };
      const denied = await fetch(`${url}/jobs/ping`, { method: 'POST', headers, body });
      expect(denied.status).toBe(401);
      const accepted = await fetch(`${url}/jobs/ping`, {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer s3cret' },
        body,
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({
        ok: true,
        job: 'ping',
        result: { job: 'ping', payload: { n: 1 } },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('forwards a failing handler to the error handlers', async () => {
    const { url } = await boot({}, (app) => {
      app.get(
        '/web-fail',
        webHandler(() => {
          throw new Error('nope');
        }),
      );
    });
    const response = await fetch(`${url}/web-fail`, { headers: BROWSER });
    expect(response.status).toBe(500);
  });
});

describe('failures', () => {
  it('keeps serving with generic behaviour when the manifest cannot be loaded', async () => {
    const app = express();
    app.use(hypdriv(options({ manifest: () => Promise.reject(new Error('manifest failed')) })));
    app.get('/', (_req, res) => res.send('still here'));
    const url = await listen(app);
    const response = await fetch(`${url}/`, { headers: BROWSER });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('still here');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('forwards a failure that happens before the app is entered to the error handlers', async () => {
    const app = express();
    app.use(
      hypdriv(
        options({
          skip: () => {
            throw new Error('skip failed');
          },
        }),
      ),
    );
    app.get('/', (_req, res) => res.send('never'));
    app.use((error: Error, _req: unknown, res: express.Response, _next: unknown) => {
      res.status(503).send(`handled: ${error.message}`);
    });
    const url = await listen(app);
    const response = await fetch(`${url}/`, { headers: BROWSER });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('handled: skip failed');
  });

  it('ends the connection when the app fails after it started the response', async () => {
    const { url } = await boot({}, (app) => {
      app.get('/partial', (_req, res, next) => {
        res.setHeader('content-type', 'text/plain');
        res.write('part');
        setTimeout(() => next(new Error('late failure')), 20);
      });
    });
    const response = await fetch(`${url}/partial`, { headers: BROWSER });
    await expect(response.text()).rejects.toThrow();
  });
});

describe('documents rendered with a nonce', () => {
  it('are never answered 304 from the validators the app computed: the cached body would carry an earlier nonce', async () => {
    const { url } = await boot({}, (app) => {
      // The same bytes on every request: Express' ETag matches, and the pipeline injects a different nonce each time.
      app.get(
        '/constant',
        (_req, res) =>
          void res.type('html').send('<!doctype html><html><body><script>x()</script></body></html>'),
      );
    });
    const first = await fetch(`${url}/constant`, { headers: BROWSER });
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const nonceOf = (response: Response) =>
      /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(await first.text()).toContain(`<script nonce="${nonceOf(first)}">x()</script>`);
    const again = await fetch(`${url}/constant`, {
      headers: { ...BROWSER, 'if-none-match': etag!, 'cache-control': 'max-age=0' },
    });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain(`<script nonce="${nonceOf(again)}">x()</script>`);
    expect(nonceOf(again)).not.toBe(nonceOf(first));
  });

  it('keep answering conditional requests for JSON', async () => {
    const { url } = await boot();
    const first = await fetch(`${url}/api/time`, { headers: BROWSER });
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    await first.text();
    const again = await fetch(`${url}/api/time`, {
      headers: {
        ...BROWSER,
        accept: 'application/json',
        'if-none-match': etag!,
        'cache-control': 'max-age=0',
      },
    });
    expect(again.status).toBe(304);
  });
});

describe('route discovery', () => {
  it('gives every kind of route its id: nested routers, mounted parameters, sub-apps and the routes option', async () => {
    const app = express();
    useHypDriv(app, options({ routes: ['/legacy/:id'] }));
    const api = express.Router();
    const admin = express.Router();
    admin.get('/stats', (_req, res) => void res.json({ route: hyp()?.route }));
    api.get('/users/:id', (_req, res) => void res.json({ route: hyp()?.route }));
    api.use('/admin', admin);
    app.use('/api', api);
    const tenant = express.Router({ mergeParams: true });
    tenant.get('/dashboard', (_req, res) => void res.json({ route: hyp()?.route }));
    app.use('/tenants/:tenant', tenant);
    const sub = express();
    sub.get('/page', (_req, res) => void res.json({ route: hyp()?.route }));
    app.use('/sub', sub);
    app.get(/^\/legacy\/(\d+)$/, (_req, res) => void res.json({ route: hyp()?.route }));
    app.get('/docs{/:page}', (_req, res) => void res.json({ route: hyp()?.route }));
    const url = await listen(app);
    const routeOf = async (path: string) =>
      ((await (await fetch(`${url}${path}`, { headers: BROWSER })).json()) as { route: string }).route;
    expect(await routeOf('/api/users/7')).toBe('endpoint:/api/users/[id]');
    expect(await routeOf('/api/admin/stats')).toBe('endpoint:/api/admin/stats');
    expect(await routeOf('/tenants/acme/dashboard')).toBe('endpoint:/tenants/[tenant]/dashboard');
    expect(await routeOf('/sub/page')).toBe('endpoint:/sub/[[...splat]]');
    expect(await routeOf('/legacy/12')).toBe('endpoint:/legacy/[id]');
    expect(await routeOf('/docs')).toBe('endpoint:/docs');
    expect(await routeOf('/docs/intro')).toBe('endpoint:/docs/[page]');
  });

  it('applies route-keyed policy to the discovered routes', async () => {
    hits.count = 0;
    const { url } = await boot(
      {
        config: {
          site: { name: 'express-test' },
          security: { rateLimit: [{ id: 'users', match: '/users/*', limit: 1, window: '1m', key: ['ip'] }] },
        },
      },
      undefined,
    );
    const statuses: number[] = [];
    for (const id of ['1', '2']) {
      const response = await fetch(`${url}/users/${id}`, { headers: BROWSER });
      statuses.push(response.status);
      await response.text();
    }
    expect(statuses).toEqual([200, 429]);
  });
});

describe('response callbacks and clean-up', () => {
  it('calls the end() callback once the response was written', async () => {
    let called = false;
    const { url } = await boot({}, (app) => {
      app.get('/cb', (_req, res) => {
        res.end('done', () => {
          called = true;
        });
      });
    });
    const response = await fetch(`${url}/cb`, { headers: BROWSER });
    expect(await response.text()).toBe('done');
    await vi.waitFor(() => expect(called).toBe(true));
  });

  it('keeps a pipelined keep-alive connection usable after a captured response', async () => {
    const { url } = await boot();
    const target = new URL(url);
    const agent = new (await import('node:http')).Agent({ keepAlive: true, maxSockets: 1 });
    const get = (path: string) =>
      new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: target.hostname, port: target.port, path, agent, headers: BROWSER },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString()));
          },
        );
        req.on('error', reject);
        req.end();
      });
    try {
      expect(await get('/count')).toBe('counted');
      expect(await get('/count')).toBe('counted');
      expect(await get('/api/time')).toBe('{"ok":true}');
    } finally {
      agent.destroy();
    }
  });
});

describe('client addresses by platform', () => {
  const limited = {
    site: { name: 'express-test' },
    security: { rateLimit: [{ id: 'count', match: '/count', limit: 1, window: '1m', key: ['ip' as const] }] },
  };
  const call = async (url: string, forwarded: string) => {
    const response = await fetch(`${url}/count`, { headers: { ...BROWSER, 'x-forwarded-for': forwarded } });
    await response.text();
    return response.status;
  };

  it('keys by the socket address on a plain Node server, whatever x-forwarded-for claims', async () => {
    const { url } = await boot({ config: limited });
    expect(await call(url, '198.51.100.1')).toBe(200);
    expect(await call(url, '198.51.100.2')).toBe(429);
  });

  it('keys by the forwarded address on Vercel, where the socket peer is the platform proxy', async () => {
    vi.stubEnv('VERCEL', '1');
    try {
      const { url } = await boot({ config: limited });
      expect(await call(url, '198.51.100.1')).toBe(200);
      expect(await call(url, '198.51.100.2')).toBe(200);
      expect(await call(url, '198.51.100.1')).toBe(429);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('stale-while-revalidate', () => {
  // Nonce documents are never shared-cached, so the cached page runs without a CSP.
  const swrConfig = {
    site: { name: 'express-test' },
    security: { csp: false as const },
    cache: { edge: { policies: [{ match: '/page', ttl: 10, swr: 60 }] } },
  };

  function harness(mode: 'useHypDriv(app)' | 'hypdriv() without the app') {
    let renders = 0;
    const app = express();
    if (mode === 'useHypDriv(app)') useHypDriv(app, options({ config: swrConfig }));
    else app.use(hypdriv(options({ config: swrConfig })));
    app.get('/page', (_req, res) => {
      renders += 1;
      res.type('html').send(`<!doctype html><html><body>render ${renders}</body></html>`);
    });
    return { app, renders: () => renders };
  }

  const page = async (url: string) => {
    const response = await fetch(`${url}/page`, { headers: BROWSER });
    return { status: response.headers.get('x-hypdriv-cache'), body: await response.text() };
  };

  it('refreshes a stale page in the background through the app', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = harness('useHypDriv(app)');
      const url = await listen(h.app);
      expect(await page(url)).toMatchObject({ status: 'MISS', body: expect.stringContaining('render 1') });
      await vi.waitFor(async () => expect((await page(url)).status).toBe('HIT'));
      vi.setSystemTime(Date.now() + 15_000);
      const stale = await page(url);
      expect(stale.status).toBe('STALE');
      expect(stale.body).toContain('render 1');
      await vi.waitFor(() => expect(h.renders()).toBe(2));
      await vi.waitFor(async () => {
        const fresh = await page(url);
        expect(fresh.status).toBe('HIT');
        expect(fresh.body).toContain('render 2');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps serving the stale page, and renders nothing behind the viewer, when the middleware does not know the app', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = harness('hypdriv() without the app');
      const url = await listen(h.app);
      await page(url);
      await vi.waitFor(async () => expect((await page(url)).status).toBe('HIT'));
      vi.setSystemTime(Date.now() + 15_000);
      expect((await page(url)).status).toBe('STALE');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.renders()).toBe(1);
      expect((await page(url)).body).toContain('render 1');
    } finally {
      vi.useRealTimers();
    }
  });
});
