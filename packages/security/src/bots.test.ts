import { HEADER, resolveConfig } from '@hypdriv/core';
import { describe, expect, it, vi } from 'vitest';
import { makeCtx, runStage } from './__tests__/helpers';
import { botsStage, classifyRequest } from './bots';
import { BOT_KEY } from './keys';

const bots = resolveConfig({
  security: { bots: { blockUserAgents: ['EvilScraper'], allowUserAgents: ['MyUptimeChecker'] } },
}).security.bots!;
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const browserHeaders = {
  'user-agent': CHROME,
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
};

describe('classifyRequest', () => {
  const cases: Array<[string, Parameters<typeof makeCtx>[0], string, string | RegExp]> = [
    ['real browser', { headers: browserHeaders }, 'human', 'ok'],
    ['allow-listed UA', { headers: { 'user-agent': 'MyUptimeChecker/1.0' } }, 'human', 'ua:allow-list'],
    [
      'cf verified bot',
      {
        headers: { 'user-agent': 'Googlebot/2.1' },
        cf: { botManagement: { score: 1, verifiedBot: true }, verifiedBotCategory: 'Search Engine Crawler' },
      },
      'verified',
      /^cf:verified-bot/,
    ],
    [
      'verified UA list',
      {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
      },
      'verified',
      'ua:bingbot',
    ],
    [
      'spoofed verified UA under bot management',
      {
        headers: { 'user-agent': 'Googlebot/2.1' },
        cf: { botManagement: { score: 50, verifiedBot: false } },
      },
      'likely',
      /^ua:spoofed/,
    ],
    [
      'block-list UA',
      { headers: { ...browserHeaders, 'user-agent': 'EvilScraper/3' } },
      'definite',
      /^ua:block-list/,
    ],
    [
      'honeypot path',
      { url: 'https://app.test/wp-login.php', headers: browserHeaders },
      'definite',
      'honeypot',
    ],
    [
      'bot management score 1',
      { headers: browserHeaders, cf: { botManagement: { score: 1 } } },
      'definite',
      'cf:score',
    ],
    ['empty UA on a document request', { headers: { accept: 'text/html' } }, 'definite', 'ua:empty'],
    [
      'headless chrome on a page',
      { headers: { ...browserHeaders, 'user-agent': `${CHROME.replace('Chrome', 'HeadlessChrome')}` } },
      'definite',
      'ua:HeadlessChrome',
    ],
    [
      'curl on a page',
      { headers: { 'user-agent': 'curl/8.4.0', accept: 'text/html' } },
      'definite',
      'ua:curl/',
    ],
    [
      'okhttp on an API endpoint',
      {
        url: 'https://app.test/api/items',
        headers: { 'user-agent': 'okhttp/4.12.0', accept: 'application/json' },
      },
      'likely',
      'ua:okhttp/',
    ],
    [
      'SEO crawler',
      { headers: { 'user-agent': 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)' } },
      'likely',
      /^ua:crawler/,
    ],
    ['low score', { headers: browserHeaders, cf: { botManagement: { score: 12 } } }, 'likely', 'cf:score'],
    [
      'browser UA without accept headers',
      { headers: { 'user-agent': CHROME } },
      'likely',
      'headers:missing-accept',
    ],
    [
      'modern Chrome navigation without Sec-Fetch',
      { headers: { 'user-agent': CHROME, accept: 'text/html', 'accept-language': 'en' } },
      'likely',
      'sec-fetch:missing',
    ],
    [
      'sec-fetch inconsistency',
      { headers: { ...browserHeaders, 'sec-fetch-mode': 'cors' } },
      'likely',
      'sec-fetch:dest-mode-mismatch',
    ],
    [
      'invalid sec-fetch-mode',
      { headers: { ...browserHeaders, 'sec-fetch-mode': 'weird' } },
      'likely',
      'sec-fetch:invalid-mode',
    ],
    [
      'API client with json accept and no UA tokens',
      {
        url: 'https://app.test/api/x',
        headers: { 'user-agent': 'MyApp/2.0 (iOS)', accept: 'application/json' },
      },
      'human',
      'ok',
    ],
  ];
  it.each(cases)('%s → %s', (_name, options, verdict, reason) => {
    const result = classifyRequest(makeCtx(options), bots);
    expect(result.verdict).toBe(verdict);
    if (typeof reason === 'string') expect(result.reason).toBe(reason);
    else expect(result.reason).toMatch(reason);
  });

  it('carries the bot management score and honours secFetchChecks=false', () => {
    const scored = classifyRequest(
      makeCtx({ headers: browserHeaders, cf: { botManagement: { score: 80 } } }),
      bots,
    );
    expect(scored).toEqual({ verdict: 'human', reason: 'ok', score: 80 });
    const relaxed = resolveConfig({ security: { bots: { secFetchChecks: false } } }).security.bots!;
    expect(
      classifyRequest(makeCtx({ headers: { ...browserHeaders, 'sec-fetch-mode': 'cors' } }), relaxed).verdict,
    ).toBe('human');
  });
});

describe('botsStage', () => {
  it('allows humans, logs likely traffic, blocks definite traffic and sets the request header', async () => {
    const config = resolveConfig({});
    const stage = botsStage(config);
    const human = makeCtx({ config, headers: browserHeaders });
    const r1 = await runStage(stage, human, () => new Response('ok'));
    expect(r1.shortCircuited).toBe(false);
    expect(r1.forwarded?.headers.get(HEADER.bot)).toBe('human');
    expect(human.state.get(BOT_KEY)).toEqual({ verdict: 'human', reason: 'ok' });

    const likely = makeCtx({
      config,
      url: 'https://app.test/api/x',
      headers: { 'user-agent': 'axios/1.6.0', accept: 'application/json' },
    });
    const info = vi.spyOn(likely.log, 'info');
    const r2 = await runStage(stage, likely, () => new Response('ok'));
    expect(r2.shortCircuited).toBe(false);
    expect(info).toHaveBeenCalled();
    expect(r2.forwarded?.headers.get(HEADER.bot)).toBe('likely');

    const definite = makeCtx({
      config,
      headers: { 'user-agent': 'python-requests/2.31', accept: 'text/html' },
    });
    const r3 = await runStage(stage, definite, () => new Response('ok'));
    expect(r3.shortCircuited).toBe(true);
    expect(r3.response.status).toBe(403);
    expect(await r3.response.json()).toEqual({ error: 'forbidden', reason: 'automated' });
    expect(definite.timings.list()).toContainEqual({ name: 'bot', desc: 'definite' });
  });

  it('skips exempt paths and respects tarpit', async () => {
    const config = resolveConfig({ security: { bots: { definitelyAutomated: 'tarpit', tarpitMs: 50 } } });
    const sleep = vi.fn(async () => undefined);
    const stage = botsStage(config, { sleep });
    const exempt = makeCtx({
      config,
      url: 'https://app.test/_next/static/x.js',
      headers: { 'user-agent': 'curl/8', accept: 'text/html' },
    });
    expect((await runStage(stage, exempt, () => new Response('ok'))).shortCircuited).toBe(false);
    const ctx = makeCtx({ config, headers: { 'user-agent': 'curl/8', accept: 'text/html' } });
    const { response } = await runStage(stage, ctx, () => new Response('ok'));
    expect(sleep).toHaveBeenCalledWith(50, expect.anything());
    expect(response.status).toBe(429);
  });

  it('challenge: serves a Turnstile page, accepts a verified token and issues a clearance cookie', async () => {
    const config = resolveConfig({
      security: { bots: { likelyAutomated: 'challenge', turnstile: { siteKey: '0x4AAAA' } } },
    });
    const env = {
      HYPDRIV_SESSION_SECRET: 'a-very-long-session-secret-value-123',
      TURNSTILE_SECRET_KEY: 'ts-secret',
    };
    const verify = vi.fn(async (token: string) => token === 'good');
    const stage = botsStage(config, { turnstileVerify: verify });
    const suspicious = { 'user-agent': CHROME, accept: 'text/html', 'accept-language': 'en' }; // no sec-fetch → likely

    const page = await runStage(
      stage,
      makeCtx({ config, env, headers: suspicious }),
      () => new Response('ok'),
    );
    expect(page.response.status).toBe(403);
    expect(page.response.headers.get('content-type')).toContain('text/html');
    const html = await page.response.text();
    expect(html).toContain('data-sitekey="0x4AAAA"');
    expect(html).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
    expect(page.response.headers.get('content-security-policy')).toContain("'nonce-");

    const bad = await runStage(
      stage,
      makeCtx({ config, env, headers: { ...suspicious, 'cf-turnstile-response': 'bad' } }),
      () => new Response('ok'),
    );
    expect(bad.response.status).toBe(403);

    const ctx = makeCtx({ config, env, headers: { ...suspicious, 'cf-turnstile-response': 'good' } });
    const good = await runStage(stage, ctx, () => new Response('ok'));
    expect(good.shortCircuited).toBe(false);
    expect(verify).toHaveBeenCalledWith('good', ctx.ip);
    const cookie = ctx.responseHeaders.get('set-cookie')!;
    expect(cookie).toMatch(/^hyp_clearance=.*HttpOnly/);
    expect(ctx.state.get(BOT_KEY)?.reason).toBe('challenge-passed');

    // The clearance cookie skips the challenge on the next request.
    const value = decodeURIComponent(/hyp_clearance=([^;]+)/.exec(cookie)![1]!);
    const cleared = makeCtx({ config, env, headers: { ...suspicious, cookie: `hyp_clearance=${value}` } });
    const r = await runStage(stage, cleared, () => new Response('ok'));
    expect(r.shortCircuited).toBe(false);
    expect(cleared.state.get(BOT_KEY)).toEqual({ verdict: 'human', reason: 'clearance' });
    // A different user agent cannot reuse it.
    const stolen = makeCtx({
      config,
      env,
      headers: { ...suspicious, 'user-agent': 'curl/8', cookie: `hyp_clearance=${value}` },
    });
    expect((await runStage(stage, stolen, () => new Response('ok'))).response.status).toBe(403);

    // The challenge page posts the token back and receives the cookie with a 204.
    const resubmit = makeCtx({
      config,
      env,
      method: 'POST',
      headers: { ...suspicious, 'cf-turnstile-response': 'good', 'x-hypdriv-challenge': '1' },
    });
    const r204 = await runStage(stage, resubmit, () => new Response('ok'));
    expect(r204.response.status).toBe(204);
    expect(r204.response.headers.get('set-cookie')).toContain('hyp_clearance=');

    // Form-encoded POST with the token field.
    const form = makeCtx({
      config,
      env,
      method: 'POST',
      headers: { ...suspicious, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'cf-turnstile-response=good&name=x',
    });
    expect((await runStage(stage, form, () => new Response('ok'))).shortCircuited).toBe(false);
  });

  it('challenge without turnstile configuration blocks with a reason', async () => {
    const config = resolveConfig({ security: { bots: { likelyAutomated: 'challenge' } } });
    const ctx = makeCtx({ config, headers: { 'user-agent': CHROME } });
    const { response } = await runStage(botsStage(config), ctx, () => new Response('ok'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden', reason: 'challenge-unavailable' });
  });

  it('is a no-op when bots are disabled', async () => {
    const config = resolveConfig({ security: { bots: false } });
    const ctx = makeCtx({ config, headers: { 'user-agent': 'curl/8', accept: 'text/html' } });
    const { shortCircuited } = await runStage(botsStage(config), ctx, () => new Response('ok'));
    expect(shortCircuited).toBe(false);
    expect(ctx.state.get(BOT_KEY)).toBeUndefined();
  });
});
