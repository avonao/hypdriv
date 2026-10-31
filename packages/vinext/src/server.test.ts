import { emptyManifest } from '@hypdriv/core';
import { createHandler } from '@hypdriv/runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const noStore = vi.fn();
vi.mock('vinext/shims/cache', () => ({ unstable_noStore: () => noStore() }));

const { defer, devtoolsMeta, flag, geo, hyp, jobHandler, nonce, requireHyp } = await import('./server');

const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

beforeEach(() => {
  noStore.mockClear();
});

describe('@hypdriv/vinext/server', () => {
  it('reads the request context and opts the render out of vinext’s caches', async () => {
    const handler = createHandler({
      config: { flags: { definitions: { beta: { default: true } } } },
      manifest: emptyManifest(),
      target: 'node',
    });
    let seen: Record<string, unknown> = {};
    await handler(
      new Request('https://example.com/account', {
        headers: { 'user-agent': BROWSER, accept: 'text/html', 'accept-language': 'en-US' },
      }),
      {
        upstream: async () => {
          seen = {
            requestId: hyp()?.requestId,
            required: requireHyp().runner,
            nonce: nonce(),
            flag: flag('beta', false),
            missing: flag('nope'),
            geo: geo(),
            meta: devtoolsMeta()['hypdriv:runner'],
          };
          return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
        },
      },
    );
    expect(seen.requestId).toBeTruthy();
    expect(seen.required).toBe('host');
    expect(seen.nonce).toMatch(/.{16,}/);
    expect(seen.flag).toBe(true);
    expect(seen.missing).toBeUndefined();
    expect(seen.meta).toBe('host');
    expect(noStore).toHaveBeenCalledTimes(7);
  });

  it('returns nothing outside a request (build-time prerender) and still marks the render dynamic', () => {
    expect(hyp()).toBeNull();
    expect(nonce()).toBeUndefined();
    expect(flag('x', 'fallback')).toBe('fallback');
    expect(() => requireHyp()).toThrow(/no HypDriv request context/);
    expect(noStore).toHaveBeenCalledTimes(4);
    expect(typeof defer).toBe('function');
    expect(typeof jobHandler).toBe('function');
  });
});
