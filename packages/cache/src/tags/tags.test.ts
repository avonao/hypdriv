import { describe, expect, it } from 'vitest';
import { fakeKv } from '../__fixtures__/fakes';
import { createKvTagIndex } from './kv';
import { createMemoryTagIndex } from './memory';

const NOW = 1_700_000_000_000;

describe('memory tag index', () => {
  it('indexes keys per tag, removes by key and by tag, and expires', async () => {
    let now = NOW;
    const index = createMemoryTagIndex({ now: () => now });
    await index.add('k1', ['route:a', 'blog'], 60);
    await index.add('k2', ['blog'], 60);
    await index.add('k3', ['route:b'], 1);
    expect((await index.keysFor(['blog'])).sort()).toEqual(['k1', 'k2']);
    expect(await index.keysFor(['route:a', 'route:b'])).toEqual(['k1', 'k3']);
    expect(await index.keysFor(['none'])).toEqual([]);
    now = NOW + 1500;
    expect(await index.keysFor(['route:b'])).toEqual([]);
    await index.remove(['k1']);
    expect(await index.keysFor(['blog', 'route:a'])).toEqual(['k2']);
    await index.removeTags!(['blog']);
    expect(await index.keysFor(['blog'])).toEqual([]);
    expect(index.size).toBe(0);
  });

  it('bounds keys per tag and the number of tags', async () => {
    const index = createMemoryTagIndex({ maxKeysPerTag: 2, maxTags: 2, now: () => NOW });
    await index.add('k1', ['t'], 60);
    await index.add('k2', ['t'], 60);
    await index.add('k3', ['t'], 60);
    expect(await index.keysFor(['t'])).toEqual(['k2', 'k3']);
    await index.add('k4', ['u'], 60);
    await index.add('k5', ['v'], 60);
    expect(index.size).toBe(2);
    expect(await index.keysFor(['t'])).toEqual([]);
    expect(await index.keysFor(['u', 'v'])).toEqual(['k4', 'k5']);
    index.clear();
    expect(index.size).toBe(0);
  });
});

describe('kv tag index', () => {
  it('batches adds into one write per tag, with an absolute expiration', async () => {
    const kv = fakeKv(() => NOW);
    const index = createKvTagIndex(kv, { batchDelayMs: 0, now: () => NOW, prefix: 'tag:' });
    await Promise.all([index.add('k1', ['blog', 'route:a'], 60), index.add('k2', ['blog'], 600)]);
    const blogPuts = kv.puts.filter((p) => p.key === 'tag:blog');
    expect(blogPuts).toHaveLength(1);
    expect(blogPuts[0]!.options).toEqual({ expiration: Math.ceil((NOW + 600_000) / 1000) });
    expect((await index.keysFor(['blog'])).sort()).toEqual(['k1', 'k2']);
    expect(await index.keysFor(['route:a'])).toEqual(['k1']);
    // Short lifetimes still get KV's 60 s minimum.
    expect(kv.puts.find((p) => p.key === 'tag:route:a')!.options).toEqual({
      expiration: Math.ceil((NOW + 60_000) / 1000),
    });
  });

  it('merges with existing lists, prunes expired keys and bounds the list', async () => {
    let now = NOW;
    const kv = fakeKv(() => now);
    const index = createKvTagIndex(kv, { batchDelayMs: 0, maxKeysPerTag: 2, now: () => now });
    await index.add('k1', ['t'], 1);
    await index.add('k2', ['t'], 60);
    now = NOW + 2000;
    await index.add('k3', ['t'], 60);
    expect(await index.keysFor(['t'])).toEqual(['k2', 'k3']);
    await index.add('k4', ['t'], 60);
    expect(await index.keysFor(['t'])).toEqual(['k3', 'k4']);
    await index.remove(['k3']); // no-op without a reverse index
    expect(await index.keysFor(['t'])).toEqual(['k3', 'k4']);
    await index.removeTags!(['t']);
    expect(await index.keysFor(['t'])).toEqual([]);
  });

  it('survives corrupt lists and write failures', async () => {
    const kv = fakeKv(() => NOW);
    await kv.put('hypdriv:tag:bad', '{"not":"a list"}');
    const index = createKvTagIndex(kv, { batchDelayMs: 0, now: () => NOW });
    expect(await index.keysFor(['bad'])).toEqual([]);
    const failing = {
      ...kv,
      put: async () => {
        throw new Error('429');
      },
    };
    const warnings: string[] = [];
    const log = {
      level: 'warn' as const,
      debug() {},
      info() {},
      warn: (m: string) => void warnings.push(m),
      error() {},
      child() {
        return log;
      },
    };
    const idx = createKvTagIndex(failing, { batchDelayMs: 0, now: () => NOW, log });
    await expect(idx.add('k', ['t'], 60)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
