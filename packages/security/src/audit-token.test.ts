import { HEADER, resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { makeCtx, runStage } from './__tests__/helpers';
import {
  AUDIT_KEY,
  AUDIT_TOKEN_MAX_TTL_SECONDS,
  signAuditToken,
  verifiedAudit,
  verifyAuditToken,
} from './audit-token';
import { botsStage } from './bots';
import { BOT_KEY } from './keys';
import { createRateLimiter } from './rate-limit/limiter';
import { rateLimitStage } from './rate-limit/stage';
import { createMemoryCounterStore } from './rate-limit/stores';
import { signing } from './signing';

const SECRET = 'internal-secret-for-tests-0123456789';
const NOW = 1_800_000_000_000;

describe('signAuditToken / verifyAuditToken', () => {
  it('round-trips for the same host within the lifetime', async () => {
    const token = await signAuditToken(SECRET, { host: 'www.example.com', now: NOW, ttlSeconds: 600 });
    expect(token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
    expect(await verifyAuditToken(token, SECRET, { host: 'www.example.com', now: NOW })).toBe(true);
    expect(await verifyAuditToken(token, SECRET, { host: 'WWW.EXAMPLE.COM', now: NOW + 599_000 })).toBe(true);
    expect(signing.signAuditToken).toBe(signAuditToken);
    expect(signing.verifyAuditToken).toBe(verifyAuditToken);
  });

  it('rejects expired, foreign-host, wrong-secret, tampered and malformed tokens', async () => {
    const token = await signAuditToken(SECRET, { host: 'a.test', now: NOW, ttlSeconds: 60 });
    expect(await verifyAuditToken(token, SECRET, { host: 'a.test', now: NOW + 60_000 })).toBe(false);
    expect(await verifyAuditToken(token, SECRET, { host: 'b.test', now: NOW })).toBe(false);
    expect(await verifyAuditToken(token, `${SECRET}x`, { host: 'a.test', now: NOW })).toBe(false);
    const [v, exp, sig] = token.split('.');
    expect(
      await verifyAuditToken(`${v}.${Number(exp) + 1}.${sig}`, SECRET, { host: 'a.test', now: NOW }),
    ).toBe(false);
    for (const bad of [null, undefined, '', 'v1', 'v2.1.x', 'v1.abc.x', `${token}.extra`, 'x'.repeat(300)])
      expect(await verifyAuditToken(bad, SECRET, { host: 'a.test', now: NOW })).toBe(false);
  });

  it('caps the lifetime when minting and refuses tokens that claim a longer one', async () => {
    const capped = await signAuditToken(SECRET, { host: 'a.test', now: NOW, ttlSeconds: 86_400 });
    expect(Number(capped.split('.')[1]) - NOW / 1000).toBe(AUDIT_TOKEN_MAX_TTL_SECONDS);
    expect(await verifyAuditToken(capped, SECRET, { host: 'a.test', now: NOW, maxTtlSeconds: 600 })).toBe(
      false,
    );
  });
});

describe('verifiedAudit', () => {
  const config = resolveConfig({});

  it('verifies the header against the internal secret once per request', async () => {
    const token = await signAuditToken(SECRET, { host: 'app.test' });
    const ctx = makeCtx({
      config,
      headers: { [HEADER.auditToken]: token },
      env: { HYPDRIV_INTERNAL_SECRET: SECRET },
    });
    expect(await verifiedAudit(ctx, config)).toBe(true);
    expect(ctx.state.get(AUDIT_KEY)).toBe(true);
  });

  it('is false without a header, without a secret or with a bad token (and logs the bad token)', async () => {
    expect(await verifiedAudit(makeCtx({ config, env: { HYPDRIV_INTERNAL_SECRET: SECRET } }), config)).toBe(
      false,
    );
    const token = await signAuditToken(SECRET, { host: 'app.test' });
    expect(await verifiedAudit(makeCtx({ config, headers: { [HEADER.auditToken]: token } }), config)).toBe(
      false,
    );
    const bad = makeCtx({
      config,
      headers: { [HEADER.auditToken]: 'v1.1.nope' },
      env: { HYPDRIV_INTERNAL_SECRET: SECRET },
    });
    expect(await verifiedAudit(bad, config)).toBe(false);
  });

  it('uses the configured internal secret variable', async () => {
    const custom = resolveConfig({ security: { internalAuth: { secretEnv: 'MY_INTERNAL' } } });
    const token = await signAuditToken('other-secret', { host: 'app.test' });
    const ctx = makeCtx({
      config: custom,
      headers: { [HEADER.auditToken]: token },
      env: { MY_INTERNAL: 'other-secret', HYPDRIV_INTERNAL_SECRET: SECRET },
    });
    expect(await verifiedAudit(ctx, custom)).toBe(true);
  });
});

describe('audit tokens in the bots and rate-limit stages', () => {
  const HEADLESS =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36';
  const config = resolveConfig({
    security: {
      bots: { definitelyAutomated: 'block' },
      rateLimit: [{ id: 'pages', match: '/**', limit: 1, window: '1m', algorithm: 'fixed-window' }],
    },
  });
  const nav = {
    'user-agent': HEADLESS,
    accept: 'text/html',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  };

  it('lets a signed headless audit through the bot shield', async () => {
    const blocked = await runStage(botsStage(config), makeCtx({ config, headers: nav }));
    expect(blocked.response.status).toBe(403);

    const token = await signAuditToken(SECRET, { host: 'app.test' });
    const ctx = makeCtx({
      config,
      headers: { ...nav, [HEADER.auditToken]: token },
      env: { HYPDRIV_INTERNAL_SECRET: SECRET },
    });
    const allowed = await runStage(botsStage(config), ctx);
    expect(allowed.shortCircuited).toBe(false);
    expect(ctx.state.get(BOT_KEY)).toEqual({ verdict: 'human', reason: 'audit-token' });
    expect(allowed.forwarded?.headers.get(HEADER.bot)).toBe('human');
    expect(ctx.timings.list()).toContainEqual({ name: 'bot', desc: 'audit' });
  });

  it('keeps blocking when the token is forged', async () => {
    const forged = await signAuditToken('guessed-secret', { host: 'app.test' });
    const ctx = makeCtx({
      config,
      headers: { ...nav, [HEADER.auditToken]: forged },
      env: { HYPDRIV_INTERNAL_SECRET: SECRET },
    });
    expect((await runStage(botsStage(config), ctx)).response.status).toBe(403);
  });

  it('does not throttle signed audits', async () => {
    const limiter = createRateLimiter({ store: createMemoryCounterStore() });
    const stage = rateLimitStage(config, limiter);
    const token = await signAuditToken(SECRET, { host: 'app.test' });
    for (let i = 0; i < 3; i++) {
      const ctx = makeCtx({
        config,
        headers: { [HEADER.auditToken]: token },
        env: { HYPDRIV_INTERNAL_SECRET: SECRET },
      });
      const r = await runStage(stage, ctx, () => new Response('ok'));
      expect(r.response.status).toBe(200);
      expect(ctx.timings.list()).toContainEqual({ name: 'limit', desc: 'audit' });
    }
    await runStage(stage, makeCtx({ config }), () => new Response('ok'));
    expect((await runStage(stage, makeCtx({ config }), () => new Response('ok'))).response.status).toBe(429);
  });
});

describe('verifiedAudit host matching', () => {
  it('accepts the Host the client connected with when the server rewrote the URL host', async () => {
    const config = resolveConfig({});
    const token = await signAuditToken(SECRET, { host: '127.0.0.1' });
    const ctx = makeCtx({
      config,
      url: 'http://localhost:3000/',
      headers: { host: '127.0.0.1:3000', [HEADER.auditToken]: token },
      env: { HYPDRIV_INTERNAL_SECRET: SECRET },
    });
    expect(await verifiedAudit(ctx, config)).toBe(true);
    const other = makeCtx({
      config,
      url: 'http://localhost:3000/',
      headers: { host: 'evil.test', [HEADER.auditToken]: token },
      env: { HYPDRIV_INTERNAL_SECRET: SECRET },
    });
    expect(await verifiedAudit(other, config)).toBe(false);
  });
});
