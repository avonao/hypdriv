import { createMemoryStore } from '@hypdriv/cache';
import {
  defineStage,
  describeCapabilities,
  type HypDrivConfig,
  loadConfig,
  type QueueLike,
  queueEnvKey,
  type Stage,
} from '@hypdriv/core';
import { createRateLimiter } from '@hypdriv/security';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogger, createFakeUpstash, scriptedFetch } from './__fixtures__/fakes';
import { isVercel, VERCEL_REQUEST_CONTEXT, vercelRequestContext } from './context';
import { REDIS_BINDING, vercelEnv, vercelPlatformOverrides, vercelStages } from './platform';
import { __resetVercelSdk, getVercelSdk, registerVercelSdk } from './sdk';
import { __resetWarnings } from './util';

const GC = 'https://global-config.vercel.com/ecfg_test?token=read';
const REDIS = { KV_REST_API_URL: 'https://us1-fake.upstash.io', KV_REST_API_TOKEN: 'test-token' };

beforeEach(() => {
  __resetWarnings();
  __resetVercelSdk();
});
afterEach(() => {
  __resetVercelSdk();
  delete (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT];
});

describe('vercelEnv queue producers', () => {
  it('exposes a Vercel Queues producer per configured queue, ready once @vercel/queue is registered', async () => {
    const out = vercelEnv(
      loadConfig({
        jobs: { queues: { emails: { path: '/api/jobs/emails' } } },
        vercel: { queues: { reports: 'reports-topic' } },
      }),
      {},
    );
    const emails = out[queueEnvKey('emails')] as QueueLike;
    const reports = out[queueEnvKey('reports')] as QueueLike;
    expect(emails.ready?.()).toBe(false);
    const sent: Array<[string, unknown]> = [];
    registerVercelSdk({
      queue: {
        send: async (topic: string, payload: unknown) => {
          sent.push([topic, payload]);
          return { messageId: 'm1' };
        },
        handleCallback: () => async () => new Response(null),
      } as never,
    });
    expect(reports.ready?.()).toBe(true);
    await reports.send({ id: 1 });
    await emails.send({ to: 'a@example.com' });
    expect(sent).toEqual([
      ['reports-topic', { id: 1 }],
      ['emails', { to: 'a@example.com' }],
    ]);
  });

  it('keeps producers that already exist', () => {
    const existing = { send: async () => undefined };
    const out = vercelEnv(loadConfig({ jobs: { queues: { emails: { path: '/x' } } } }), {
      [queueEnvKey('emails')]: existing,
    });
    expect(out[queueEnvKey('emails')]).toBe(existing);
  });
});

describe('vercelEnv', () => {
  it('leaves the env alone when nothing is configured', () => {
    const env = { FOO: 'bar' };
    const out = vercelEnv(loadConfig({}), env);
    expect(out).toEqual(env);
    expect(out).not.toBe(env);
  });

  it('exposes Global Config as the generic KV binding when a connection string exists', async () => {
    const fetch = scriptedFetch(() => Response.json({ beta: { default: true } }));
    const out = vercelEnv(loadConfig({}), { EDGE_CONFIG: GC }, { fetch });
    const kv = out.HYPDRIV_KV as { name: string; get: (k: string, t: 'json') => Promise<unknown> };
    expect(kv.name).toBe('global-config');
    expect(await kv.get('flags', 'json')).toEqual({ beta: { default: true } });
    expect(out[REDIS_BINDING]).toBeUndefined();
  });

  it('prefers GLOBAL_CONFIG over EDGE_CONFIG and Global Config over Redis for the generic binding', () => {
    const out = vercelEnv(
      loadConfig({ redirects: { kvBinding: 'REDIRECTS_KV' } }),
      { GLOBAL_CONFIG: GC, EDGE_CONFIG: 'https://edge-config.vercel.com/ecfg_old?token=x', ...REDIS },
      { fetch: scriptedFetch(() => Response.json(null)) },
    );
    expect((out.HYPDRIV_KV as { connection: { id: string } }).connection.id).toBe('ecfg_test');
    expect(out.REDIRECTS_KV).toBe(out.HYPDRIV_KV);
    expect((out[REDIS_BINDING] as { name: string }).name).toBe('upstash');
  });

  it('uses Redis as the generic binding without Global Config, and keeps existing bindings', () => {
    const fake = createFakeUpstash();
    const existing = { get: async () => null, put: async () => undefined, delete: async () => undefined };
    const out = vercelEnv(
      loadConfig({}),
      { UPSTASH_REDIS_REST_URL: REDIS.KV_REST_API_URL, UPSTASH_REDIS_REST_TOKEN: 'test-token' },
      { fetch: fake.fetch },
    );
    expect((out.HYPDRIV_KV as { name: string }).name).toBe('upstash');
    expect(out.HYPDRIV_KV).toBe(out[REDIS_BINDING]);
    const kept = vercelEnv(loadConfig({}), { ...REDIS, HYPDRIV_KV: existing });
    expect(kept.HYPDRIV_KV).toBe(existing);
  });

  it('honours disabled integrations, custom env names and the Redis prefix', async () => {
    expect(
      vercelEnv(loadConfig({ vercel: { globalConfig: false, redis: false } }), {
        GLOBAL_CONFIG: GC,
        ...REDIS,
      }),
    ).toEqual({
      GLOBAL_CONFIG: GC,
      ...REDIS,
    });
    const fake = createFakeUpstash({ token: 'custom' });
    const out = vercelEnv(
      loadConfig({ vercel: { redis: { urlEnv: ['MY_URL'], tokenEnv: ['MY_TOKEN'], prefix: 'shop:' } } }),
      { MY_URL: 'https://us1-fake.upstash.io', MY_TOKEN: 'custom' },
      { fetch: fake.fetch },
    );
    await (out.HYPDRIV_KV as { put: (k: string, v: string) => Promise<void> }).put('a', '1');
    expect([...fake.data.keys()]).toEqual(['shop:a']);
  });

  it('warns once and ignores an unrecognised Global Config connection string', () => {
    const log = captureLogger();
    const out = vercelEnv(loadConfig({}), { GLOBAL_CONFIG: 'nonsense' }, { log });
    vercelEnv(loadConfig({}), { GLOBAL_CONFIG: 'nonsense' }, { log });
    expect(out.HYPDRIV_KV).toBeUndefined();
    expect(log.lines).toHaveLength(1);
  });

  it('reuses store instances across calls (per-key caches survive)', () => {
    const a = vercelEnv(loadConfig({}), { GLOBAL_CONFIG: GC });
    const b = vercelEnv(loadConfig({}), { GLOBAL_CONFIG: GC });
    expect(a.HYPDRIV_KV).toBe(b.HYPDRIV_KV);
  });
});

describe('vercelPlatformOverrides', () => {
  const RULES: HypDrivConfig = {
    security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 1, window: 60, store: 'kv' }] },
    vercel: { firewall: { rateLimitRules: { api: 'waf-api' } } },
  };

  it('uses Upstash for exact global counters and detects the KV capability', async () => {
    const fake = createFakeUpstash();
    const overrides = vercelPlatformOverrides(
      loadConfig(RULES),
      { ...REDIS },
      { fetch: fake.fetch, log: captureLogger() },
    );
    expect(overrides.capabilities.kv).toBe(true);
    expect(overrides.capabilities.waitUntil).toBe(true);
    expect(overrides.capabilities.cf).toBe(false);
    expect(overrides.counterStore?.name).toBe('upstash');
    expect(overrides.counterStores?.kv).toBe(overrides.counterStore);
    expect(overrides.cacheStore).toBeUndefined();
    const limiter = createRateLimiter({ store: overrides.counterStore! });
    const policy = loadConfig(RULES).security.rateLimit[0]!;
    expect((await limiter.check(policy, 'api|ip=1', 1_700_000_000_000)).allowed).toBe(true);
    expect((await limiter.check(policy, 'api|ip=1', 1_700_000_000_000)).allowed).toBe(false);
  });

  it('replaces KV-backed stores with memory when the KV binding is read-only Global Config', () => {
    const log = captureLogger();
    const overrides = vercelPlatformOverrides(loadConfig(RULES), { GLOBAL_CONFIG: GC }, { log });
    expect(overrides.capabilities.kv).toBe(true);
    expect(overrides.counterStore).toBeUndefined();
    expect(overrides.counterStores?.kv?.name).toBe('memory');
    expect(overrides.cacheStore?.name).toBe(createMemoryStore().name);
    expect(log.lines[0]?.message).toContain('read-only Global Config');
  });

  it('adds the WAF binding when rules exist and resolves the SDK lazily', async () => {
    const overrides = vercelPlatformOverrides(loadConfig(RULES), {}, { log: captureLogger() });
    expect(overrides.counterStores).toBeUndefined();
    const binding = overrides.rateLimitBinding!;
    registerVercelSdk({ checkRateLimit: async () => ({ rateLimited: true }) });
    expect(await binding.limit({ key: 'api|ip=1' })).toEqual({ success: false });
    expect(vercelPlatformOverrides(loadConfig({}), {}).rateLimitBinding).toBeUndefined();
  });

  it('purges through the Vercel purger with the augmented env', async () => {
    const fetch = scriptedFetch(() => new Response('{}'));
    const overrides = vercelPlatformOverrides(
      loadConfig({}),
      { VERCEL_TOKEN: 't', VERCEL_PROJECT_ID: 'p' },
      { fetch, log: captureLogger() },
    );
    expect(await overrides.edgePurger.purgeTags(['posts'])).toBe(1);
    await overrides.purger.purgeUrls(['/blog']);
    expect(fetch.calls[0]!.url).toContain('/v1/edge-cache/invalidate-by-tags');
    expect(fetch.calls[1]!.body).toEqual({ tags: ['hyp:path:/blog'] });
  });
});

describe('vercelStages', () => {
  const named = (name: string): Stage => defineStage({ name, pre: () => undefined });
  const defaults = () =>
    [
      'request-id',
      'bots',
      'rate-limit',
      'geo',
      'csp',
      'edge-cache',
      'security-headers',
      'html-transforms',
      'observe',
    ].map(named);

  it('replaces edge-cache, inserts the WAF stage after rate-limit and removes html-transforms', () => {
    const config = loadConfig({
      cache: { edge: { policies: [{ id: 'p', match: '/p', ttl: 60 }] } },
      security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 1, window: 60 }] },
      vercel: { firewall: { rateLimitRules: { api: 'waf-api' } } },
    });
    const original = defaults();
    const out = vercelStages(config)(original);
    expect(out.map((s) => s.name)).toEqual([
      'request-id',
      'bots',
      'rate-limit',
      'rate-limit-vercel',
      'geo',
      'csp',
      'edge-cache',
      'security-headers',
      'observe',
    ]);
    expect(out[6]).not.toBe(original[5]);
    expect(out[6]!.runOnRsc).toBe(true);
  });

  it('places the WAF stage after the earliest guard when there is no rate-limit stage', () => {
    const config = loadConfig({
      security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 1, window: 60 }] },
      vercel: { firewall: { rateLimitRules: { api: 'waf-api' } } },
    });
    const out = vercelStages(config)(defaults().filter((s) => s.name !== 'rate-limit'));
    expect(out.map((s) => s.name).slice(0, 3)).toEqual(['request-id', 'bots', 'rate-limit-vercel']);
    const bare = vercelStages(config)([named('custom')]);
    expect(bare.map((s) => s.name)).toEqual(['rate-limit-vercel', 'custom']);
  });

  it('keeps the default edge cache when the CDN integration is disabled', () => {
    const original = defaults();
    const out = vercelStages(loadConfig({ vercel: { cdn: false } }))(original);
    expect(out.find((s) => s.name === 'edge-cache')).toBe(original[5]);
    expect(out.some((s) => s.name === 'rate-limit-vercel')).toBe(false);
  });
});

describe('isVercel / vercelRequestContext', () => {
  it('detects Vercel from the environment or the explicit platform', () => {
    expect(isVercel({ VERCEL: '1' })).toBe(true);
    expect(isVercel({ NEXT_EDGE_RUNTIME_PROVIDER: 'vercel' })).toBe(true);
    expect(isVercel({}, 'vercel')).toBe(true);
    expect(isVercel({ VERCEL: '1' }, 'cloudflare')).toBe(false);
  });

  it('reads the request context and returns null outside a request', () => {
    expect(vercelRequestContext()).toBeNull();
    const context = { headers: { host: 'app.example.com' } };
    (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] = { get: () => context };
    expect(vercelRequestContext()).toBe(context);
    expect(isVercel({})).toBe(true);
    (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] = { get: () => undefined };
    expect(vercelRequestContext()).toBeNull();
    (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] = {
      get: () => {
        throw new Error('outside request');
      },
    };
    expect(vercelRequestContext()).toBeNull();
  });
});

describe('registerVercelSdk', () => {
  it('merges registrations on a global symbol', () => {
    const checkRateLimit = async () => ({ rateLimited: false });
    const checkBotId = async () => ({ isHuman: true, isBot: false, isVerifiedBot: false, bypassed: false });
    expect(getVercelSdk()).toEqual({});
    registerVercelSdk({ checkRateLimit });
    registerVercelSdk({ checkBotId });
    expect(getVercelSdk()).toEqual({ checkRateLimit, checkBotId });
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('hypdriv.vercel.sdk')]).toEqual({
      checkRateLimit,
      checkBotId,
    });
  });
});

describe('vercelPlatformOverrides capabilities', () => {
  it('describes the Vercel services that replace Cloudflare bindings', () => {
    const config = loadConfig({
      jobs: { queues: { emails: { path: '/api/jobs/emails' } } },
      vercel: { firewall: { rateLimitRules: { api: 'api-limit' } } },
      security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 10, window: '1m' }] },
    });
    const lines = describeCapabilities(vercelPlatformOverrides(config, { ...REDIS }).capabilities);
    expect(lines).toContain('cache: Vercel CDN (Vercel-CDN-Cache-Control, Vercel-Cache-Tag)');
    expect(lines).toContain('rate limiting: exact (Upstash Redis) + Vercel WAF (1 rule)');
    expect(lines.find((l) => l.startsWith('queues:'))).toContain('Vercel Queues (emails;');
    expect(describeCapabilities(vercelPlatformOverrides(loadConfig({}), {}).capabilities)).toContain(
      'rate limiting: per instance',
    );
  });
});
