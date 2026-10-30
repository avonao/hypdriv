import { createContext, loadConfig, orderStages, runPipeline } from '@hypdriv/core';
import { flagsStage, staticProvider } from '@hypdriv/flags';
import { createMemoryCounterStore, createRateLimiter, rateLimitStage } from '@hypdriv/security';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogger } from './__fixtures__/fakes';
import { vercelCdnStage } from './cdn';
import { vercelStages } from './platform';
import { __resetVercelSdk, registerVercelSdk } from './sdk';
import { __resetWarnings } from './util';

const config = loadConfig({
  cache: { edge: { policies: [{ id: 'home', match: '/', ttl: 120, tags: ['home'] }] } },
  flags: { definitions: { hero: { default: 'a', rules: [{ percentage: 50, value: 'b' }] } } },
  security: { rateLimit: [{ id: 'api', match: '/api/**', limit: 1000, window: 60 }] },
  vercel: { firewall: { rateLimitRules: { api: 'waf-api' } } },
});

beforeEach(() => {
  __resetWarnings();
  __resetVercelSdk();
});
afterEach(() => __resetVercelSdk());

describe('pipeline integration', () => {
  it('never lets the flags bucketing cookie ride on a CDN-cacheable response', async () => {
    const stages = orderStages([
      vercelCdnStage(config)!,
      flagsStage(config, staticProvider(config.flags.definitions)),
    ]);
    expect(stages.map((s) => s.name)).toEqual(['flags', 'edge-cache']);

    const first = createContext({
      request: new Request('https://shop.example.com/'),
      config,
      log: captureLogger(),
    });
    const fresh = await runPipeline({ stages, ctx: first, next: async () => new Response('home') });
    expect(fresh.response.headers.get('set-cookie')).toMatch(/^hyp_uid=/);
    expect(fresh.response.headers.get('vercel-cdn-cache-control')).toBeNull();

    const returning = createContext({
      request: new Request('https://shop.example.com/', {
        headers: { cookie: 'hyp_uid=abcdefabcdefabcdef' },
      }),
      config,
      log: captureLogger(),
    });
    const cached = await runPipeline({ stages, ctx: returning, next: async () => new Response('home') });
    expect(cached.response.headers.get('set-cookie')).toBeNull();
    expect(cached.response.headers.get('vercel-cdn-cache-control')).toBe('s-maxage=120');
    expect(cached.response.headers.get('vercel-cache-tag')).toContain('home');
  });

  it('runs the WAF stage after the local limiter in the adapted default list', async () => {
    registerVercelSdk({ checkRateLimit: async () => ({ rateLimited: true }) });
    const limiter = createRateLimiter({ store: createMemoryCounterStore() });
    const adapted = vercelStages(config)([rateLimitStage(config, limiter), vercelCdnStage(config)!]);
    const ctx = createContext({
      request: new Request('https://shop.example.com/api/orders'),
      config,
      ip: '198.51.100.7',
      log: captureLogger(),
    });
    const result = await runPipeline({ stages: adapted, ctx, next: async () => new Response('never') });
    expect(result.shortCircuitedBy).toBe('rate-limit-vercel');
    expect(result.ran).toEqual(['rate-limit', 'rate-limit-vercel']);
    expect(result.response.status).toBe(429);
  });
});
