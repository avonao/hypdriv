import {
  createContext,
  type FlagDefinition,
  type GeoProperties,
  getSetCookies,
  parseServerTiming,
  resolveConfig,
  runPipeline,
} from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { decodeFlagsHeader } from './encoding';
import { openFeatureProvider, staticProvider } from './providers';
import { detectDevice, FLAG_ID_KEY, FLAG_REASONS_KEY, FLAGS_KEY, flagsStage } from './stage';

const definitions: Record<string, FlagDefinition> = {
  rollout: { default: false, rules: [{ percentage: 50, value: true }] },
  region: { default: 'global', rules: [{ when: { country: ['US'] }, value: 'us' }] },
  secret: { default: 'srv', serverOnly: true },
};

async function run(
  options: {
    url?: string;
    headers?: Record<string, string>;
    cf?: GeoProperties;
    development?: boolean;
    definitions?: Record<string, FlagDefinition>;
    config?: Parameters<typeof resolveConfig>[0];
  } = {},
) {
  const config = resolveConfig(options.config ?? {});
  const request = new Request(options.url ?? 'https://example.com/page', { headers: options.headers });
  const ctx = createContext({
    request,
    config,
    cf: options.cf,
    development: options.development ?? false,
  });
  let forwarded: Request | undefined;
  const stage = flagsStage(config, staticProvider(options.definitions ?? definitions));
  const result = await runPipeline({
    stages: [stage],
    ctx,
    next: async (req) => {
      forwarded = req;
      return new Response('ok');
    },
  });
  return { ctx, response: result.response, forwarded: forwarded! };
}

describe('flagsStage', () => {
  it('evaluates, stores state and forwards the encoded header to Next.js', async () => {
    const { ctx, forwarded } = await run({ cf: { country: 'US' } });
    const values = ctx.state.get(FLAGS_KEY)!;
    expect(values.region).toBe('us');
    expect(typeof values.rollout).toBe('boolean');
    expect(values.secret).toBe('srv');
    expect(ctx.state.get(FLAG_REASONS_KEY)?.region).toBe('rule:0');
    expect(decodeFlagsHeader(forwarded.headers.get('x-hypdriv-flags'))).toEqual(values);
  });

  it('sets the id cookie once when bucketing needs it', async () => {
    const first = await run();
    const cookies = getSetCookies(first.response.headers);
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0]!;
    expect(cookie).toMatch(
      /^hyp_uid=[A-Za-z0-9_-]{16}; Max-Age=31536000; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
    );
    const id = /^hyp_uid=([^;]+)/.exec(cookie)![1]!;

    const second = await run({ headers: { cookie: `hyp_uid=${id}` } });
    expect(getSetCookies(second.response.headers)).toEqual([]);
    expect(second.ctx.state.get(FLAG_ID_KEY)).toBe(id);
    expect(second.ctx.state.get(FLAGS_KEY)?.rollout).toBe(first.ctx.state.get(FLAGS_KEY)?.rollout);
  });

  it('omits Secure on plain http and replaces malformed ids', async () => {
    const { response, ctx } = await run({
      url: 'http://localhost:3000/',
      headers: { cookie: 'hyp_uid=bad' },
    });
    const cookie = getSetCookies(response.headers)[0]!;
    expect(cookie).not.toContain('Secure');
    expect(ctx.state.get(FLAG_ID_KEY)).not.toBe('bad');
  });

  it('does not set a cookie when no definition uses percentages', async () => {
    const { response, ctx } = await run({ definitions: { a: { default: true } } });
    expect(getSetCookies(response.headers)).toEqual([]);
    expect(ctx.state.get(FLAGS_KEY)).toEqual({ a: true });
  });

  it('sets a cookie for remote providers that need a targeting key', async () => {
    const config = resolveConfig({});
    const provider = openFeatureProvider(
      {
        getBooleanValue: async (_k, d) => d,
        getStringValue: async (_k, d) => d,
        getNumberValue: async (_k, d) => d,
      },
      { a: { default: true } },
    );
    const ctx = createContext({ request: new Request('https://e.com/'), config });
    const { response } = await runPipeline({
      stages: [flagsStage(config, provider)],
      ctx,
      next: async () => new Response('ok'),
    });
    expect(getSetCookies(response.headers)).toHaveLength(1);
    expect(ctx.state.get(FLAG_REASONS_KEY)).toEqual({ a: 'openfeature' });
  });

  it('strips spoofed flag headers and clears the header when nothing is defined', async () => {
    const spoofed = { headers: { 'x-hypdriv-flags': btoa('{"secret":"pwned"}') } };
    const { forwarded } = await run(spoofed);
    expect(decodeFlagsHeader(forwarded.headers.get('x-hypdriv-flags')).secret).toBe('srv');
    const empty = await run({ ...spoofed, definitions: {} });
    expect(empty.forwarded.headers.has('x-hypdriv-flags')).toBe(false);
    expect(empty.ctx.state.get(FLAGS_KEY)).toEqual({});
    expect(getSetCookies(empty.response.headers)).toEqual([]);
  });

  it('applies query overrides only in development by default', async () => {
    const url = 'https://example.com/?hyp_flag_region=qa&hyp_flag_rollout=true';
    const prod = await run({ url });
    expect(prod.ctx.state.get(FLAGS_KEY)?.region).toBe('global');
    const dev = await run({ url, development: true });
    expect(dev.ctx.state.get(FLAGS_KEY)).toMatchObject({ region: 'qa', rollout: true });
    expect(dev.ctx.state.get(FLAG_REASONS_KEY)).toMatchObject({ region: 'override', rollout: 'override' });
    const always = await run({ url, config: { flags: { queryOverrides: true } } });
    expect(always.ctx.state.get(FLAGS_KEY)?.region).toBe('qa');
    const never = await run({ url, development: true, config: { flags: { queryOverrides: false } } });
    expect(never.ctx.state.get(FLAGS_KEY)?.region).toBe('global');
  });

  it('honours custom cookie and header names', async () => {
    const { response, forwarded } = await run({
      config: { flags: { idCookie: 'my_id', header: 'x-my-flags' } },
    });
    expect(getSetCookies(response.headers)[0]).toMatch(/^my_id=/);
    expect(forwarded.headers.has('x-my-flags')).toBe(true);
    expect(forwarded.headers.has('x-hypdriv-flags')).toBe(false);
  });

  it('annotates the flags Server-Timing entry with the count and keeps the duration', async () => {
    const { ctx } = await run();
    const entries = parseServerTiming(ctx.timings.toHeader('verbose'));
    const flags = entries.find((e) => e.name === 'flags');
    expect(flags?.desc).toBe('3');
    expect(typeof flags?.dur).toBe('number');
  });

  it('is skipped for Next internals and runs for RSC requests', async () => {
    const internal = await run({ url: 'https://example.com/_next/static/x.js' });
    expect(internal.ctx.state.has(FLAGS_KEY)).toBe(false);
    const rsc = await run({ headers: { rsc: '1' } });
    expect(rsc.ctx.state.has(FLAGS_KEY)).toBe(true);
  });
});

describe('detectDevice', () => {
  it('classifies from client hints and user agents', () => {
    expect(detectDevice(new Headers({ 'sec-ch-ua-mobile': '?1' }))).toBe('mobile');
    expect(
      detectDevice(new Headers({ 'sec-ch-ua-mobile': '?0', 'user-agent': 'Mozilla/5.0 (iPhone)' })),
    ).toBe('desktop');
    expect(
      detectDevice(new Headers({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148' })),
    ).toBe('mobile');
    expect(
      detectDevice(new Headers({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' })),
    ).toBe('desktop');
    expect(
      detectDevice(new Headers({ 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' })),
    ).toBe('bot');
    expect(detectDevice(new Headers({ 'sec-ch-ua-mobile': '?1', 'user-agent': 'HeadlessChrome' }))).toBe(
      'bot',
    );
    expect(detectDevice(new Headers())).toBe('desktop');
  });
});
