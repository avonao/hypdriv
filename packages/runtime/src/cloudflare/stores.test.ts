import { createFakeDurableObjectNamespace } from '@hypdriv/testing';
import { describe, expect, it } from 'vitest';
import { INDEX_SHARDS } from './constants';
import { callDurableObject, createDoCounterStore, createDoLock, createDoTagIndex } from './stores';

/** In-memory stand-in for `HypDrivIndex` (the real one is exercised in workerd). */
function memoryIndex() {
  const rows = new Map<string, Set<string>>();
  return {
    async add(key: string, tags: string[]) {
      for (const t of tags) rows.set(t, (rows.get(t) ?? new Set()).add(key));
    },
    async keysFor(tags: string[]) {
      return [...new Set(tags.flatMap((t) => [...(rows.get(t) ?? [])]))];
    },
    async remove(keys: string[]) {
      for (const set of rows.values()) for (const k of keys) set.delete(k);
      return keys.length;
    },
    async clearTags(tags: string[]) {
      for (const t of tags) rows.delete(t);
      return tags.length;
    },
    fetch: () => new Response('rpc only', { status: 405 }),
    rows,
  };
}

describe('callDurableObject', () => {
  it('prefers RPC methods on the stub', async () => {
    const ns = createFakeDurableObjectNamespace(() => ({
      fetch: () => new Response('no'),
      double: async (n: number) => n * 2,
    }));
    expect(await callDurableObject<number>(ns, 'a', 'double', [21])).toBe(42);
    expect(ns.fetches).toHaveLength(0);
  });

  it('falls back to the JSON fetch transport', async () => {
    const ns = createFakeDurableObjectNamespace(() => ({
      async fetch(request: Request) {
        const { op, args } = (await request.json()) as { op: string; args: number[] };
        return Response.json({ op, sum: args.reduce((a, b) => a + b, 0) });
      },
    }));
    // Hide RPC by calling an op the instance does not define as a method.
    expect(await callDurableObject(ns, 'b', 'sum', [1, 2, 3])).toEqual({ op: 'sum', sum: 6 });
  });

  it('throws on transport errors', async () => {
    const ns = createFakeDurableObjectNamespace(() => ({
      fetch: () => new Response('bad', { status: 500 }),
    }));
    await expect(callDurableObject(ns, 'c', 'missing', [])).rejects.toThrow(
      'durable object missing failed: 500',
    );
  });
});

describe('createDoTagIndex', () => {
  it('shards tags across objects and merges lookups', async () => {
    const instances = new Map<string, ReturnType<typeof memoryIndex>>();
    const ns = createFakeDurableObjectNamespace((id) => {
      const instance = memoryIndex();
      instances.set(id.name ?? id.toString(), instance);
      return instance;
    });
    const index = createDoTagIndex(ns);
    const tags = Array.from({ length: 40 }, (_, i) => `tag-${i}`);
    await index.add('key-1', tags, 60);
    await index.add('key-2', ['tag-1'], 60);
    expect([...instances.keys()].every((name) => /^shard:\d+$/.test(name))).toBe(true);
    expect(instances.size).toBeGreaterThan(1);
    expect(instances.size).toBeLessThanOrEqual(INDEX_SHARDS);
    expect((await index.keysFor(['tag-1', 'tag-30'])).sort()).toEqual(['key-1', 'key-2']);

    await index.removeTags?.(['tag-1']);
    expect(await index.keysFor(['tag-1'])).toEqual([]);
    await index.remove(['key-1']);
    expect(await index.keysFor(['tag-30'])).toEqual([]);
  });
});

describe('createDoCounterStore / createDoLock', () => {
  it('forwards to one object per key', async () => {
    const calls: Array<{ name: string | undefined; op: string; args: unknown[] }> = [];
    const ns = createFakeDurableObjectNamespace((id) => ({
      fetch: () => new Response('rpc only', { status: 405 }),
      increment: async (...args: unknown[]) => {
        calls.push({ name: id.name, op: 'increment', args });
        return { count: 1, resetAt: 60_000 };
      },
      slidingCount: async (...args: unknown[]) => {
        calls.push({ name: id.name, op: 'slidingCount', args });
        return { count: 2, resetAt: 60_000 };
      },
      takeToken: async (...args: unknown[]) => {
        calls.push({ name: id.name, op: 'takeToken', args });
        return { allowed: true, remaining: 4, resetAt: 1 };
      },
      lock: async (...args: unknown[]) => {
        calls.push({ name: id.name, op: 'lock', args });
        return { acquired: true, holder: 'h1', expiresAt: 5 };
      },
      unlock: async (...args: unknown[]) => {
        calls.push({ name: id.name, op: 'unlock', args });
        return true;
      },
    }));
    const store = createDoCounterStore(ns);
    expect(await store.increment('rl:api:1.2.3.4', 60, 1000)).toEqual({ count: 1, resetAt: 60_000 });
    expect(await store.slidingCount!('rl:api:1.2.3.4', 60, 1000)).toEqual({ count: 2, resetAt: 60_000 });
    expect(await store.takeToken!('rl:burst', 5, 1, 1000)).toEqual({
      allowed: true,
      remaining: 4,
      resetAt: 1,
    });
    const lock = createDoLock(ns);
    expect(await lock.acquire('render:/', 'h1', 5000)).toMatchObject({ acquired: true });
    expect(await lock.release('render:/', 'h1')).toBe(true);
    expect(calls.map((c) => `${c.name}:${c.op}`)).toEqual([
      'rl:api:1.2.3.4:increment',
      'rl:api:1.2.3.4:slidingCount',
      'rl:burst:takeToken',
      'lock:render:/:lock',
      'lock:render:/:unlock',
    ]);
  });
});
