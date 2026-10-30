import { HypDrivError } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { scriptedFetch } from './__fixtures__/fakes';
import { globalConfigKv, parseGlobalConfigConnection } from './global-config';

const CONNECTION = 'https://global-config.vercel.com/ecfg_abc123?token=read-token';

const item = (value: unknown) => () => Response.json(value);
const missing = () => new Response('', { status: 404, headers: { 'x-edge-config-digest': 'd1' } });

describe('parseGlobalConfigConnection', () => {
  it('parses the Global Config and legacy Edge Config URLs', () => {
    expect(parseGlobalConfigConnection(CONNECTION)).toEqual({
      type: 'vercel',
      id: 'ecfg_abc123',
      token: 'read-token',
      baseUrl: 'https://global-config.vercel.com/ecfg_abc123',
      version: '1',
    });
    expect(parseGlobalConfigConnection('https://edge-config.vercel.com/ecfg_old?token=t')).toMatchObject({
      type: 'vercel',
      id: 'ecfg_old',
      baseUrl: 'https://edge-config.vercel.com/ecfg_old',
    });
  });

  it('parses the edge-config: query form and external endpoints', () => {
    expect(parseGlobalConfigConnection('edge-config:id=ecfg_q&token=tq')).toMatchObject({
      id: 'ecfg_q',
      token: 'tq',
      baseUrl: 'https://edge-config.vercel.com/ecfg_q',
    });
    expect(
      parseGlobalConfigConnection('https://config.example.com/v1/store?id=cfg1&token=x&version=2'),
    ).toEqual({
      type: 'external',
      id: 'cfg1',
      token: 'x',
      baseUrl: 'https://config.example.com/v1/store',
      version: '2',
    });
    expect(parseGlobalConfigConnection('https://mirror.example.com/ecfg_m?token=x')).toMatchObject({
      type: 'external',
      id: 'ecfg_m',
      baseUrl: 'https://mirror.example.com/ecfg_m',
    });
  });

  it('rejects unusable strings', () => {
    expect(parseGlobalConfigConnection('')).toBeNull();
    expect(parseGlobalConfigConnection('not a url')).toBeNull();
    expect(parseGlobalConfigConnection('https://global-config.vercel.com/ecfg_abc')).toBeNull();
    expect(parseGlobalConfigConnection('http://global-config.vercel.com/ecfg_abc?token=t')).toBeNull();
    expect(parseGlobalConfigConnection('https://global-config.vercel.com/?token=t')).toBeNull();
    expect(parseGlobalConfigConnection('edge-config:id=only')).toBeNull();
  });
});

describe('globalConfigKv', () => {
  it('throws E_CONFIG for an unparseable connection string without echoing it', () => {
    const error = (() => {
      try {
        globalConfigKv('https://example.com/?secret=1');
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(HypDrivError);
    expect((error as HypDrivError).code).toBe('E_CONFIG');
    expect((error as Error).message).not.toContain('secret');
  });

  it('reads items from the item endpoint with the read token', async () => {
    const fetch = scriptedFetch(item({ rules: [{ from: '/a', to: '/b' }] }));
    const kv = globalConfigKv(CONNECTION, { fetch });
    expect(kv.name).toBe('global-config');
    expect(kv.connection).toEqual({
      type: 'vercel',
      id: 'ecfg_abc123',
      baseUrl: 'https://global-config.vercel.com/ecfg_abc123',
      version: '1',
    });
    expect(await kv.get('redirects', 'json')).toEqual({ rules: [{ from: '/a', to: '/b' }] });
    expect(fetch.calls[0]!.url).toBe('https://global-config.vercel.com/ecfg_abc123/item/redirects?version=1');
    expect(new Headers(fetch.calls[0]!.init?.headers).get('authorization')).toBe('Bearer read-token');
  });

  it('returns strings as-is and JSON-stringifies other values for text reads', async () => {
    const values: Record<string, unknown> = { s: 'on', n: 42, o: { a: 1 }, b: false };
    const fetch = scriptedFetch((url) => Response.json(values[url.split('/item/')[1]!.split('?')[0]!]));
    const kv = globalConfigKv(CONNECTION, { fetch });
    expect(await kv.get('s')).toBe('on');
    expect(await kv.get('n')).toBe('42');
    expect(await kv.get('o', { type: 'text' })).toBe('{"a":1}');
    expect(await kv.get('b', 'json')).toBe(false);
    const buffer = (await kv.get('s', 'arrayBuffer')) as ArrayBuffer;
    expect(new TextDecoder().decode(buffer)).toBe('on');
  });

  it('returns null for missing keys and invalid key names', async () => {
    const fetch = scriptedFetch(missing);
    const kv = globalConfigKv(CONNECTION, { fetch });
    expect(await kv.get('absent')).toBeNull();
    expect(await kv.get('absent', 'json')).toBeNull();
    expect(await kv.get('bad key!')).toBeNull();
    expect(await kv.get('')).toBeNull();
    expect(fetch.calls).toHaveLength(1);
  });

  it('reports a missing store and a rejected token', async () => {
    const notFound = globalConfigKv(CONNECTION, {
      fetch: scriptedFetch(() => new Response('', { status: 404 })),
    });
    await expect(notFound.get('x')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    const unauthorized = globalConfigKv(CONNECTION, {
      fetch: scriptedFetch(() => new Response('', { status: 401 })),
    });
    const error = await unauthorized.get('x').catch((e: unknown) => e);
    expect((error as HypDrivError).code).toBe('E_UNAUTHORIZED');
    expect((error as Error).message).not.toContain('read-token');
    const broken = globalConfigKv(CONNECTION, {
      fetch: scriptedFetch(() => new Response('', { status: 502 })),
    });
    await expect(broken.get('x')).rejects.toMatchObject({ code: 'E_UPSTREAM' });
  });

  it('caches reads per key for cacheTtlMs and coalesces concurrent reads', async () => {
    let now = 0;
    let n = 0;
    const fetch = scriptedFetch(() => Response.json(++n));
    const kv = globalConfigKv(CONNECTION, { fetch, cacheTtlMs: 1000, now: () => now });
    const [a, b, c] = await Promise.all([kv.get('k', 'json'), kv.get('k', 'json'), kv.get('k', 'json')]);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(fetch.calls).toHaveLength(1);
    now = 999;
    expect(await kv.get('k', 'json')).toBe(1);
    now = 1000;
    expect(await kv.get('k', 'json')).toBe(2);
    expect(fetch.calls).toHaveLength(2);
    // Missing keys are cached too.
    await kv.get('other', 'json');
    expect(fetch.calls).toHaveLength(3);
  });

  it('serves the last known value when a refresh fails, then backs off for one TTL', async () => {
    let now = 0;
    const fetch = scriptedFetch(
      () => Response.json('v1'),
      () => new Response('', { status: 503 }),
      () => Response.json('v2'),
    );
    const kv = globalConfigKv(CONNECTION, { fetch, cacheTtlMs: 100, now: () => now });
    expect(await kv.get('k')).toBe('v1');
    now = 150;
    expect(await kv.get('k')).toBe('v1');
    now = 200;
    expect(await kv.get('k')).toBe('v1');
    expect(fetch.calls).toHaveLength(2);
    now = 260;
    expect(await kv.get('k')).toBe('v2');
  });

  it('is read-only', async () => {
    const kv = globalConfigKv(CONNECTION, { fetch: scriptedFetch(missing) });
    await expect(kv.put('a', 'b')).rejects.toMatchObject({ code: 'E_UNSUPPORTED' });
    await expect(kv.delete('a')).rejects.toThrow(/REST API/);
  });

  it('lists items through /items with prefix, limit and cursor, priming the cache', async () => {
    const fetch = scriptedFetch(() => Response.json({ 'flag-b': 1, 'flag-a': 2, other: 3 }));
    const kv = globalConfigKv(CONNECTION, { fetch });
    const first = await kv.list!({ prefix: 'flag-', limit: 1 });
    expect(first).toEqual({ keys: [{ name: 'flag-a' }], list_complete: false, cursor: '1' });
    expect(fetch.calls[0]!.url).toBe('https://global-config.vercel.com/ecfg_abc123/items?version=1');
    const second = await kv.list!({ prefix: 'flag-', limit: 1, cursor: first.cursor! });
    expect(second).toEqual({ keys: [{ name: 'flag-b' }], list_complete: true });
    expect(await kv.get('other', 'json')).toBe(3);
    expect(fetch.calls).toHaveLength(2);
  });

  it('fails list when the store is unreachable', async () => {
    const kv = globalConfigKv(CONNECTION, { fetch: scriptedFetch(() => new Response('', { status: 401 })) });
    await expect(kv.list!()).rejects.toMatchObject({ code: 'E_UNAUTHORIZED' });
  });
});
