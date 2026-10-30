import { resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { makeCtx, runStage } from './__tests__/helpers';
import { checkCsrf, csrfStage, issueCsrfToken, verifyCsrfToken } from './csrf';

const SECRET = 'csrf-secret-with-enough-entropy-0123456789';
const config = resolveConfig({ security: { csrf: true } });
const env = { HYPDRIV_SESSION_SECRET: SECRET };

describe('csrf tokens', () => {
  it('issues and verifies tokens bound to a session id', async () => {
    const token = await issueCsrfToken(SECRET, 'sess-1');
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyCsrfToken(SECRET, token, 'sess-1')).toBe(true);
    expect(await verifyCsrfToken(SECRET, token, 'sess-2')).toBe(false);
    expect(await verifyCsrfToken('other-secret-that-is-long-enough-000', token, 'sess-1')).toBe(false);
    expect(await verifyCsrfToken(SECRET, `${token}x`, 'sess-1')).toBe(false);
    expect(await verifyCsrfToken(SECRET, 'nodot', 'sess-1')).toBe(false);
    const anonymous = await issueCsrfToken(SECRET);
    expect(await verifyCsrfToken(SECRET, anonymous)).toBe(true);
  });
});

describe('csrfStage', () => {
  const stage = csrfStage(config);
  const post = (headers: Record<string, string>, extra: Partial<Parameters<typeof makeCtx>[0]> = {}) =>
    makeCtx({ config, env, url: 'https://app.test/api/items', method: 'POST', headers, ...extra });

  it('ignores safe methods, unmatched and exempt routes', async () => {
    for (const ctx of [
      makeCtx({
        config,
        env,
        url: 'https://app.test/api/items',
        method: 'GET',
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
      makeCtx({
        config,
        env,
        url: 'https://app.test/page',
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
      makeCtx({
        config,
        env,
        url: 'https://app.test/api/webhooks/stripe',
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
    ]) {
      expect((await runStage(stage, ctx, () => new Response('ok'))).shortCircuited).toBe(false);
    }
  });

  it('accepts same-origin Sec-Fetch-Site and valid double-submit tokens; rejects the rest', async () => {
    expect(
      (await runStage(stage, post({ 'sec-fetch-site': 'same-origin' }), () => new Response('ok')))
        .shortCircuited,
    ).toBe(false);
    expect(
      (await runStage(stage, post({ 'sec-fetch-site': 'none' }), () => new Response('ok'))).shortCircuited,
    ).toBe(false);

    const token = await issueCsrfToken(SECRET);
    const ok = await runStage(
      stage,
      post({ cookie: `hyp_csrf=${token}`, 'x-csrf-token': token, 'sec-fetch-site': 'same-site' }),
      () => new Response('ok'),
    );
    expect(ok.shortCircuited).toBe(false);

    const form = post(
      { cookie: `hyp_csrf=${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      { body: `_csrf=${encodeURIComponent(token)}&name=x` },
    );
    expect((await runStage(stage, form, () => new Response('ok'))).shortCircuited).toBe(false);

    const expectReject = async (ctx: ReturnType<typeof post>, reason: string) => {
      const { response, shortCircuited } = await runStage(stage, ctx, () => new Response('ok'));
      expect(shortCircuited).toBe(true);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'csrf', reason });
    };
    await expectReject(post({ 'sec-fetch-site': 'cross-site' }), 'cross-site');
    await expectReject(post({}), 'missing-cookie');
    await expectReject(post({ cookie: `hyp_csrf=${token}` }), 'missing-token');
    await expectReject(post({ cookie: `hyp_csrf=${token}`, 'x-csrf-token': 'different' }), 'mismatch');
    const forged = 'forgedid.forgedsignature';
    await expectReject(post({ cookie: `hyp_csrf=${forged}`, 'x-csrf-token': forged }), 'invalid-signature');
  });

  it('falls back to equality when no secret is configured', async () => {
    const forged = 'abc.def';
    const request = new Request('https://app.test/api/x', {
      method: 'POST',
      headers: { cookie: `hyp_csrf=${forged}`, 'x-csrf-token': forged },
    });
    expect(
      await checkCsrf(request, { cookie: 'hyp_csrf', header: 'x-csrf-token', acceptSecFetchSite: true }),
    ).toEqual({ ok: true, via: 'token' });
    const strict = await checkCsrf(
      new Request('https://app.test/api/x', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }),
      {
        cookie: 'hyp_csrf',
        header: 'x-csrf-token',
        acceptSecFetchSite: false,
      },
    );
    expect(strict).toEqual({ ok: false, reason: 'missing-cookie' });
  });
});
