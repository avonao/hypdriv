import { defineStage, resolveConfig, type Stage, stateKey } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import {
  collectSetCookies,
  createTestContext,
  currentTestEnv,
  expectHeaders,
  isResolvedConfig,
  parseSetCookie,
  requestWithCf,
  responseJson,
  responseText,
  runStage,
  runStages,
  withEnv,
} from './harness';

const SEEN = stateKey<string[]>('seen');

const tagging: Stage = defineStage({
  name: 'tagging',
  pre(ctx) {
    ctx.state.set(SEEN, ['pre']);
    ctx.requestHeaders.set('x-tag', 'pre');
    ctx.responseHeaders.set('x-res', 'from-stage');
  },
  post(ctx, response) {
    ctx.state.get(SEEN)?.push('post');
    const headers = new Headers(response.headers);
    headers.set('x-post', '1');
    return new Response(response.body, { status: response.status, headers });
  },
});

describe('createTestContext', () => {
  it('builds a context with defaults and attaches cf to the request', () => {
    const ctx = createTestContext({
      url: 'https://shop.example.com/pricing?a=1',
      method: 'POST',
      headers: { cookie: 'hyp_uid=abc', 'x-forwarded-for': '1.1.1.1' },
      body: 'payload',
      cf: { country: 'US', colo: 'IAD' },
      env: { HYPDRIV_FLAGS: '{}' },
      config: { site: { name: 'shop' } },
      development: true,
      runner: 'proxy',
      ip: '1.1.1.1',
      id: 'req-1',
    });
    expect(ctx.url.pathname).toBe('/pricing');
    expect(ctx.request.method).toBe('POST');
    expect((ctx.request as Request & { cf?: unknown }).cf).toEqual({ country: 'US', colo: 'IAD' });
    expect(ctx.cf?.country).toBe('US');
    expect(ctx.env).toEqual({ HYPDRIV_FLAGS: '{}' });
    expect(ctx.config.site.name).toBe('shop');
    expect(ctx.development).toBe(true);
    expect(ctx.runner).toBe('proxy');
    expect(ctx.ip).toBe('1.1.1.1');
    expect(ctx.id).toBe('req-1');
    expect(ctx.manifest.buildId).toBe('development');
    expect(ctx.route).toBeNull();
    const plain = createTestContext();
    expect(plain.url.href).toBe('https://example.com/');
    expect(plain.runner).toBe('test');
  });

  it('accepts an already resolved config', () => {
    const resolved = resolveConfig({ site: { name: 'resolved' } });
    expect(isResolvedConfig(resolved)).toBe(true);
    expect(isResolvedConfig({ site: { name: 'raw' } })).toBe(false);
    expect(isResolvedConfig(undefined)).toBe(false);
    expect(createTestContext({ config: resolved }).config).toBe(resolved);
  });

  it('requestWithCf exposes cf as an enumerable property', () => {
    const request = requestWithCf('https://x.test/', { headers: { a: 'b' } }, { country: 'DE' });
    expect(request.cf).toEqual({ country: 'DE' });
    expect(request.headers.get('a')).toBe('b');
  });
});

describe('runStage', () => {
  it('runs pre, next and post with forwarded headers and merged response headers', async () => {
    const ctx = createTestContext();
    const result = await runStage(tagging, ctx, (req) => new Response(`tag=${req.headers.get('x-tag')}`));
    expect(result.shortCircuited).toBe(false);
    expect(result.nextCalled).toBe(true);
    expect(result.forwarded?.headers.get('x-tag')).toBe('pre');
    expect(await responseText(result.response)).toBe('tag=pre');
    expect(result.response.headers.get('x-post')).toBe('1');
    expect(result.response.headers.get('x-res')).toBe('from-stage');
    expect(ctx.state.get(SEEN)).toEqual(['pre', 'post']);
    expect(result.timings.map((t) => t.name)).toEqual(['tagging', 'next', 'tagging.post']);
  });

  it('reports short circuits and uses the default next handler', async () => {
    const guard: Stage = defineStage({ name: 'guard', pre: () => new Response('nope', { status: 403 }) });
    const result = await runStage(guard, createTestContext());
    expect(result.shortCircuited).toBe(true);
    expect(result.nextCalled).toBe(false);
    expect(result.response.status).toBe(403);
    const plain = await runStage(defineStage({ name: 'noop' }), createTestContext());
    expect(plain.response.status).toBe(200);
    expect(await responseText(plain.response)).toBe('ok');
    expect(await responseText(plain.response)).toBe('ok'); // clone keeps the body usable
  });

  it('runStages delegates to runPipeline with its options', async () => {
    const boom: Stage = defineStage({
      name: 'boom',
      pre() {
        throw new Error('boom');
      },
    });
    const result = await runStages([tagging, boom], createTestContext(), undefined, {
      onStageError: (err) => Response.json({ error: err.message }, { status: 500 }),
    });
    expect(result.shortCircuitedBy).toBe('boom');
    expect(await responseJson(result.response)).toEqual({ error: 'boom' });
    expect(result.response.headers.get('x-post')).toBe('1');
  });
});

describe('expectHeaders', () => {
  const response = new Response(null, {
    headers: [
      ['content-type', 'text/html'],
      ['x-request-id', 'abc-123'],
      ['set-cookie', 'a=1; Path=/'],
      ['set-cookie', 'b=2; Path=/; HttpOnly'],
    ],
  });

  it('passes for exact, regex and absent expectations (case-insensitive names)', () => {
    expect(() =>
      expectHeaders(response, {
        'Content-Type': 'text/html',
        'x-request-id': /^abc-/,
        'x-missing': null,
        'Set-Cookie': /a=1.*b=2/,
      }),
    ).not.toThrow();
  });

  it('throws one readable error listing every mismatch', () => {
    let message = '';
    try {
      expectHeaders(response, {
        'content-type': 'application/json',
        'x-request-id': /^zzz/,
        'x-missing': 'yes',
        'X-Request-Id': null,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Header expectations failed (status 200)');
    expect(message).toContain('content-type: expected "application/json", got "text/html"');
    expect(message).toContain('x-request-id: expected to match /^zzz/, got "abc-123"');
    expect(message).toContain('x-missing: expected "yes", got null');
    expect(message).toContain('X-Request-Id: expected to be absent, got "abc-123"');
    expect(message).toContain('Actual headers:');
    expect(message).toContain('  content-type: text/html');
  });

  it('collectSetCookies and parseSetCookie read cookies', () => {
    expect(collectSetCookies(response)).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
    expect(parseSetCookie('hyp_uid=a%20b; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax')).toEqual(
      {
        name: 'hyp_uid',
        value: 'a b',
        attributes: { 'max-age': '31536000', path: '/', secure: true, httponly: true, samesite: 'Lax' },
      },
    );
  });
});

describe('withEnv', () => {
  it('installs the env for sync and async functions and restores afterwards', async () => {
    expect(currentTestEnv()).toBeUndefined();
    const result = withEnv({ A: 1 }, () => currentTestEnv());
    expect(result).toEqual({ A: 1 });
    expect(currentTestEnv()).toBeUndefined();
    const nested = await withEnv({ outer: true }, async () => {
      const inner = await withEnv({ inner: true }, async () => currentTestEnv());
      return { inner, after: currentTestEnv() };
    });
    expect(nested).toEqual({ inner: { inner: true }, after: { outer: true } });
    expect(currentTestEnv()).toBeUndefined();
    expect(() =>
      withEnv({ x: 1 }, () => {
        throw new Error('fail');
      }),
    ).toThrow('fail');
    expect(currentTestEnv()).toBeUndefined();
    await expect(withEnv({ x: 1 }, async () => Promise.reject(new Error('async fail')))).rejects.toThrow(
      'async fail',
    );
    expect(currentTestEnv()).toBeUndefined();
  });
});
