import { resolveConfig } from '@hypdriv/core';
import { describe, expect, it, vi } from 'vitest';
import { carryPlatformFacts, nativeRequest, type PlatformRequest, platformInput } from './entry';

const config = (trustedProxies = 0) =>
  resolveConfig({ site: { name: 'solid-test' }, security: { trustedProxies } });

/** A request carrying srvx-style platform facts. */
function srvxRequest(facts: Record<string, unknown>, url = 'https://shop.example/'): PlatformRequest {
  const request = new Request(url);
  for (const [key, value] of Object.entries(facts)) Object.defineProperty(request, key, { value });
  return request as PlatformRequest;
}

describe('nativeRequest', () => {
  it('unwraps the native request behind srvx’s lazy Node request', () => {
    const native = new Request('https://shop.example/about');
    const lazy = srvxRequest({ _request: native });
    expect(nativeRequest(lazy)).toBe(native);
  });

  it('returns other requests as they are', () => {
    const plain = new Request('https://shop.example/');
    expect(nativeRequest(plain)).toBe(plain);
    expect(nativeRequest(srvxRequest({ _request: { not: 'a request' } }))).toBeInstanceOf(Request);
  });
});

describe('carryPlatformFacts', () => {
  it('copies ip, waitUntil, runtime, context and cf onto the forwarded request', () => {
    const waitUntil = () => undefined;
    const runtime = { name: 'node', node: { req: {}, res: {} } };
    const from = srvxRequest({
      ip: '203.0.113.9',
      waitUntil,
      runtime,
      context: { a: 1 },
      cf: { country: 'US' },
    });
    const to = carryPlatformFacts(from, new Request('https://shop.example/')) as PlatformRequest;
    expect(to.ip).toBe('203.0.113.9');
    expect(to.waitUntil).toBe(waitUntil);
    expect(to.runtime).toBe(runtime);
    expect(to.context).toEqual({ a: 1 });
    expect(to.cf).toEqual({ country: 'US' });
    // Not enumerable: the extra facts do not leak into spreads or JSON.
    expect(Object.keys(to)).toEqual([]);
  });

  it('leaves absent facts and facts the target already has alone', () => {
    const from = srvxRequest({ ip: '203.0.113.9' });
    const to = new Request('https://shop.example/');
    Object.defineProperty(to, 'ip', { value: '198.51.100.1' });
    carryPlatformFacts(from, to);
    expect((to as PlatformRequest).ip).toBe('198.51.100.1');
    expect('runtime' in to).toBe(false);
  });

  it('returns the same request when nothing was forwarded', () => {
    const request = srvxRequest({ ip: '203.0.113.9' });
    expect(carryPlatformFacts(request, request)).toBe(request);
  });

  it('does without a fact a frozen request refuses', () => {
    const frozen = Object.freeze(new Request('https://shop.example/'));
    expect(() => carryPlatformFacts(srvxRequest({ ip: '203.0.113.9' }), frozen)).not.toThrow();
  });
});

describe('platformInput', () => {
  it('reads the client address from the socket unless the server sits behind proxies', () => {
    const request = srvxRequest({ ip: '203.0.113.9' });
    expect(platformInput(request, config(0)).ip).toBe('203.0.113.9');
    expect(platformInput(request, config(1)).ip).toBeUndefined();
    expect(platformInput(srvxRequest({ ip: '' }), config(0)).ip).toBeUndefined();
  });

  it('reads Cloudflare bindings and the execution context from request.runtime.cloudflare', () => {
    const env = { HYPDRIV_INTERNAL_SECRET: 'x' };
    const waitUntil = vi.fn();
    const context = { waitUntil };
    const input = platformInput(
      srvxRequest({ runtime: { name: 'cloudflare', cloudflare: { env, context } } }),
      config(),
    );
    expect(input.env).toBe(env);
    const promise = Promise.resolve();
    input.waitUntil?.(promise);
    expect(waitUntil).toHaveBeenCalledWith(promise);
    // `this` stays the context: Workers' waitUntil throws when detached.
    expect(waitUntil.mock.contexts[0]).toBe(context);
  });

  it('falls back to the waitUntil srvx puts on the request (Vercel, Node)', () => {
    const calls: Promise<unknown>[] = [];
    const request = srvxRequest({
      waitUntil(promise: Promise<unknown>) {
        calls.push(promise);
      },
    });
    const promise = Promise.resolve();
    platformInput(request, config()).waitUntil?.(promise);
    expect(calls).toEqual([promise]);
  });

  it('passes request.cf and nothing else on a plain request', () => {
    expect(platformInput(srvxRequest({ cf: { country: 'DE' } }), config()).cf).toEqual({ country: 'DE' });
    expect(platformInput(new Request('https://shop.example/'), config())).toEqual({});
  });
});
