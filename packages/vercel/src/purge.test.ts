import type { EdgePurger, Purger } from '@hypdriv/cache';
import { loadConfig } from '@hypdriv/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogger, scriptedFetch } from './__fixtures__/fakes';
import { VERCEL_REQUEST_CONTEXT, type VercelPurgeApi } from './context';
import { deleteTags, invalidateTags, purgeVercelTags, toPlatformPurger, vercelPurger } from './purge';
import { __resetWarnings } from './util';

const ENV = { VERCEL_TOKEN: 'vt', VERCEL_PROJECT_ID: 'prj_1', VERCEL_TEAM_ID: 'team_1' };

function installContext(purge: Partial<VercelPurgeApi> | null) {
  (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] = { get: () => (purge ? { purge } : {}) };
}

beforeEach(() => __resetWarnings());
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT];
});

describe('purge through the request context', () => {
  it('invalidates sanitised tags in batches of 16 with the runtime API', async () => {
    const calls: unknown[] = [];
    installContext({
      invalidateByTag: async (tag) => void calls.push(tag),
      dangerouslyDeleteByTag: async () => undefined,
    });
    const fetch = scriptedFetch(() => new Response('{}'));
    const tags = [...Array.from({ length: 20 }, (_, i) => `t${i}`), 't1', 'a,b', ' '];
    expect(await invalidateTags(tags, { env: ENV, fetch })).toBe(21);
    expect(calls).toHaveLength(2);
    expect((calls[0] as string[]).length).toBe(16);
    expect(calls[1]).toContain('a%2Cb');
    expect(fetch.calls).toHaveLength(0);
  });

  it('deletes with a revalidation deadline', async () => {
    const calls: unknown[] = [];
    installContext({
      invalidateByTag: async () => undefined,
      dangerouslyDeleteByTag: async (tag, options) => void calls.push([tag, options]),
    });
    expect(await deleteTags(['x'], { revalidationDeadlineSeconds: 30.7 })).toBe(1);
    expect(await deleteTags(['y'])).toBe(1);
    expect(calls).toEqual([
      [['x'], { revalidationDeadlineSeconds: 30 }],
      [['y'], {}],
    ]);
  });

  it('falls back to the REST API when the runtime purge fails', async () => {
    installContext({
      invalidateByTag: async () => {
        throw new Error('429 Too Many Requests');
      },
      dangerouslyDeleteByTag: async () => undefined,
    });
    const log = captureLogger();
    const fetch = scriptedFetch(() => new Response('{}'));
    expect(await invalidateTags(['x'], { env: ENV, fetch, log })).toBe(1);
    expect(fetch.calls).toHaveLength(1);
    expect(log.lines[0]?.message).toContain('request-context purge failed');
  });

  it('can be told not to use the request context', async () => {
    installContext({ invalidateByTag: async () => undefined, dangerouslyDeleteByTag: async () => undefined });
    const fetch = scriptedFetch(() => new Response('{}'));
    await invalidateTags(['x'], { env: ENV, fetch, useRequestContext: false });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('purge through the REST API', () => {
  it('posts tags with project, team and the current environment as target', async () => {
    const fetch = scriptedFetch(() => new Response('{}'));
    expect(
      await invalidateTags(['posts', 'hyp:path:/blog'], { env: { ...ENV, VERCEL_ENV: 'production' }, fetch }),
    ).toBe(2);
    const call = fetch.calls[0]!;
    expect(call.url).toBe(
      'https://api.vercel.com/v1/edge-cache/invalidate-by-tags?projectIdOrName=prj_1&teamId=team_1',
    );
    expect(call.body).toEqual({ tags: ['posts', 'hyp:path:/blog'], target: 'production' });
    expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer vt');
  });

  it('uses the configured env names and dangerously-delete for deletes', async () => {
    const config = loadConfig({
      vercel: { purge: { tokenEnv: 'PURGE_TOKEN', projectIdEnv: 'PURGE_PROJECT', teamIdEnv: 'PURGE_TEAM' } },
    });
    const fetch = scriptedFetch(() => new Response('{}'));
    await deleteTags(['a'], {
      env: { PURGE_TOKEN: 'p', PURGE_PROJECT: 'my-app', VERCEL_ENV: 'development' },
      config,
      fetch,
      revalidationDeadlineSeconds: 60,
    });
    expect(fetch.calls[0]!.url).toBe(
      'https://api.vercel.com/v1/edge-cache/dangerously-delete-by-tags?projectIdOrName=my-app',
    );
    expect(fetch.calls[0]!.body).toEqual({ tags: ['a'], revalidationDeadlineSeconds: 60 });
  });

  it('falls back to VERCEL_PROJECT_ID and honours an explicit target', async () => {
    const config = loadConfig({ vercel: { purge: { projectIdEnv: 'CUSTOM_PROJECT' } } });
    const fetch = scriptedFetch(() => new Response('{}'));
    await invalidateTags(['a'], {
      env: { VERCEL_TOKEN: 't', VERCEL_PROJECT_ID: 'prj_sys', VERCEL_ENV: 'production' },
      config,
      fetch,
      target: null,
    });
    expect(fetch.calls[0]!.url).toContain('projectIdOrName=prj_sys');
    expect(fetch.calls[0]!.body).toEqual({ tags: ['a'] });
    await invalidateTags(['a'], { env: ENV, fetch, target: 'preview', apiBase: 'https://api.example.test/' });
    expect(fetch.calls[1]!.url.startsWith('https://api.example.test/v1/edge-cache/')).toBe(true);
    expect(fetch.calls[1]!.body).toEqual({ tags: ['a'], target: 'preview' });
  });

  it('retries once after Retry-After on 429', async () => {
    const fetch = scriptedFetch(
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      () => new Response('{}'),
    );
    expect(await invalidateTags(['a'], { env: ENV, fetch })).toBe(1);
    expect(fetch.calls).toHaveLength(2);
  });

  it('gives up on a second 429, on long Retry-After and on errors, logging instead of throwing', async () => {
    const log = captureLogger();
    const twice = scriptedFetch(() => new Response('no', { status: 429, headers: { 'retry-after': '0' } }));
    expect(await invalidateTags(['a'], { env: ENV, fetch: twice, log })).toBe(0);
    expect(twice.calls).toHaveLength(2);
    const long = scriptedFetch(() => new Response('no', { status: 429, headers: { 'retry-after': '120' } }));
    expect(await invalidateTags(['a'], { env: ENV, fetch: long, log })).toBe(0);
    expect(long.calls).toHaveLength(1);
    const forbidden = scriptedFetch(() => new Response('{"error":"forbidden"}', { status: 403 }));
    expect(await invalidateTags(['a'], { env: ENV, fetch: forbidden, log })).toBe(0);
    const broken = scriptedFetch(() => {
      throw new TypeError('network down');
    });
    expect(await invalidateTags(['a'], { env: ENV, fetch: broken, log })).toBe(0);
    expect(log.lines.every((l) => l.level === 'warn')).toBe(true);
    expect(JSON.stringify(log.lines)).not.toContain('vt');
    expect(log.lines.find((l) => l.fields?.status === 403)?.fields?.body).toContain('forbidden');
  });

  it('counts partially successful batches', async () => {
    const fetch = scriptedFetch(
      () => new Response('{}'),
      () => new Response('bad', { status: 400 }),
    );
    const tags = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(await invalidateTags(tags, { env: ENV, fetch, log: captureLogger() })).toBe(16);
  });

  it('warns once and purges nothing without credentials', async () => {
    const log = captureLogger();
    const fetch = scriptedFetch(() => new Response('{}'));
    expect(await purgeVercelTags('invalidate', ['a'], { env: {}, fetch, log })).toBe(0);
    expect(await purgeVercelTags('invalidate', ['b'], { env: { VERCEL_TOKEN: 't' }, fetch, log })).toBe(0);
    expect(fetch.calls).toHaveLength(0);
    expect(log.lines).toHaveLength(1);
    expect(await purgeVercelTags('invalidate', [' '], { env: ENV, fetch, log })).toBe(0);
  });
});

describe('vercelPurger', () => {
  it('purges tags and maps URLs to path tags', async () => {
    const fetch = scriptedFetch(() => new Response('{}'));
    const purger = vercelPurger({ env: ENV, config: loadConfig({}), fetch, log: captureLogger() });
    expect(await purger.purgeTags(['posts'])).toBe(1);
    expect(await purger.purgeUrls(['https://shop.example.com/blog/hello?x=1', '/about', 'http://[bad'])).toBe(
      2,
    );
    expect(fetch.calls[1]!.body).toEqual({ tags: ['hyp:path:/blog/hello', 'hyp:path:/about'] });
  });

  it('fits the EdgePurger contract and adapts to the platform Purger slot', async () => {
    const fetch = scriptedFetch(() => new Response('{}'));
    const purger = vercelPurger({ env: ENV, config: loadConfig({}), fetch });
    const asEdge: EdgePurger = purger;
    expect(await asEdge.purgeTags(['a'])).toBe(1);
    const asPurger: Purger = toPlatformPurger(purger);
    expect(await asPurger.purgeTags(['b'])).toBeUndefined();
    expect(await asPurger.purgeUrls(['/c'])).toBeUndefined();
    expect(fetch.calls.map((c) => c.body)).toEqual([
      { tags: ['a'] },
      { tags: ['b'] },
      { tags: ['hyp:path:/c'] },
    ]);
  });
});
