import { createContext, type HypDrivConfig, loadConfig } from '@hypdriv/core';
import { RATE_LIMIT_KEY } from '@hypdriv/security';
import { runStage } from '@hypdriv/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogger } from './__fixtures__/fakes';
import { vercelRateLimitBinding, vercelRateLimitRouter, vercelRateLimitStage } from './firewall';
import {
  __resetVercelSdk,
  type CheckRateLimitFn,
  type CheckRateLimitOptions,
  registerVercelSdk,
} from './sdk';
import { __resetWarnings } from './util';

const calls: Array<[string, CheckRateLimitOptions | undefined]> = [];

function register(results: Record<string, Awaited<ReturnType<CheckRateLimitFn>> | Error>) {
  registerVercelSdk({
    checkRateLimit: async (rule, options) => {
      calls.push([rule, options]);
      const result = results[rule] ?? { rateLimited: false };
      if (result instanceof Error) throw result;
      return result;
    },
  });
}

const CONFIG: HypDrivConfig = {
  security: {
    rateLimit: [
      { id: 'api', match: '/api/**', limit: 100, window: '1m' },
      { id: 'login', match: '/login', methods: ['POST'], limit: 5, window: '10m', key: ['ip'] },
      { id: 'bound', match: '/bound/**', limit: 10, window: 60, store: 'binding' },
    ],
  },
  vercel: { firewall: { rateLimitRules: { api: 'waf-api', login: 'waf-login', bound: 'waf-bound' } } },
};

beforeEach(() => {
  calls.length = 0;
  __resetVercelSdk();
  __resetWarnings();
});
afterEach(() => __resetVercelSdk());

describe('vercelRateLimitBinding', () => {
  it('maps rateLimited to success: false and passes the key and request', async () => {
    register({ 'waf-a': { rateLimited: true }, 'waf-b': { rateLimited: true, error: 'blocked' } });
    const request = new Request('https://app.example.com/');
    expect(await vercelRateLimitBinding('waf-a', { request, timeoutMs: 500 }).limit({ key: 'k1' })).toEqual({
      success: false,
    });
    expect(await vercelRateLimitBinding('waf-b').limit({ key: 'k2' })).toEqual({ success: false });
    expect(await vercelRateLimitBinding('waf-c').limit({ key: 'k3' })).toEqual({ success: true });
    expect(calls[0]).toEqual(['waf-a', { rateLimitKey: 'k1', request, timeout: 500 }]);
    expect(calls[1]).toEqual(['waf-b', { rateLimitKey: 'k2' }]);
  });

  it('allows and warns once for unknown rules and a missing SDK', async () => {
    const log = captureLogger();
    expect(await vercelRateLimitBinding('waf', { log }).limit({ key: 'k' })).toEqual({ success: true });
    expect(await vercelRateLimitBinding('waf', { log }).limit({ key: 'k' })).toEqual({ success: true });
    register({ missing: { rateLimited: false, error: 'not-found' } });
    expect(await vercelRateLimitBinding('missing', { log }).limit({ key: 'k' })).toEqual({ success: true });
    expect(await vercelRateLimitBinding('missing', { log }).limit({ key: 'k' })).toEqual({ success: true });
    expect(log.lines.map((l) => l.message)).toEqual([
      expect.stringContaining('@vercel/firewall is not registered'),
      expect.stringContaining('rule "missing" is not configured'),
    ]);
  });

  it('propagates SDK failures so the limiter can fail open', async () => {
    register({ boom: new Error('unexpected status 500') });
    await expect(vercelRateLimitBinding('boom').limit({ key: 'k' })).rejects.toThrow(/500/);
  });
});

describe('vercelRateLimitRouter', () => {
  it('routes keys to the rule of their policy, else the first rule', async () => {
    register({});
    const router = vercelRateLimitRouter(loadConfig(CONFIG))!;
    await router.limit({ key: 'login|ip=1.2.3.4' });
    await router.limit({ key: 'unmapped|ip=1' });
    expect(calls.map((c) => c[0])).toEqual(['waf-login', 'waf-api']);
    expect(vercelRateLimitRouter(loadConfig({}))).toBeNull();
  });
});

describe('vercelRateLimitStage', () => {
  const ctxFor = (url: string, init: RequestInit = {}) =>
    createContext({
      request: new Request(url, init),
      config: loadConfig(CONFIG),
      ip: '203.0.113.9',
      log: captureLogger(),
    });

  it('is null when no policy is mapped to a rule', () => {
    expect(vercelRateLimitStage(loadConfig({}))).toBeNull();
    expect(
      vercelRateLimitStage(
        loadConfig({
          ...CONFIG,
          vercel: { firewall: { rateLimitRules: { bound: 'waf-bound', ghost: 'waf-ghost' } } },
        }),
      ),
    ).toBeNull();
  });

  it('short-circuits with the policy 429 response when the WAF limits the request', async () => {
    register({ 'waf-api': { rateLimited: true } });
    const stage = vercelRateLimitStage(loadConfig(CONFIG))!;
    expect(stage.name).toBe('rate-limit-vercel');
    const ctx = ctxFor('https://app.example.com/api/orders');
    const { response, shortCircuited } = await runStage(stage, ctx);
    expect(shortCircuited).toBe(true);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('ratelimit-policy')).toBe('"api";q=100;w=60');
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    expect(ctx.state.get(RATE_LIMIT_KEY)).toEqual([
      { policy: 'api', remaining: 0, limit: 100, reset: expect.any(Number) },
    ]);
    expect(calls[0]![0]).toBe('waf-api');
    expect(calls[0]![1]).toMatchObject({
      rateLimitKey: 'api|ip=203.0.113.9',
      request: ctx.request,
      timeout: 2000,
    });
  });

  it('checks only applicable policies and lets allowed requests through', async () => {
    register({ 'waf-login': { rateLimited: false } });
    const stage = vercelRateLimitStage(loadConfig(CONFIG), { timeoutMs: 100 })!;
    const get = await runStage(stage, ctxFor('https://app.example.com/login'));
    expect(get.nextCalled).toBe(true);
    expect(calls).toHaveLength(0);
    const post = await runStage(stage, ctxFor('https://app.example.com/login', { method: 'POST' }));
    expect(post.nextCalled).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(['waf-login']);
    // `store: 'binding'` policies go through the platform binding instead.
    await runStage(stage, ctxFor('https://app.example.com/bound/x'));
    expect(calls).toHaveLength(1);
  });

  it('fails open on WAF errors and unknown rules, and when the SDK is missing', async () => {
    register({ 'waf-api': new Error('timeout') });
    const stage = vercelRateLimitStage(loadConfig(CONFIG))!;
    const ctx = ctxFor('https://app.example.com/api/x');
    expect((await runStage(stage, ctx)).nextCalled).toBe(true);
    expect((ctx.log as ReturnType<typeof captureLogger>).lines[0]).toMatchObject({ level: 'error' });

    register({ 'waf-api': { rateLimited: false, error: 'not-found' } });
    expect((await runStage(stage, ctxFor('https://app.example.com/api/x'))).nextCalled).toBe(true);

    __resetVercelSdk();
    const missing = ctxFor('https://app.example.com/api/x');
    expect((await runStage(stage, missing)).nextCalled).toBe(true);
    expect((missing.log as ReturnType<typeof captureLogger>).lines[0]?.message).toContain('not registered');
  });
});
