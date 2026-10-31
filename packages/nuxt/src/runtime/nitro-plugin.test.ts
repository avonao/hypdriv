import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hyp } from '@hypdriv/runtime';
import {
  createApp,
  createRouter,
  defineEventHandler,
  type H3Event,
  readBody,
  send,
  setResponseHeader,
  toNodeListener,
} from 'h3';
import { afterEach, describe, expect, it } from 'vitest';
import { routeRules } from './__fixtures__/virtual';
import { FACTS_KEY, type HypEventContext } from './facts';
import type { H3ErrorLike } from './hook';
import hypdrivNitroPlugin from './nitro-plugin';

const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const servers: Server[] = [];
afterEach(async () => {
  for (const key of Object.keys(routeRules)) delete routeRules[key];
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A Nitro app (h3 app + error handler) with the Hypdriv plugin applied, served over HTTP. */
async function nitro() {
  const facts: Record<string, HypEventContext | undefined> = {};
  const errors: H3ErrorLike[] = [];
  const app = createApp({
    onError: (error: H3ErrorLike, event: H3Event) => {
      errors.push(error);
      setResponseHeader(event, 'content-type', 'application/json');
      return send(event, JSON.stringify({ statusCode: error.statusCode, requestId: hyp()?.requestId }));
    },
  });
  const router = createRouter();
  for (const path of ['/page', '/cached'])
    router.use(
      path,
      defineEventHandler((event) => {
        facts[path] = event.context[FACTS_KEY] as HypEventContext;
        setResponseHeader(event, 'content-type', 'text/html');
        return '<!DOCTYPE html><html><head></head><body><script>1</script></body></html>';
      }),
    );
  router.post(
    '/api/echo',
    defineEventHandler(async (event) => readBody(event)),
  );
  router.get(
    '/api/boom',
    defineEventHandler(() => {
      throw new Error('internal detail');
    }),
  );
  app.use(router);
  hypdrivNitroPlugin({ h3App: app, hooks: {}, captureError: () => undefined } as never);
  const server = createServer(toNodeListener(app));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'user-agent': BROWSER, accept: 'text/html', 'accept-language': 'en-US', ...init.headers },
    });
  return { get, facts, errors };
}

describe('the Hypdriv Nitro plugin', () => {
  it('wraps the h3 app with the build’s config, manifest and options', async () => {
    const { get, facts } = await nitro();
    const response = await get('/page');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe(facts['/page']?.requestId);
    expect(facts['/page']?.nonce).toBeTruthy();
    expect(response.headers.get('content-security-policy')).toContain(`'nonce-${facts['/page']?.nonce}'`);
    const health = (await (await get('/_hypdriv/health')).json()) as { service: string; framework: string };
    expect(health.service).toBe('nuxt-plugin-test');
    expect(health.framework).toContain('Nuxt 4.6.3');
  });

  it('does not hand the nonce to renders Nitro caches', async () => {
    routeRules['/cached'] = { cache: { swr: true, maxAge: 60 } };
    const { get, facts } = await nitro();
    const response = await get('/cached');
    expect(response.status).toBe(200);
    expect(facts['/cached']?.requestId).toBeTruthy();
    expect(facts['/cached']?.nonce).toBeUndefined();
  });

  it('reads request bodies through h3 so the route still can', async () => {
    const { get } = await nitro();
    const response = await get('/api/echo', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    expect(await response.json()).toEqual({ hello: 'world' });
  });

  it('normalises thrown errors like h3 before Nitro’s error handler runs', async () => {
    const { get, errors } = await nitro();
    const response = await get('/api/boom', { headers: { accept: 'application/json' } });
    const body = (await response.json()) as { statusCode: number; requestId: string };
    expect(response.status).toBe(500);
    expect(body.statusCode).toBe(500);
    expect(body.requestId).toBe(response.headers.get('x-request-id'));
    expect(errors[0]?.unhandled).toBe(true);
    expect(errors[0]?.statusCode).toBe(500);
  });
});
