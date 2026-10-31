import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createContext,
  defineStage,
  emptyManifest,
  HEADER,
  type HypManifest,
  loadConfig,
  routePatternToRegex,
  runWithContext,
} from '@hypdriv/core';
import { createHandler, ensureContextStore, hyp, nonce } from '@hypdriv/runtime';
import {
  type App,
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  type H3Event,
  isError,
  readBody,
  readRawBody,
  send,
  sendRedirect,
  sendStream,
  setCookie,
  setResponseHeader,
  setResponseStatus,
  toNodeListener,
} from 'h3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FACTS_KEY, type HypEventContext } from './facts';
import {
  createNitroHandler,
  factsFor,
  type H3ErrorLike,
  installNitroHook,
  type NitroAppLike,
  type NitroHookOptions,
  nuxtSkip,
} from './hook';
import type { H3EventLike } from './request';

const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const route = (pathname: string, kind: 'page' | 'endpoint', classification: 'dynamic' | 'route') => ({
  id: `${kind}:${pathname}`,
  pathname,
  regex: routePatternToRegex(pathname),
  kind,
  classification,
  runtime: 'nodejs' as const,
  dynamic: false,
  assets: { js: [], css: [], fonts: [] },
});

const manifest: HypManifest = emptyManifest({
  buildId: 'nuxt-test',
  framework: { name: 'nuxt', version: '4.6.3', bundler: 'vite', bundlerVersion: '8.3.5' },
  routes: [route('/page', 'page', 'dynamic'), route('/api/echo', 'endpoint', 'route')],
  staticFiles: { count: 1, immutablePrefixes: ['/_nuxt/'] },
});

const page = (body: string) =>
  `<!DOCTYPE html><html><head><script type="importmap">{"imports":{}}</script></head><body>${body}<script>window.__NUXT__={}</script></body></html>`;

interface Harness {
  app: App;
  base: string;
  seen: { facts?: HypEventContext; requestId?: string; nonce?: string; pageCalls: number };
  errors: H3ErrorLike[];
  captured: Error[];
  release: () => void;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

beforeAll(async () => {
  await ensureContextStore();
});

const normalizeError: NitroHookOptions['normalizeError'] = (thrown, event) => {
  const error = createError(thrown as Error) as H3ErrorLike;
  if (!isError(thrown)) error.unhandled = true;
  setResponseStatus(event as unknown as H3Event, error.statusCode, error.statusMessage);
  return error;
};

async function harness(
  extra: { stages?: Parameters<typeof createHandler>[0]['stages']; cached?: boolean } = {},
): Promise<Harness> {
  const seen: Harness['seen'] = { pageCalls: 0 };
  const errors: H3ErrorLike[] = [];
  const captured: Error[] = [];
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  // Shaped like Nitro's h3 app: Nuxt's error handler renders an HTML page (or JSON for API requests).
  const app = createApp({
    onError: async (error: H3ErrorLike, event: H3Event) => {
      errors.push(error);
      const requestId = hyp()?.requestId ?? 'none';
      if (event.path.startsWith('/api/')) {
        setResponseHeader(event, 'content-type', 'application/json');
        return send(event, JSON.stringify({ statusCode: error.statusCode, unhandled: !!error.unhandled }));
      }
      setResponseHeader(event, 'content-type', 'text/html;charset=utf-8');
      return send(event, page(`<p>error ${error.statusCode} for ${requestId}</p>`));
    },
  });
  const router = createRouter();
  // Nitro registers page and file routes for every method (HEAD included).
  router.use(
    '/page',
    defineEventHandler((event) => {
      seen.pageCalls++;
      seen.facts = event.context[FACTS_KEY] as HypEventContext;
      seen.requestId = hyp()?.requestId;
      seen.nonce = nonce();
      setResponseHeader(event, 'content-type', 'text/html;charset=utf-8');
      return page('<h1>page</h1>');
    }),
  );
  router.post(
    '/api/echo',
    defineEventHandler(async (event) => ({ body: await readBody(event), requestId: hyp()?.requestId })),
  );
  router.get(
    '/api/cookies',
    defineEventHandler((event) => {
      setCookie(event, 'a', '1');
      setCookie(event, 'b', '2');
      return { ok: true };
    }),
  );
  router.get(
    '/api/stream',
    defineEventHandler((event) => {
      setResponseHeader(event, 'content-type', 'text/event-stream');
      const encoder = new TextEncoder();
      return sendStream(
        event,
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode('data: first\n\n'));
            await released;
            controller.enqueue(encoder.encode('data: second\n\n'));
            controller.close();
          },
        }),
      );
    }),
  );
  router.get(
    '/boom',
    defineEventHandler(() => {
      throw new Error('secret detail');
    }),
  );
  router.get(
    '/api/boom',
    defineEventHandler(() => {
      throw new Error('secret detail');
    }),
  );
  router.get(
    '/redirect',
    defineEventHandler((event) => sendRedirect(event, '/page', 302)),
  );
  router.get(
    '/_nuxt/entry.js',
    defineEventHandler((event) => {
      setResponseHeader(event, 'content-type', 'text/javascript');
      setResponseHeader(event, 'cache-control', 'public, max-age=31536000, immutable');
      return 'console.log("entry")';
    }),
  );
  app.use(router);
  const nitroApp: NitroAppLike = {
    h3App: app as unknown as NitroAppLike['h3App'],
    captureError: (error) => {
      captured.push(error);
    },
  };
  const skip = nuxtSkip('/_nuxt/');
  installNitroHook(nitroApp, {
    handler: createHandler({
      config: {},
      manifest,
      host: 'nuxt',
      target: 'node',
      development: false,
      skip,
      ...(extra.stages ? { stages: extra.stages } : {}),
    }),
    skip,
    nonce: true,
    socketIp: true,
    readRawBody: async (event) => {
      const body = await readRawBody(event as unknown as H3Event, false);
      return body ? new Uint8Array(body) : undefined;
    },
    normalizeError,
    cachedRender: () => extra.cached === true,
  });
  const server = createServer(toNodeListener(app));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}`, seen, errors, captured, release };
}

const get = (base: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { 'user-agent': BROWSER, accept: 'text/html', 'accept-language': 'en-US', ...init.headers },
  });

describe('the Nitro hook over HTTP', () => {
  it('runs the pipeline around a rendered page and hands the request context to the app', async () => {
    const h = await harness();
    const response = await get(h.base, '/page');
    const body = await response.text();
    const requestId = response.headers.get('x-request-id');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(response.status).toBe(200);
    expect(requestId).toBeTruthy();
    expect(h.seen.requestId).toBe(requestId);
    expect(h.seen.facts?.requestId).toBe(requestId);
    expect(h.seen.facts?.runner).toBe('host');
    expect(h.seen.facts?.route).toBe('page:/page');
    expect(h.seen.nonce).toBeTruthy();
    expect(h.seen.facts?.nonce).toBe(h.seen.nonce);
    expect(csp).toContain(`'nonce-${h.seen.nonce}'`);
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    // Every inline script carries the nonce (portable injection on Node).
    expect(body).toContain(`<script type="importmap" nonce="${h.seen.nonce}">`);
    expect(body).toContain(`<script nonce="${h.seen.nonce}">window.__NUXT__={}</script>`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('server-timing')).toContain('total');
  });

  it('serves build assets straight from Nitro, without the pipeline', async () => {
    const h = await harness();
    const response = await get(h.base, '/_nuxt/entry.js');
    expect(await response.text()).toBe('console.log("entry")');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.has('x-request-id')).toBe(false);
  });

  it('short-circuits before rendering', async () => {
    const h = await harness({
      stages: (defaults) => [
        ...defaults,
        defineStage({
          name: 'gate',
          pre: (ctx) =>
            ctx.request.headers.has('x-test-block') ? new Response('blocked', { status: 451 }) : undefined,
        }),
      ],
    });
    const response = await get(h.base, '/page', { headers: { 'x-test-block': '1' } });
    expect(response.status).toBe(451);
    expect(await response.text()).toBe('blocked');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(h.seen.pageCalls).toBe(0);
  });

  it('answers /_hypdriv/health with the Nuxt build and the host runner', async () => {
    const h = await harness();
    const response = await get(h.base, '/_hypdriv/health');
    const health = (await response.json()) as { runner: string; framework: string; target: string };
    expect(health.runner).toBe('host');
    expect(health.target).toBe('node');
    expect(health.framework).toContain('Nuxt 4.6.3');
  });

  it('lets stages and the route read the same request body', async () => {
    let stageBody = '';
    const h = await harness({
      stages: (defaults) => [
        ...defaults,
        defineStage({
          name: 'read-body',
          async pre(ctx) {
            if (ctx.request.method === 'POST') stageBody = await ctx.request.clone().text();
          },
        }),
      ],
    });
    const response = await get(h.base, '/api/echo', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    const json = (await response.json()) as { body: unknown; requestId: string };
    expect(stageBody).toBe('{"a":1}');
    expect(json.body).toEqual({ a: 1 });
    expect(json.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('renders errors through the app error handler inside the pipeline', async () => {
    const h = await harness();
    const response = await get(h.base, '/nowhere');
    const body = await response.text();
    const requestId = response.headers.get('x-request-id');
    const csp = response.headers.get('content-security-policy') ?? '';
    const nonceValue = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(response.status).toBe(404);
    expect(requestId).toBeTruthy();
    expect(nonceValue).toBeTruthy();
    // The error page rendered inside the request context and got the nonce.
    expect(body).toContain(`error 404 for ${requestId}`);
    expect(body).toContain(`<script nonce="${nonceValue}">window.__NUXT__={}</script>`);
    expect(h.errors[0]?.statusCode).toBe(404);
  });

  it('normalises unhandled errors before the error handler sees them', async () => {
    const h = await harness();
    const response = await get(h.base, '/api/boom', { headers: { accept: 'application/json' } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ statusCode: 500, unhandled: true });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('streams response bodies through the pipeline', async () => {
    const h = await harness();
    const response = await get(h.base, '/api/stream', { headers: { accept: 'text/event-stream' } });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    const reader = response.body!.getReader();
    // The first event arrives while the application still holds the second one back.
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    h.release();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe('data: second\n\n');
  });

  it('keeps every set-cookie header', async () => {
    const h = await harness();
    const response = await get(h.base, '/api/cookies', { headers: { accept: 'application/json' } });
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('wraps responses the application sends itself (redirects)', async () => {
    const h = await harness();
    const response = await get(h.base, '/redirect');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/page');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('answers HEAD without a body', async () => {
    const h = await harness();
    const response = await get(h.base, '/page', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("'nonce-");
    expect(await response.text()).toBe('');
  });

  it('withholds the nonce from the app when Nitro caches the render', async () => {
    const h = await harness({ cached: true });
    const response = await get(h.base, '/page');
    const body = await response.text();
    const nonceValue = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(h.seen.facts?.requestId).toBe(response.headers.get('x-request-id'));
    expect(h.seen.facts?.nonce).toBeUndefined();
    // The pipeline still injects the current nonce into the response.
    expect(body).toContain(`<script nonce="${nonceValue}">window.__NUXT__={}</script>`);
  });
});

describe('createNitroHandler', () => {
  const stubEvent = (req: Partial<H3EventLike['node']['req']> = {}): H3EventLike => ({
    node: { req: { method: 'GET', url: '/page', headers: { host: 'example.com' }, ...req }, res: {} },
    context: {},
  });
  const options = (handler = vi.fn()): NitroHookOptions => ({
    handler: handler as unknown as NitroHookOptions['handler'],
    skip: nuxtSkip(),
    readRawBody: async () => undefined,
    normalizeError: (e) => e as H3ErrorLike,
  });

  it('passes straight through inside HypDriv’s Cloudflare Worker shell and exposes its facts', async () => {
    await ensureContextStore();
    const handler = vi.fn();
    const inner = vi.fn(async () => 'rendered');
    const wrapped = createNitroHandler(inner, { h3App: { handler: inner, options: {} } }, options(handler));
    const ctx = createContext({
      request: new Request('https://example.com/page'),
      config: loadConfig({}),
      runner: 'worker',
    });
    ctx.requestHeaders.set(HEADER.nonce, 'worker-nonce');
    const event = stubEvent();
    const result = await runWithContext(ctx, () => wrapped(event));
    expect(result).toBe('rendered');
    expect(handler).not.toHaveBeenCalled();
    const facts = event.context[FACTS_KEY] as HypEventContext;
    expect(facts.requestId).toBe(ctx.id);
    expect(facts.runner).toBe('worker');
    expect(facts.nonce).toBe('worker-nonce');
  });

  it('passes Nitro’s own in-memory sub-requests through', async () => {
    const handler = vi.fn();
    const inner = vi.fn(async () => 'internal');
    const wrapped = createNitroHandler(inner, { h3App: { handler: inner, options: {} } }, options(handler));
    const event = stubEvent({ __unenv__: undefined });
    expect(await wrapped(event)).toBe('internal');
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the pipeline for requests Nitro’s Cloudflare entry forwards (platform context present)', async () => {
    const handler = vi.fn(async () => new Response('ok'));
    const inner = vi.fn();
    const writes: unknown[] = [];
    const event = stubEvent({
      __unenv__: {
        waitUntil: () => undefined,
        _platform: { cf: { country: 'US' }, cloudflare: { env: { BINDING: 1 } } },
      },
    });
    event.node.res = {
      statusCode: 200,
      statusMessage: '',
      headersSent: false,
      writableEnded: false,
      socket: null,
      setHeader: (name: string, value: unknown) => writes.push([name, value]),
      removeHeader: () => undefined,
      getHeaderNames: () => [],
      write: () => true,
      end: (chunk?: unknown) => writes.push(['end', chunk]),
    };
    const wrapped = createNitroHandler(inner, { h3App: { handler: inner, options: {} } }, options(handler));
    await wrapped(event);
    expect(handler).toHaveBeenCalledOnce();
    const input = (
      handler.mock.calls[0] as unknown as [Request, { env: unknown; cf: unknown; waitUntil: unknown }]
    )[1];
    expect(input.env).toEqual({ BINDING: 1 });
    expect(input.cf).toEqual({ country: 'US' });
    expect(typeof input.waitUntil).toBe('function');
    expect(writes.at(-1)).toEqual(['end', new TextEncoder().encode('ok')]);
  });

  it('builds facts without the nonce when asked to', () => {
    const ctx = createContext({
      request: new Request('https://example.com/'),
      config: loadConfig({}),
      runner: 'host',
    });
    ctx.requestHeaders.set(HEADER.nonce, 'n');
    expect(factsFor(ctx, { nonce: true }).nonce).toBe('n');
    expect(factsFor(ctx, { nonce: false }).nonce).toBeUndefined();
  });

  it('skips build assets and media, not documents or payloads', () => {
    const skip = nuxtSkip('/_nuxt/');
    expect(skip(new URL('https://x/_nuxt/builds/latest.json'))).toBe(true);
    expect(skip(new URL('https://x/_nuxt/CHvUeY7B.js'))).toBe(true);
    expect(skip(new URL('https://x/favicon.ico'))).toBe(true);
    expect(skip(new URL('https://x/about'))).toBe(false);
    expect(skip(new URL('https://x/about/_payload.json'))).toBe(false);
    expect(skip(new URL('https://x/api/data.json'))).toBe(false);
    expect(nuxtSkip('/app/_build')(new URL('https://x/app/_build/a.js'))).toBe(true);
  });
});
