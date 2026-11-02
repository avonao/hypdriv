import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import fastifyCompress from '@fastify/compress';
import fastifyEtag from '@fastify/etag';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flag, type HypDrivFastifyOptions, hyp, hypdriv, jobHandler, nonce, webRoute } from './index';

const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US',
};
const SUBRESOURCE = { ...BROWSER, accept: '*/*' };

const options = (overrides: Partial<HypDrivFastifyOptions> = {}): HypDrivFastifyOptions => ({
  config: { site: { name: 'fastify-test' } },
  target: 'node',
  development: false,
  ...overrides,
});

const apps: FastifyInstance[] = [];

async function listen(app: FastifyInstance) {
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const hits = { count: 0 };

function routes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    return reply
      .type('text/html')
      .send(
        `<!doctype html><html><head><script nonce="${nonce() ?? ''}">boot()</script></head><body><p>${request.hypdrivNonce ?? ''}</p><script>late()</script></body></html>`,
      );
  });
  app.get<{ Params: { id: string } }>('/users/:id', async (request) => ({
    id: request.params.id,
    route: hyp()?.route ?? null,
  }));
  app.get('/api/time', async () => ({ ok: true }));
  app.get('/facts', async () => {
    const ctx = hyp();
    return { runner: ctx?.runner ?? null, requestId: ctx?.requestId ?? null, flag: flag('beta', false) };
  });
  app.get('/count', async () => {
    hits.count += 1;
    return 'counted';
  });
  app.get('/seen-headers', async (request) => ({
    runner: request.headers['x-hypdriv-runner'] ?? null,
    route: request.headers['x-hypdriv-route'] ?? null,
    forged: request.headers['x-hypdriv-forged'] ?? null,
    nonce: request.headers['x-nonce'] ?? null,
  }));
  app.get('/own-headers', async (_request, reply) =>
    reply.header('x-app', 'yes').header('x-powered-by', 'app').send('ok'),
  );
  app.get('/cookies', async (_request, reply) => reply.header('set-cookie', ['a=1', 'b=2']).send('cookies'));
  app.get('/redirect', async (_request, reply) => reply.redirect('/', 302));
  app.get('/empty', async (_request, reply) => reply.code(204).send());
  app.get('/boom', async () => {
    throw new Error('kaboom');
  });
  app.get('/stream', (_request, reply) => {
    const stream = new PassThrough();
    stream.write('data: one\n\n');
    setTimeout(() => {
      stream.write('data: two\n\n');
      stream.end();
    }, 150);
    return reply.header('content-type', 'text/event-stream').send(stream);
  });
  return app;
}

async function boot(
  overrides: Partial<HypDrivFastifyOptions> = {},
  setup?: (app: FastifyInstance) => void | Promise<void>,
) {
  const app = Fastify({ forceCloseConnections: true });
  await app.register(hypdriv, options(overrides));
  await setup?.(app);
  routes(app);
  const url = await listen(app);
  return { app, url };
}

describe('hypdriv plugin', () => {
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
    const failed = await fetch(`${url}/boom`, { headers: BROWSER });
    expect(failed.status).toBe(500);
    expect(failed.headers.get('x-content-type-options')).toBe('nosniff');
    expect(failed.headers.get('x-request-id')).toBeTruthy();
    expect(await failed.text()).toContain('kaboom');
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
    expect(text).toContain('Fastify');
    expect(text).toContain('"runner":"host"');
  });

  it('makes hyp() and flag() available to route handlers', async () => {
    const { url } = await boot({
      config: { site: { name: 'fastify-test' }, flags: { definitions: { beta: { default: true } } } },
    });
    const body = (await (await fetch(`${url}/facts`, { headers: BROWSER })).json()) as Record<
      string,
      unknown
    >;
    expect(body.runner).toBe('host');
    expect(body.requestId).toBeTruthy();
    expect(body.flag).toBe(true);
  });

  it('rate-limits without calling the route, keyed by the socket address', async () => {
    hits.count = 0;
    const { url } = await boot({
      config: {
        site: { name: 'fastify-test' },
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

  it('blocks automated clients with the bot shield before the route runs', async () => {
    hits.count = 0;
    const { url } = await boot({
      config: { site: { name: 'fastify-test' }, security: { bots: { likelyAutomated: 'block' } } },
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

  it('does not let a client skip the pipeline with the revalidation marker header', async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/seen-headers`, {
      headers: { ...BROWSER, 'x-hypdriv-detached': 'guess' },
    });
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(((await response.json()) as Record<string, unknown>).runner).toBe('host');
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
      app.get('/pieces', (_request, reply) => {
        const stream = new PassThrough();
        stream.write('<!doctype html><html><head></head><body><scr');
        setTimeout(() => stream.end('ipt>late()</script></body></html>'), 30);
        return reply.type('text/html').send(stream);
      });
    });
    const response = await fetch(`${url}/pieces`, { headers: BROWSER });
    const found = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(await response.text()).toContain(`<script nonce="${found}">late()</script>`);
  });

  it('takes the object-mode string streams routes send (Readable.from) as text', async () => {
    const { url } = await boot({}, (app) => {
      app.get('/generated', (_request, reply) => {
        async function* lines() {
          yield 'one\n';
          yield 'two\n';
          yield Buffer.from('three\n');
        }
        return reply.type('text/plain').send(Readable.from(lines()));
      });
    });
    const response = await fetch(`${url}/generated`, { headers: BROWSER });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('one\ntwo\nthree\n');
  });

  it('answers HEAD requests without a body but with the headers and the length', async () => {
    const { url } = await boot();
    const get = await fetch(`${url}/users/1`, { headers: BROWSER });
    const length = (await get.text()).length;
    const head = await fetch(`${url}/users/1`, { method: 'HEAD', headers: BROWSER });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toContain('application/json');
    expect(head.headers.get('x-content-type-options')).toBe('nosniff');
    expect(head.headers.get('content-length')).toBe(String(length));
    expect(await head.text()).toBe('');
  });

  it('stops the app stream when the client leaves', async () => {
    let closed: () => void = () => undefined;
    const sawClose = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const { url } = await boot({}, (app) => {
      app.get('/forever', (_request, reply) => {
        const stream = new PassThrough();
        stream.write('data: hi\n\n');
        stream.on('close', closed);
        return reply.header('content-type', 'text/event-stream').send(stream);
      });
    });
    const abort = new AbortController();
    const response = await fetch(`${url}/forever`, { headers: BROWSER, signal: abort.signal });
    await response.body!.getReader().read();
    abort.abort();
    await sawClose;
  });

  it('streams a file with @fastify/static with asset headers, outside the stages, and answers conditional requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypdriv-fastify-static-'));
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    const { url } = await boot({}, async (app) => {
      await app.register(fastifyStatic, { root: dir, prefix: '/assets/', immutable: true, maxAge: '1y' });
    });
    const asset = await fetch(`${url}/assets/app.js`, { headers: SUBRESOURCE });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log(1)');
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    // No stages ran: no request id, no CSP.
    expect(asset.headers.get('x-request-id')).toBeNull();
    expect(asset.headers.get('content-security-policy')).toBeNull();
    const big = await fetch(`${url}/assets/big.bin`, { headers: SUBRESOURCE });
    expect(new Uint8Array(await big.arrayBuffer()).length).toBe(3 * 1024 * 1024);
    const etag = big.headers.get('etag');
    expect(etag).toBeTruthy();
    const conditional = await fetch(`${url}/assets/big.bin`, {
      headers: { ...SUBRESOURCE, 'if-none-match': etag!, 'cache-control': 'max-age=0' },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
  });

  it('can leave static files alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypdriv-fastify-static-'));
    writeFileSync(join(dir, 'app.css'), 'a{}');
    const { url } = await boot({ staticHeaders: false }, async (app) => {
      await app.register(fastifyStatic, { root: dir });
    });
    const css = await fetch(`${url}/app.css`, { headers: BROWSER });
    expect(css.status).toBe(200);
    expect(css.headers.get('x-content-type-options')).toBeNull();
  });

  it('honours a custom skip rule', async () => {
    const { url } = await boot({ skip: (u) => u.pathname === '/count' });
    const skipped = await fetch(`${url}/count`, { headers: BROWSER });
    expect(skipped.status).toBe(200);
    expect(skipped.headers.get('x-request-id')).toBeNull();
    const other = await fetch(`${url}/api/time`, { headers: BROWSER });
    expect(other.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('request bodies', () => {
  it('lets the content-type parsers read JSON and text', async () => {
    const { url } = await boot({}, (app) => {
      app.post('/json', async (request) => ({
        got: request.body,
        length: request.headers['content-length'],
      }));
      app.post('/text', async (request) => ({ got: request.body }));
    });
    const json = await fetch(`${url}/json`, {
      method: 'POST',
      headers: { ...BROWSER, 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(await json.json()).toEqual({ got: { hello: 'world' }, length: '17' });
    const text = await fetch(`${url}/text`, {
      method: 'POST',
      headers: { ...BROWSER, 'content-type': 'text/plain' },
      body: 'plain words',
    });
    expect(await text.json()).toEqual({ got: 'plain words' });
  });

  it('streams a large upload to a stream parser without the pipeline taking it', async () => {
    const { url } = await boot({}, (app) => {
      app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
        const hash = createHash('sha256');
        let length = 0;
        payload.on('data', (chunk: Buffer) => {
          hash.update(chunk);
          length += chunk.length;
        });
        payload.on('end', () => done(null, { length, sha: hash.digest('hex') }));
        payload.on('error', done);
      });
      app.post('/upload', async (request) => request.body);
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
      headers: { ...BROWSER, 'content-type': 'application/octet-stream' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(await response.json()).toEqual({ length: 24 * 256 * 1024, sha: expected.digest('hex') });
  });

  it('checks the CSRF form field without taking the form from the parser', async () => {
    const { url } = await boot(
      { config: { site: { name: 'fastify-test' }, security: { csrf: { match: '/form/**' } } } },
      (app) => {
        app.addContentTypeParser(
          'application/x-www-form-urlencoded',
          { parseAs: 'string' },
          (_request, body, done) => {
            done(null, Object.fromEntries(new URLSearchParams(body as string)));
          },
        );
        app.post('/form/save', async (request) => ({ got: request.body }));
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
    // The stage read the form; the parser still gets every field.
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
      config: { site: { name: 'fastify-test' }, observe: { vitals: { sink: 'log' } } },
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

describe('documents rendered with a nonce', () => {
  it('are never answered 304 from validators the app computed: the cached body would carry an earlier nonce', async () => {
    // @fastify/etag hashes the app's payload, so it is registered before Hypdriv (whose onSend then rewrites it).
    const app = Fastify({ forceCloseConnections: true });
    await app.register(fastifyEtag);
    await app.register(hypdriv, options());
    // The same bytes on every request: the ETag matches, and the pipeline injects a different nonce each time.
    app.get('/constant', async (_request, reply) =>
      reply.type('text/html').send('<!doctype html><html><body><script>x()</script></body></html>'),
    );
    app.get('/data', async () => ({ ok: true }));
    const url = await listen(app);
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
    // JSON keeps its conditional requests.
    const json = await fetch(`${url}/data`, { headers: SUBRESOURCE });
    const jsonEtag = json.headers.get('etag');
    expect(jsonEtag).toBeTruthy();
    await json.text();
    const cached = await fetch(`${url}/data`, {
      headers: {
        ...SUBRESOURCE,
        accept: 'application/json',
        'if-none-match': jsonEtag!,
        'cache-control': 'max-age=0',
      },
    });
    expect(cached.status).toBe(304);
  });
});

describe('route discovery', () => {
  it('gives every kind of route its id: prefixes, nested plugins, routes registered before the plugin and the routes option', async () => {
    const app = Fastify({ forceCloseConnections: true });
    const idOf = async () => ({ route: hyp()?.route });
    // Registered before the plugin: read back from the router's tree.
    app.get('/early/:slug', idOf);
    app.get('/early-files/*', idOf);
    await app.register(hypdriv, options({ routes: ['/legacy/:id'] }));
    app.get('/users/:id', idOf);
    app.get('/docs/:page?', idOf);
    app.get('/range/:from-:to', idOf);
    app.get('/static/*', idOf);
    app.get('/legacy/:id(^\\d+)', idOf);
    await app.register(
      async (api) => {
        api.get('/health', idOf);
        await api.register(async (admin) => void admin.get('/stats/:range', idOf), { prefix: '/admin' });
      },
      { prefix: '/api/v1' },
    );
    const url = await listen(app);
    const routeOf = async (path: string) =>
      ((await (await fetch(`${url}${path}`, { headers: BROWSER })).json()) as { route: string }).route;
    expect(await routeOf('/early/hello')).toBe('endpoint:/early/[slug]');
    expect(await routeOf('/early-files/a/b')).toBe('endpoint:/early-files/[...splat]');
    expect(await routeOf('/users/7')).toBe('endpoint:/users/[id]');
    expect(await routeOf('/docs')).toBe('endpoint:/docs');
    expect(await routeOf('/docs/intro')).toBe('endpoint:/docs/[page]');
    expect(await routeOf('/range/2020-2024')).toBe('endpoint:/range/[from]');
    expect(await routeOf('/static/css/site.css/x')).toBe('endpoint:/static/[...splat]');
    expect(await routeOf('/legacy/12')).toBe('endpoint:/legacy/[id]');
    expect(await routeOf('/api/v1/health')).toBe('endpoint:/api/v1/health');
    expect(await routeOf('/api/v1/admin/stats/week')).toBe('endpoint:/api/v1/admin/stats/[range]');
    expect(app.hypdriv.manifest().framework).toMatchObject({ name: 'fastify' });
  });

  it('applies route-keyed policy to the discovered routes', async () => {
    const { url } = await boot({
      config: {
        site: { name: 'fastify-test' },
        security: { rateLimit: [{ id: 'users', match: '/users/*', limit: 1, window: '1m', key: ['ip'] }] },
      },
    });
    const statuses: number[] = [];
    for (const id of ['1', '2']) {
      const response = await fetch(`${url}/users/${id}`, { headers: BROWSER });
      statuses.push(response.status);
      await response.text();
    }
    expect(statuses).toEqual([200, 429]);
  });
});

describe('encapsulation', () => {
  it('covers routes in child contexts, with and without a prefix, whenever they are registered', async () => {
    const { url } = await boot({}, async (app) => {
      await app.register(async (child) => void child.get('/child', async () => 'child'), { prefix: '/c' });
      await app.register(async (child) => void child.get('/bare', async () => 'bare'));
    });
    for (const path of ['/c/child', '/bare']) {
      const response = await fetch(`${url}${path}`, { headers: BROWSER });
      expect(response.headers.get('x-request-id'), path).toBeTruthy();
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });

  it('wraps a route registered before the plugin as well', async () => {
    const app = Fastify({ forceCloseConnections: true });
    app.get('/first', async () => 'first');
    await app.register(hypdriv, options());
    const url = await listen(app);
    const response = await fetch(`${url}/first`, { headers: BROWSER });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('runs the pipeline for a reply an earlier-registered hook already sent only through onSend', async () => {
    const app = Fastify({ forceCloseConnections: true });
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/guarded') return reply.code(401).send('no');
    });
    await app.register(hypdriv, options());
    app.get('/guarded', async () => 'never');
    const url = await listen(app);
    const response = await fetch(`${url}/guarded`, { headers: BROWSER });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('no');
  });
});

describe('hijacked replies', () => {
  it('lets a route write to the socket itself and keeps serving other requests', async () => {
    const { url } = await boot({}, (app) => {
      app.get('/raw', (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/plain', 'x-raw': 'yes' });
        reply.raw.end('written by the route');
      });
    });
    const raw = await fetch(`${url}/raw`, { headers: BROWSER });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('x-raw')).toBe('yes');
    expect(await raw.text()).toBe('written by the route');
    const next = await fetch(`${url}/users/1`, { headers: BROWSER });
    expect(next.headers.get('x-request-id')).toBeTruthy();
  });

  it('streams server-sent events from a hijacked reply', async () => {
    const { url } = await boot({}, (app) => {
      app.get('/events', (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.raw.write('data: one\n\n');
        setTimeout(() => reply.raw.end('data: two\n\n'), 100);
      });
    });
    const response = await fetch(`${url}/events`, { headers: BROWSER });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: two\n\n');
  });
});

describe('ecosystem plugins', () => {
  it('compresses the finished response when @fastify/compress is registered after the plugin', async () => {
    const { app, url } = await boot({}, async (child) => {
      await child.register(fastifyCompress, { threshold: 0 });
    });
    expect(app.hypdriv.warnings).toEqual([]);
    const response = await fetch(`${url}/`, {
      headers: { ...BROWSER, 'accept-encoding': 'gzip' },
    });
    // fetch() already inflated the body: the nonce was injected before the bytes were compressed.
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const found = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(await response.text()).toContain(`<script nonce="${found}">late()</script>`);
  });

  it('never rewrites compressed bytes when @fastify/compress was registered first', async () => {
    const app = Fastify({ forceCloseConnections: true });
    await app.register(fastifyCompress, { threshold: 0 });
    await app.register(hypdriv, options());
    routes(app);
    expect(app.hypdriv.warnings).toEqual([expect.stringContaining('@fastify/compress is registered before')]);
    const url = await listen(app);
    const response = await fetch(`${url}/`, { headers: { ...BROWSER, 'accept-encoding': 'gzip' } });
    // fetch() inflates the body itself.
    const body = await response.text();
    expect(body).toContain('boot()');
    expect(body).not.toContain('\uFFFD');
  });

  it('works with @fastify/formbody: the form is parsed once, the CSRF field checked from a copy', async () => {
    const { url } = await boot(
      { config: { site: { name: 'fastify-test' }, security: { csrf: { match: '/form/**' } } } },
      async (app) => {
        await app.register(fastifyFormbody);
        app.post('/form/save', async (request) => ({ got: request.body }));
      },
    );
    const response = await fetch(`${url}/form/save`, {
      method: 'POST',
      headers: {
        ...BROWSER,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'hyp_csrf=token-1',
        'sec-fetch-site': 'cross-site',
      },
      body: 'x-csrf-token=token-1&name=Ada',
    });
    expect(await response.json()).toEqual({ got: { 'x-csrf-token': 'token-1', name: 'Ada' } });
  });

  it('serves websockets from @fastify/websocket and keeps serving HTTP', async () => {
    const { url } = await boot({}, async (app) => {
      await app.register(fastifyWebsocket);
      app.get('/ws', { websocket: true }, (socket) => {
        socket.on('message', (message: Buffer) => socket.send(`echo:${message.toString()}`));
      });
    });
    const socket = new WebSocket(`${url.replace('http', 'ws')}/ws`);
    const reply = await new Promise<string>((resolve, reject) => {
      socket.addEventListener('open', () => socket.send('hello'));
      socket.addEventListener('message', (event) => resolve(String(event.data)));
      socket.addEventListener('error', () => reject(new Error('websocket failed')));
    });
    expect(reply).toBe('echo:hello');
    socket.close();
    const page = await fetch(`${url}/users/1`, { headers: BROWSER });
    expect(page.headers.get('x-request-id')).toBeTruthy();
  });

  it('applies rate limits to the websocket handshake', async () => {
    const { app, url } = await boot(
      {
        config: {
          site: { name: 'fastify-test' },
          security: { rateLimit: [{ id: 'ws', match: '/ws', limit: 1, window: '1m', key: ['ip'] }] },
        },
      },
      async (app) => {
        await app.register(fastifyWebsocket);
        app.get('/ws', { websocket: true }, (socket) => socket.send('hi'));
      },
    );
    const target = new URL(url);
    const handshake = () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({
          host: target.hostname,
          port: target.port,
          path: '/ws',
          headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          },
        });
        req.on('upgrade', (res, socket) => {
          socket.destroy();
          resolve({ status: res.statusCode ?? 0, body: '' });
        });
        req.on('response', (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            // The server answered on the upgrade socket and keeps it open: leave, so the app can close.
            req.destroy();
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          });
        });
        req.on('error', reject);
        req.end();
      });
    const first = new WebSocket(`${url.replace('http', 'ws')}/ws`);
    await new Promise<void>((resolve, reject) => {
      first.addEventListener('message', () => resolve());
      first.addEventListener('error', () => reject(new Error('websocket failed')));
    });
    first.close();
    const limited = await handshake();
    expect(limited.status).toBe(429);
    expect(limited.body).toContain('rate_limited');
    // @fastify/websocket keeps the upgrade socket of a refused handshake open (with or without Hypdriv), and
    // `close()` waits for it: close without waiting.
    apps.pop();
    void app.close();
  });
});

describe('platform facts', () => {
  it('upgrades plain HTTP before anything answers, internal routes and assets included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypdriv-fastify-https-'));
    writeFileSync(join(dir, 'logo.png'), 'png');
    const { url } = await boot(
      { config: { site: { name: 'fastify-test', origin: 'https://shop.example' } } },
      async (app) => {
        await app.register(fastifyStatic, { root: dir });
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
        site: { name: 'fastify-test' },
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

  it('keys by the forwarded address on Vercel, where the socket peer is the platform proxy', async () => {
    const limited = {
      site: { name: 'fastify-test' },
      security: {
        rateLimit: [{ id: 'count', match: '/count', limit: 1, window: '1m', key: ['ip' as const] }],
      },
    };
    const call = async (url: string, forwarded: string) => {
      const response = await fetch(`${url}/count`, { headers: { ...BROWSER, 'x-forwarded-for': forwarded } });
      await response.text();
      return response.status;
    };
    const plain = await boot({ config: limited });
    expect(await call(plain.url, '198.51.100.1')).toBe(200);
    expect(await call(plain.url, '198.51.100.2')).toBe(429);
    vi.stubEnv('VERCEL', '1');
    try {
      const vercel = await boot({ config: limited });
      expect(await call(vercel.url, '198.51.100.1')).toBe(200);
      expect(await call(vercel.url, '198.51.100.2')).toBe(200);
      expect(await call(vercel.url, '198.51.100.1')).toBe(429);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps a keep-alive connection usable across captured responses', async () => {
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

describe('webRoute', () => {
  it('mounts a Web-standard handler and streams its response', async () => {
    const { url } = await boot({}, (app) => {
      app.post(
        '/web',
        webRoute(async (request) => {
          const body = await request.text();
          return new Response(Readable.toWeb(Readable.from([`you sent: `, body])) as never, {
            status: 201,
            headers: { 'x-web': request.method, 'set-cookie': 'w=1' },
          });
        }),
      );
    });
    const response = await fetch(`${url}/web`, {
      method: 'POST',
      headers: { ...BROWSER, 'content-type': 'text/plain' },
      body: 'ping',
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-web')).toBe('POST');
    expect(response.headers.getSetCookie()[0]).toContain('w=1');
    expect(await response.text()).toBe('you sent: ping');
  });

  it('re-encodes parsed objects for the Web request', async () => {
    const { url } = await boot({}, (app) => {
      app.post(
        '/web-json',
        webRoute(async (request) => Response.json(await request.json())),
      );
      app.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_request, body, done) => {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        },
      );
      app.post(
        '/web-form',
        webRoute(async (request) => Response.json(Object.fromEntries(await request.formData()))),
      );
    });
    const json = await fetch(`${url}/web-json`, {
      method: 'POST',
      headers: { ...BROWSER, 'content-type': 'application/json' },
      body: JSON.stringify({ a: [1, 2] }),
    });
    expect(await json.json()).toEqual({ a: [1, 2] });
    const form = await fetch(`${url}/web-form`, {
      method: 'POST',
      headers: { ...BROWSER, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'x=1&y=two',
    });
    expect(await form.json()).toEqual({ x: '1', y: 'two' });
  });

  it('serves GET handlers and passes failures to Fastify', async () => {
    const { url } = await boot({}, (app) => {
      app.get(
        '/web-get',
        webRoute((request) => new Response(new URL(request.url).pathname)),
      );
      app.get(
        '/web-fail',
        webRoute(() => {
          throw new Error('nope');
        }),
      );
    });
    expect(await (await fetch(`${url}/web-get`, { headers: BROWSER })).text()).toBe('/web-get');
    expect((await fetch(`${url}/web-fail`, { headers: BROWSER })).status).toBe(500);
  });

  it('runs Hypdriv jobs behind the cron secret', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret');
    vi.stubEnv('HYPDRIV_INTERNAL_SECRET', 'internal-secret');
    try {
      const { url } = await boot({}, (app) => {
        app.post('/jobs/ping', webRoute(jobHandler({}, async ({ job, payload }) => ({ job, payload }))));
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
});

describe('failures', () => {
  it("forwards a failure that happens before the route to Fastify's error handler", async () => {
    const app = Fastify({ forceCloseConnections: true });
    await app.register(
      hypdriv,
      options({
        skip: () => {
          throw new Error('skip failed');
        },
      }),
    );
    app.setErrorHandler((error, _request, reply) => {
      void reply.code(503).send(`handled: ${(error as Error).message}`);
    });
    app.get('/', async () => 'never');
    const url = await listen(app);
    const response = await fetch(`${url}/`, { headers: BROWSER });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('handled: skip failed');
  });

  it('keeps serving with generic behaviour when the manifest cannot be loaded', async () => {
    const { url } = await boot({ manifest: () => Promise.reject(new Error('manifest failed')) });
    const response = await fetch(`${url}/users/1`, { headers: BROWSER });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('ends the connection when the stream fails after it started', async () => {
    const { url } = await boot({}, (app) => {
      app.get('/partial', (_request, reply) => {
        const stream = new PassThrough();
        stream.write('part');
        setTimeout(() => stream.destroy(new Error('late failure')), 20);
        return reply.header('content-type', 'text/plain').send(stream);
      });
    });
    const response = await fetch(`${url}/partial`, { headers: BROWSER });
    await expect(response.text()).rejects.toThrow();
  });
});

describe('stale-while-revalidate', () => {
  // Nonce documents are never shared-cached, so the cached page runs without a CSP.
  const swrConfig = {
    site: { name: 'fastify-test' },
    security: { csp: false as const },
    cache: { edge: { policies: [{ match: '/page', ttl: 10, swr: 60 }] } },
  };

  async function harness() {
    let renders = 0;
    const app = Fastify({ forceCloseConnections: true });
    await app.register(hypdriv, options({ config: swrConfig }));
    app.get('/page', async (_request, reply) => {
      renders += 1;
      return reply.type('text/html').send(`<!doctype html><html><body>render ${renders}</body></html>`);
    });
    const url = await listen(app);
    return { url, renders: () => renders };
  }

  const page = async (url: string) => {
    const response = await fetch(`${url}/page`, { headers: BROWSER });
    return { status: response.headers.get('x-hypdriv-cache'), body: await response.text() };
  };

  it('refreshes a stale page in the background through the app', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = await harness();
      expect(await page(h.url)).toMatchObject({ status: 'MISS', body: expect.stringContaining('render 1') });
      await vi.waitFor(async () => expect((await page(h.url)).status).toBe('HIT'));
      vi.setSystemTime(Date.now() + 15_000);
      const stale = await page(h.url);
      expect(stale.status).toBe('STALE');
      expect(stale.body).toContain('render 1');
      await vi.waitFor(() => expect(h.renders()).toBe(2));
      await vi.waitFor(async () => {
        const fresh = await page(h.url);
        expect(fresh.status).toBe('HIT');
        expect(fresh.body).toContain('render 2');
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
