import { describe, expect, it } from 'vitest';
import { createZonePurger, PURGE_BATCH_SIZE } from './purge';

function fakeFetch(status = 200) {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return new Response(status === 200 ? '{"success":true}' : '{"success":false}', { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('createZonePurger', () => {
  it('posts tags and files in batches of 30 with a bearer token', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const purger = createZonePurger({ zoneId: 'zone1', token: 'tok', fetch: fetchImpl });
    const tags = Array.from({ length: 65 }, (_, i) => `t${i}`);
    await purger.purgeTags([...tags, 't0', '']);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/purge_cache');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((calls[0]!.body as { tags: string[] }).tags).toHaveLength(PURGE_BATCH_SIZE);
    expect((calls[2]!.body as { tags: string[] }).tags).toEqual(['t60', 't61', 't62', 't63', 't64']);
    await purger.purgeUrls(['https://x.test/a', 'https://x.test/b']);
    expect(calls[3]!.body).toEqual({ files: ['https://x.test/a', 'https://x.test/b'] });
    await purger.purgeTags([]);
    expect(calls).toHaveLength(4);
  });

  it('logs failures and never throws', async () => {
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const log = {
      level: 'warn' as const,
      debug() {},
      info() {},
      warn: (_m: string, f?: Record<string, unknown>) => void warnings.push(f),
      error() {},
      child() {
        return log;
      },
    };
    const { fetchImpl } = fakeFetch(403);
    const purger = createZonePurger({ zoneId: 'z', token: 't', fetch: fetchImpl, log });
    await expect(purger.purgeTags(['a'])).resolves.toBeUndefined();
    expect(warnings[0]).toMatchObject({ status: 403, count: 1 });
    const throwing = createZonePurger({
      zoneId: 'z',
      token: 't',
      log,
      fetch: (async () => {
        throw new Error('net');
      }) as typeof fetch,
    });
    await expect(throwing.purgeUrls(['https://x.test/'])).resolves.toBeUndefined();
    expect(warnings[1]).toMatchObject({ error: 'net' });
    expect(() => createZonePurger({ zoneId: '', token: 't' })).toThrow(TypeError);
  });
});
