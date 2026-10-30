import { type FlagDefinition, type KVNamespaceLike, type Logger, resolveConfig } from '@hypdriv/core';
import { describe, expect, it, vi } from 'vitest';
import type { FlagEvalInput } from './evaluate';
import {
  createFlagProvider,
  envProvider,
  kvProvider,
  type OpenFeatureClientLike,
  openFeatureProvider,
  parseFlagDefinitions,
  staticProvider,
} from './providers';

const fallback: Record<string, FlagDefinition> = { base: { default: true }, shared: { default: 'config' } };

function recordingLogger(): Logger & { lines: Array<{ level: string; message: string }> } {
  const lines: Array<{ level: string; message: string }> = [];
  const log: Logger & { lines: typeof lines } = {
    lines,
    level: 'debug',
    debug: (m) => void lines.push({ level: 'debug', message: m }),
    info: (m) => void lines.push({ level: 'info', message: m }),
    warn: (m) => void lines.push({ level: 'warn', message: m }),
    error: (m) => void lines.push({ level: 'error', message: m }),
    child: () => log,
  };
  return log;
}

/** Tiny in-memory KV with just enough surface for the provider. */
function fakeKv(
  initial: Record<string, string> = {},
): KVNamespaceLike & { reads: number; store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  const kv = {
    reads: 0,
    store,
    async get(key: string, options?: unknown): Promise<unknown> {
      kv.reads++;
      const raw = store.get(key) ?? null;
      const type = typeof options === 'string' ? options : (options as { type?: string } | undefined)?.type;
      if (raw !== null && type === 'json') return JSON.parse(raw);
      return raw;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) {
      store.set(key, String(value));
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return kv as unknown as KVNamespaceLike & { reads: number; store: Map<string, string> };
}

describe('parseFlagDefinitions', () => {
  it('normalises valid definitions and reports invalid ones', () => {
    const invalid: string[] = [];
    const out = parseFlagDefinitions(
      {
        ok: {
          default: false,
          description: 'd',
          serverOnly: true,
          rules: [{ value: true, percentage: 10 }, { nope: 1 }],
        },
        noDefault: { rules: [] },
        wrongType: { default: null },
        notObject: 'x',
      },
      (name) => invalid.push(name),
    );
    expect(out).toEqual({
      ok: { default: false, description: 'd', serverOnly: true, rules: [{ value: true, percentage: 10 }] },
    });
    expect(invalid).toEqual(['noDefault', 'wrongType', 'notObject']);
    expect(parseFlagDefinitions([])).toBeNull();
    expect(parseFlagDefinitions('str')).toBeNull();
  });
});

describe('staticProvider', () => {
  it('returns the definitions as given', async () => {
    const p = staticProvider(fallback);
    expect(p.name).toBe('static');
    expect(await p.load()).toBe(fallback);
  });
});

describe('envProvider', () => {
  it('merges JSON from the env var over the fallback', async () => {
    const env = { HYPDRIV_FLAGS: JSON.stringify({ shared: { default: 'env' }, extra: { default: 1 } }) };
    const p = envProvider(env, 'HYPDRIV_FLAGS', fallback);
    expect(await p.load()).toEqual({
      base: { default: true },
      shared: { default: 'env' },
      extra: { default: 1 },
    });
  });

  it('falls back and warns exactly once on invalid JSON', async () => {
    const log = recordingLogger();
    const p = envProvider({ HYPDRIV_FLAGS: '{not json' }, 'HYPDRIV_FLAGS', fallback, { log });
    expect(await p.load()).toBe(fallback);
    expect(await p.load()).toBe(fallback);
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(log.lines[0]?.message).toContain('Invalid JSON');
  });

  it('warns through console.warn once when no logger is given', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = envProvider({ X: '[1]' }, 'X', fallback);
      await p.load();
      await p.load();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the fallback when the variable is missing or empty and re-reads when it changes', async () => {
    const env: Record<string, unknown> = {};
    const p = envProvider(env, 'F', fallback);
    expect(await p.load()).toBe(fallback);
    env.F = JSON.stringify({ later: { default: 'yes' } });
    expect((await p.load()).later).toEqual({ default: 'yes' });
    env.F = '   ';
    expect(await p.load()).toBe(fallback);
  });
});

describe('kvProvider', () => {
  it('reads once per refresh interval and refreshes afterwards', async () => {
    let now = 1_000_000;
    const kv = fakeKv({ flags: JSON.stringify({ shared: { default: 'kv' } }) });
    const p = kvProvider(kv, 'flags', fallback, 30, { now: () => now });
    const first = await Promise.all([p.load(), p.load(), p.load()]);
    expect(first[0]).toEqual({ base: { default: true }, shared: { default: 'kv' } });
    expect(kv.reads).toBe(1);
    now += 29_000;
    await p.load();
    expect(kv.reads).toBe(1);
    kv.store.set('flags', JSON.stringify({ shared: { default: 'kv2' } }));
    now += 2_000;
    expect((await p.load()).shared).toEqual({ default: 'kv2' });
    expect(kv.reads).toBe(2);
    p.invalidate?.();
    await p.load();
    expect(kv.reads).toBe(3);
  });

  it('serves the fallback when the key is missing and keeps the last good value on errors', async () => {
    let now = 0;
    const kv = fakeKv();
    const log = recordingLogger();
    const p = kvProvider(kv, 'flags', fallback, 1, { now: () => now, log });
    expect(await p.load()).toBe(fallback);
    kv.store.set('flags', JSON.stringify({ a: { default: 1 } }));
    now += 1_001;
    expect((await p.load()).a).toEqual({ default: 1 });
    kv.get = async () => {
      throw new Error('kv down');
    };
    now += 1_001;
    expect((await p.load()).a).toEqual({ default: 1 });
    expect(log.lines.some((l) => l.message.includes('Failed to read flags'))).toBe(true);
    (kv as { get: unknown }).get = async () => 'not-an-object';
    now += 1_001;
    expect((await p.load()).a).toEqual({ default: 1 });
  });
});

describe('openFeatureProvider', () => {
  const definitions: Record<string, FlagDefinition> = {
    bool: { default: false },
    str: { default: 'a' },
    num: { default: 1 },
    broken: { default: 'local', rules: [{ when: { country: ['US'] }, value: 'rule' }] },
  };
  const calls: Array<{ method: string; key: string; ctx: Record<string, unknown> | undefined }> = [];
  const client: OpenFeatureClientLike = {
    async getBooleanValue(key, d, ctx) {
      calls.push({ method: 'bool', key, ctx });
      return !d;
    },
    async getStringValue(key, d, ctx) {
      calls.push({ method: 'str', key, ctx });
      if (key === 'broken') throw new Error('provider down');
      return `${d}-remote`;
    },
    async getNumberValue(key, d, ctx) {
      calls.push({ method: 'num', key, ctx });
      return d + 41;
    },
  };
  const base: FlagEvalInput = {
    definitions,
    stableId: 'uid-1',
    url: new URL('https://e.com/pricing'),
    headers: new Headers(),
    cookies: {},
    geo: { country: 'US', continent: 'NA' },
    device: 'desktop',
  };

  it('evaluates through the typed getters with a targeting context', async () => {
    calls.length = 0;
    const p = openFeatureProvider(client, definitions);
    expect(await p.load()).toBe(definitions);
    const r = await p.evaluate!(base);
    expect(r.values).toEqual({ bool: true, str: 'a-remote', num: 42, broken: 'rule' });
    expect(r.reasons).toEqual({
      bool: 'openfeature',
      str: 'openfeature',
      num: 'openfeature',
      broken: 'openfeature-error',
    });
    const ctx = calls.find((c) => c.key === 'bool')?.ctx;
    expect(ctx).toMatchObject({
      targetingKey: 'uid-1',
      country: 'US',
      continent: 'NA',
      path: '/pricing',
      device: 'desktop',
    });
    expect(calls.map((c) => c.method).sort()).toEqual(['bool', 'num', 'str', 'str']);
  });

  it('keeps local overrides ahead of remote values', async () => {
    const p = openFeatureProvider(client, definitions);
    const r = await p.evaluate!({ ...base, overrides: { num: '7' } });
    expect(r.values.num).toBe(7);
    expect(r.reasons.num).toBe('override');
  });
});

describe('createFlagProvider', () => {
  it('picks the configured provider and degrades without bindings', () => {
    const defs = { a: { default: true } };
    expect(createFlagProvider(resolveConfig({ flags: { definitions: defs } }), {}).name).toBe('static');
    expect(
      createFlagProvider(resolveConfig({ flags: { definitions: defs, provider: 'env' } }), {}).name,
    ).toBe('env');
    const log = recordingLogger();
    expect(createFlagProvider(resolveConfig({ flags: { provider: 'kv' } }), {}, { log }).name).toBe('static');
    expect(
      createFlagProvider(resolveConfig({ flags: { provider: 'kv' } }), { HYPDRIV_KV: fakeKv() }).name,
    ).toBe('kv');
    expect(createFlagProvider(resolveConfig({ flags: { provider: 'openfeature' } }), {}, { log }).name).toBe(
      'static',
    );
    const client: OpenFeatureClientLike = {
      getBooleanValue: async (_k, d) => d,
      getStringValue: async (_k, d) => d,
      getNumberValue: async (_k, d) => d,
    };
    expect(
      createFlagProvider(
        resolveConfig({ flags: { provider: 'openfeature' } }),
        {},
        { openFeatureClient: client },
      ).name,
    ).toBe('openfeature');
    expect(log.lines).toHaveLength(2);
  });
});
