import { describe, expect, it, vi } from 'vitest';
import { ActionError } from './actions';
import { createRateLimiter } from './rate-limit/limiter';
import { createMemoryCounterStore } from './rate-limit/stores';
import { corsHeaders, defineRoute, etagMatches, parseQuery, weakEtag } from './route';
import type { StandardSchemaV1 } from './standard-schema';

function schema<T>(
  check: (value: unknown) => { value: T } | { issues: Array<{ message: string; path?: PropertyKey[] }> },
): StandardSchemaV1<unknown, T> {
  return { '~standard': { version: 1, vendor: 'test', validate: (v) => check(v) } };
}
const querySchema = schema<{ page: number; tag: string[] }>((v) => {
  const o = v as Record<string, unknown>;
  const page = Number(o.page ?? 1);
  if (Number.isNaN(page)) return { issues: [{ message: 'page must be a number', path: ['page'] }] };
  const tag = Array.isArray(o.tag) ? (o.tag as string[]) : o.tag ? [o.tag as string] : [];
  return { value: { page, tag } };
});
const bodySchema = schema<{ name: string }>((v) => {
  const o = v as Record<string, unknown> | undefined;
  return typeof o?.name === 'string'
    ? { value: { name: o.name } }
    : { issues: [{ message: 'name required', path: ['name'] }] };
});

describe('defineRoute', () => {
  it('parses query and body, serialises JSON, sets cache-control and ETag', async () => {
    const handler = defineRoute({
      method: ['GET', 'POST'],
      query: querySchema,
      body: bodySchema,
      cache: { maxAge: 60, swr: 600 },
      handler: async (ctx) => ({
        page: ctx.query.page,
        tags: ctx.query.tag,
        name: ctx.body?.name ?? null,
        id: ctx.params.id,
      }),
    });
    const get = await handler(new Request('https://app.test/api/items?page=2&tag=a&tag=b'), {
      params: Promise.resolve({ id: '42' }),
    });
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(get.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=600');
    const etag = get.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    expect(await get.json()).toEqual({ page: 2, tags: ['a', 'b'], name: null, id: '42' });

    const notModified = await handler(
      new Request('https://app.test/api/items?page=2&tag=a&tag=b', { headers: { 'if-none-match': etag } }),
      { params: { id: '42' } },
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('etag')).toBe(etag);
    expect(await notModified.text()).toBe('');

    const post = await handler(
      new Request('https://app.test/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      }),
    );
    expect(await post.json()).toMatchObject({ name: 'x', page: 1 });
    expect(post.headers.get('etag')).toBeNull();

    const form = await handler(
      new Request('https://app.test/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=form',
      }),
    );
    expect(await form.json()).toMatchObject({ name: 'form' });
  });

  it('returns problem+json for validation, bad JSON, 405, 401 and unexpected errors', async () => {
    const onError = vi.fn();
    const handler = defineRoute({
      method: 'POST',
      body: bodySchema,
      auth: (ctx) => (ctx.headers.get('authorization') ? { id: 'u' } : null),
      handler: async (ctx) => {
        if (ctx.body.name === 'boom') throw new Error('unexpected');
        if (ctx.body.name === 'gone') throw new ActionError('NOT_FOUND', 'No such thing');
        return { ok: true };
      },
      onError,
    });
    const json = (name: string, extra: Record<string, string> = {}) =>
      new Request('https://app.test/api/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extra },
        body: JSON.stringify({ name }),
      });

    const r405 = await handler(new Request('https://app.test/api/x'));
    expect(r405.status).toBe(405);
    expect(r405.headers.get('allow')).toBe('POST');
    expect(r405.headers.get('content-type')).toContain('application/problem+json');

    const r400 = await handler(
      new Request('https://app.test/api/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(r400.status).toBe(400);
    expect(await r400.json()).toMatchObject({
      status: 400,
      title: 'VALIDATION',
      detail: 'name required',
      code: 'VALIDATION',
      errors: { name: ['name required'] },
    });

    const invalid = await handler(
      new Request('https://app.test/api/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{nope',
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ detail: 'Invalid JSON body' });

    expect((await handler(json('x'))).status).toBe(401);
    expect((await handler(json('gone', { authorization: 'b' }))).status).toBe(404);
    const r500 = await handler(json('boom', { authorization: 'b' }));
    expect(r500.status).toBe(500);
    expect(await r500.json()).toMatchObject({ title: 'INTERNAL', detail: 'Something went wrong' });
    expect(onError).toHaveBeenCalledOnce();
    expect(r500.headers.get('cache-control')).toBe('no-store');
  });

  it('handles CORS preflight and actual requests', async () => {
    const handler = defineRoute({
      cors: {
        origins: ['https://web.test', 'https://*.preview.test'],
        credentials: true,
        headers: ['content-type', 'x-token'],
      },
      handler: async () => ({ hi: 1 }),
    });
    const preflight = await handler(
      new Request('https://app.test/api/x', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://web.test',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-token',
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://web.test');
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type, x-token');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('access-control-max-age')).toBe('600');

    const actual = await handler(
      new Request('https://app.test/api/x', { headers: { origin: 'https://a.preview.test' } }),
    );
    expect(actual.headers.get('access-control-allow-origin')).toBe('https://a.preview.test');
    expect(actual.headers.get('vary')).toBe('Origin');
    const denied = await handler(
      new Request('https://app.test/api/x', { headers: { origin: 'https://evil.test' } }),
    );
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(corsHeaders({ origins: ['*'] }, 'https://any.test', null)['Access-Control-Allow-Origin']).toBe(
      '*',
    );
  });

  it('passes Response results through, returns 204 for empty results, and rate limits', async () => {
    const limiter = createRateLimiter({ store: createMemoryCounterStore() });
    const handler = defineRoute({
      name: 'rl',
      rateLimit: { limit: 1, window: 60, algorithm: 'fixed-window' },
      limiter,
      handler: async (ctx) =>
        ctx.url.searchParams.has('raw')
          ? new Response('raw', { status: 201 })
          : ctx.url.searchParams.has('empty')
            ? undefined
            : { a: 1 },
    });
    const raw = await handler(
      new Request('https://app.test/api/x?raw', { headers: { 'cf-connecting-ip': '1.1.1.1' } }),
    );
    expect(raw.status).toBe(201);
    expect(await raw.text()).toBe('raw');
    expect(raw.headers.get('ratelimit')).toContain('"route:rl";r=0');
    const limited = await handler(
      new Request('https://app.test/api/x', { headers: { 'cf-connecting-ip': '1.1.1.1' } }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    const empty = await handler(
      new Request('https://app.test/api/x?empty', { headers: { 'cf-connecting-ip': '2.2.2.2' } }),
    );
    expect(empty.status).toBe(204);
  });

  it('parseQuery treats __proto__ as an ordinary key', () => {
    const query = parseQuery(new URLSearchParams('__proto__=a&__proto__=b&x=1'));
    expect(Object.getPrototypeOf(query)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(query, '__proto__')?.value).toEqual(['a', 'b']);
    expect(query.x).toBe('1');
  });

  it('helpers: parseQuery, weakEtag, etagMatches', async () => {
    expect(parseQuery(new URLSearchParams('a=1&a=2&b=x'))).toEqual({ a: ['1', '2'], b: 'x' });
    const etag = await weakEtag('{"a":1}');
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(`"other", ${etag.slice(2)}`, etag)).toBe(true);
    expect(etagMatches('*', etag)).toBe(true);
    expect(etagMatches('"nope"', etag)).toBe(false);
    expect(etagMatches(null, etag)).toBe(false);
  });
});
