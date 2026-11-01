import {
  createContext,
  type ExperimentSpec,
  type FlagDefinition,
  getSetCookies,
  parseCookies,
  parseExperimentCookie,
  resolveConfig,
  runPipeline,
} from '@hypdriv/core';
import { describe, expect, it, vi } from 'vitest';
import { evaluateFlags, type FlagEvalInput, needsStableId } from './evaluate';
import { evaluateExperiment, exposesOn, pickVariant } from './experiments';
import { analyticsEngineExposureSink, type ExposureEvent, logExposureSink } from './exposure';
import { parseFlagDefinitions, staticProvider } from './providers';
import { EXPERIMENTS_KEY, FLAGS_KEY, flagsStage } from './stage';

const checkout: FlagDefinition = {
  default: 'control',
  experiment: { variants: { control: 50, b: 50 } },
};

function input(overrides: Partial<FlagEvalInput> & { stableId: string }): FlagEvalInput {
  return {
    definitions: { checkout },
    url: new URL('https://example.com/cart'),
    headers: new Headers(),
    cookies: {},
    ...overrides,
  };
}

const ids = Array.from({ length: 2000 }, (_, i) => `visitor-${i.toString(36).padStart(6, '0')}`);

describe('pickVariant()', () => {
  it('follows the weights', () => {
    const variants = { a: 1, b: 3 };
    expect(pickVariant(variants, 0)).toBe('a');
    expect(pickVariant(variants, 24.9)).toBe('a');
    expect(pickVariant(variants, 25)).toBe('b');
    expect(pickVariant(variants, 99.99)).toBe('b');
  });

  it('ignores variants without a positive weight', () => {
    expect(pickVariant({ off: 0, on: 1 }, 0)).toBe('on');
    expect(pickVariant({ off: -1, on: 2 }, 99)).toBe('on');
  });
});

describe('evaluateExperiment()', () => {
  const spec = checkout.experiment as ExperimentSpec;
  const run = (stableId: string, extra: Partial<Parameters<typeof evaluateExperiment>[3]> = {}) =>
    evaluateExperiment('checkout', checkout, spec, { stableId, inAudience: true, ...extra });

  it('assigns deterministically and splits close to the weights', () => {
    const counts: Record<string, number> = { control: 0, b: 0 };
    for (const id of ids) {
      const outcome = run(id);
      expect(outcome).toEqual(run(id));
      expect(outcome).toMatchObject({ reason: 'variant', member: true });
      counts[outcome.variant] = (counts[outcome.variant] ?? 0) + 1;
    }
    expect(counts.control! / ids.length).toBeGreaterThan(0.45);
    expect(counts.control! / ids.length).toBeLessThan(0.55);
  });

  it('assigns each experiment independently of the others', () => {
    const other: FlagDefinition = { default: 'control', experiment: { variants: { control: 50, b: 50 } } };
    const both = ids.filter(
      (id) =>
        run(id).variant === 'b' &&
        evaluateExperiment('hero', other, other.experiment!, { stableId: id, inAudience: true }).variant ===
          'b',
    );
    expect(both.length / ids.length).toBeGreaterThan(0.2);
    expect(both.length / ids.length).toBeLessThan(0.3);
  });

  it('a salt restarts the assignment', () => {
    const salted = { ...spec, salt: 'v2' };
    const moved = ids.filter(
      (id) =>
        run(id).variant !==
        evaluateExperiment('checkout', checkout, salted, { stableId: id, inAudience: true }).variant,
    );
    expect(moved.length / ids.length).toBeGreaterThan(0.35);
  });

  it('keeps a sticky variant even when the weights move', () => {
    const heavy: ExperimentSpec = { variants: { control: 1, b: 99 } };
    const stuck = evaluateExperiment('checkout', checkout, heavy, {
      stableId: ids.find((id) => run(id).variant === 'control')!,
      inAudience: true,
      memberships: { checkout: { variant: 'control', exposed: false } },
    });
    expect(stuck).toEqual({ variant: 'control', reason: 'sticky', member: true });
  });

  it('reassigns when the sticky variant no longer exists', () => {
    const outcome = run(ids[0]!, { memberships: { checkout: { variant: 'gone', exposed: true } } });
    expect(outcome.reason).toBe('variant');
  });

  it('puts the traffic holdout and the excluded audience on the control, uncounted', () => {
    const half: ExperimentSpec = { ...spec, traffic: 50 };
    const outcomes = ids.map((id) =>
      evaluateExperiment('checkout', checkout, half, { stableId: id, inAudience: true }),
    );
    const held = outcomes.filter((o) => o.reason === 'holdout');
    expect(held.length / ids.length).toBeGreaterThan(0.45);
    expect(held.length / ids.length).toBeLessThan(0.55);
    expect(held.every((o) => o.variant === 'control' && !o.member)).toBe(true);
    expect(run(ids[0]!, { inAudience: false })).toEqual({
      variant: 'control',
      reason: 'excluded',
      member: false,
    });
  });

  it('paused: members keep their variant, everyone else gets the control', () => {
    const paused: ExperimentSpec = { ...spec, status: 'paused' };
    const member = evaluateExperiment('checkout', checkout, paused, {
      stableId: ids[0]!,
      inAudience: true,
      memberships: { checkout: { variant: 'b', exposed: true } },
    });
    expect(member).toEqual({ variant: 'b', reason: 'sticky', member: true });
    expect(evaluateExperiment('checkout', checkout, paused, { stableId: ids[0]!, inAudience: true })).toEqual(
      { variant: 'control', reason: 'paused', member: false },
    );
  });

  it('concluded: everyone gets the winner, or the control without one', () => {
    const done: ExperimentSpec = { ...spec, status: 'concluded', winner: 'b' };
    const memberships = { checkout: { variant: 'control', exposed: true } };
    expect(
      evaluateExperiment('checkout', checkout, done, { stableId: ids[0]!, inAudience: true, memberships }),
    ).toEqual({ variant: 'b', reason: 'concluded', member: false });
    expect(
      evaluateExperiment(
        'checkout',
        checkout,
        { ...done, winner: undefined },
        { stableId: ids[1]!, inAudience: true },
      ),
    ).toMatchObject({ variant: 'control', reason: 'concluded' });
  });

  it('exposes on every page, or only on the listed paths', () => {
    expect(exposesOn(spec, new URL('https://example.com/anything'))).toBe(true);
    const scoped: ExperimentSpec = { ...spec, expose: ['/cart', '/checkout/**'] };
    expect(exposesOn(scoped, new URL('https://example.com/cart'))).toBe(true);
    expect(exposesOn(scoped, new URL('https://example.com/checkout/pay'))).toBe(true);
    expect(exposesOn(scoped, new URL('https://example.com/blog'))).toBe(false);
  });
});

describe('evaluateFlags() with experiments', () => {
  it('reports the variant as the flag value with an experiment reason', () => {
    const result = evaluateFlags(input({ stableId: ids[3]! }));
    expect(['control', 'b']).toContain(result.values.checkout);
    expect(result.reasons.checkout).toBe('experiment:variant');
    expect(result.experiments.checkout).toMatchObject({ member: true });
  });

  it('forces a variant with a QA override, but only to a variant that exists', () => {
    const forced = evaluateFlags(input({ stableId: ids[3]!, overrides: { checkout: 'b' } }));
    expect(forced.values.checkout).toBe('b');
    expect(forced.reasons.checkout).toBe('override');
    expect(forced.experiments.checkout).toBeUndefined();
    const invalid = evaluateFlags(input({ stableId: ids[3]!, overrides: { checkout: 'nope' } }));
    expect(invalid.reasons.checkout).toBe('experiment:variant');
  });

  it('lets other flags depend on a variant and applies the audience conditions', () => {
    const definitions: Record<string, FlagDefinition> = {
      checkout: {
        default: 'control',
        experiment: { variants: { control: 1, b: 1 }, when: { country: ['US'] } },
      },
      banner: { default: false, rules: [{ when: { flag: { checkout: 'b' } }, value: true }] },
    };
    const us = ids.find(
      (id) =>
        evaluateFlags(input({ definitions, stableId: id, geo: { country: 'US' } })).values.checkout === 'b',
    )!;
    const inside = evaluateFlags(input({ definitions, stableId: us, geo: { country: 'US' } }));
    expect(inside.values).toEqual({ checkout: 'b', banner: true });
    const outside = evaluateFlags(input({ definitions, stableId: us, geo: { country: 'DE' } }));
    expect(outside.values).toEqual({ checkout: 'control', banner: false });
    expect(outside.reasons.checkout).toBe('experiment:excluded');
  });

  it('needs the stable id unless every experiment is concluded', () => {
    expect(needsStableId({ checkout })).toBe(true);
    expect(
      needsStableId({
        checkout: { ...checkout, experiment: { ...checkout.experiment!, status: 'concluded' } },
      }),
    ).toBe(false);
  });
});

describe('parseFlagDefinitions() with experiments', () => {
  it('keeps a valid remote experiment and drops a broken block (the flag stays a plain flag)', () => {
    const parsed = parseFlagDefinitions({
      good: {
        default: 'a',
        experiment: { variants: { a: 1, b: 2 }, traffic: 150, status: 'paused', winner: 'b', expose: ['/x'] },
      },
      noControl: { default: 'zzz', experiment: { variants: { a: 1, b: 1 } } },
      oneVariant: { default: 'a', experiment: { variants: { a: 1 } } },
      badNames: { default: 'a', experiment: { variants: { a: 1, 'b c': 1 } } },
    })!;
    expect(parsed.good?.experiment).toMatchObject({
      traffic: 100,
      status: 'paused',
      winner: 'b',
      expose: ['/x'],
    });
    expect(parsed.noControl?.experiment).toBeUndefined();
    expect(parsed.oneVariant?.experiment).toBeUndefined();
    expect(parsed.badNames?.experiment).toBeUndefined();
  });
});

describe('flagsStage() with experiments', () => {
  const html = () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } });

  async function visit(options: {
    cookie?: string;
    url?: string;
    definitions?: Record<string, FlagDefinition>;
    response?: () => Response;
    headers?: Record<string, string>;
    method?: string;
  }) {
    const config = resolveConfig({});
    const exposures: ExposureEvent[] = [];
    const request = new Request(options.url ?? 'https://example.com/cart', {
      method: options.method ?? 'GET',
      headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
    });
    const ctx = createContext({ request, config });
    const stage = flagsStage(config, staticProvider(options.definitions ?? { checkout }), {
      onExposure: (event) => void exposures.push(event),
    });
    const result = await runPipeline({
      stages: [stage],
      ctx,
      next: async () => (options.response ?? html)(),
    });
    await Promise.resolve();
    await Promise.resolve();
    const cookies = getSetCookies(result.response.headers);
    const experimentCookie = cookies.find((c) => c.startsWith('hyp_exp='));
    return { ctx, response: result.response, exposures, cookies, experimentCookie };
  }

  const fresh = 'hyp_uid=visitor-000001';

  it('assigns a variant, remembers it and reports the exposure once', async () => {
    const first = await visit({ cookie: fresh });
    const variant = first.ctx.state.get(FLAGS_KEY)!.checkout as string;
    expect(first.experimentCookie).toMatch(new RegExp(`^hyp_exp=checkout%3A${variant}\\*;`));
    expect(first.experimentCookie).toMatch(/HttpOnly/);
    expect(first.experimentCookie).toMatch(/SameSite=Lax/);
    expect(first.exposures).toEqual([
      expect.objectContaining({ experiment: 'checkout', variant, pathname: '(unmatched)' }),
    ]);

    const second = await visit({ cookie: `${fresh}; hyp_exp=checkout:${variant}*` });
    expect(second.ctx.state.get(FLAGS_KEY)!.checkout).toBe(variant);
    expect(second.exposures).toEqual([]);
    expect(second.experimentCookie).toBeUndefined();
  });

  it('keeps the stored variant when the weights change', async () => {
    const definitions = {
      checkout: { default: 'control', experiment: { variants: { control: 1, b: 1000 } } },
    };
    const result = await visit({ cookie: `${fresh}; hyp_exp=checkout:control`, definitions });
    expect(result.ctx.state.get(FLAGS_KEY)!.checkout).toBe('control');
    expect(result.ctx.state.get(EXPERIMENTS_KEY)!.checkout?.reason).toBe('sticky');
  });

  it('remembers an assignment made on a non-page request without counting it as an exposure', async () => {
    const api = await visit({
      cookie: fresh,
      url: 'https://example.com/api/cart',
      response: () => Response.json({ ok: true }),
    });
    const variant = api.ctx.state.get(FLAGS_KEY)!.checkout as string;
    expect(api.exposures).toEqual([]);
    expect(api.experimentCookie).toMatch(new RegExp(`^hyp_exp=checkout%3A${variant};`));
    const page = await visit({ cookie: `${fresh}; hyp_exp=checkout:${variant}` });
    expect(page.exposures).toHaveLength(1);
    expect(page.experimentCookie).toMatch(new RegExp(`^hyp_exp=checkout%3A${variant}\\*;`));
  });

  it('does not count prefetches, errors or non-GET requests', async () => {
    const prefetch = await visit({ cookie: fresh, headers: { 'next-router-prefetch': '1', rsc: '1' } });
    expect(prefetch.exposures).toEqual([]);
    const missing = await visit({
      cookie: fresh,
      response: () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }),
    });
    expect(missing.exposures).toEqual([]);
    const post = await visit({ cookie: fresh, method: 'POST' });
    expect(post.exposures).toEqual([]);
  });

  it('counts a client navigation (RSC payload) and honours the expose paths', async () => {
    const definitions = {
      checkout: {
        default: 'control',
        experiment: { variants: { control: 1, b: 1 }, expose: ['/checkout/**'] },
      },
    };
    const elsewhere = await visit({ cookie: fresh, definitions });
    expect(elsewhere.exposures).toEqual([]);
    const rsc = await visit({
      cookie: fresh,
      definitions,
      url: 'https://example.com/checkout/pay',
      headers: { rsc: '1' },
      response: () => new Response('0:[]', { headers: { 'content-type': 'text/x-component' } }),
    });
    expect(rsc.exposures).toHaveLength(1);
  });

  it('does not touch the cookie of a QA override and never exposes it', async () => {
    const result = await visit({
      cookie: `${fresh}; hyp_exp=checkout:control`,
      url: 'https://example.com/cart?hyp_flag_checkout=b',
      response: html,
    });
    // development false → overrides off by default; enable through config instead.
    expect(result.ctx.state.get(FLAGS_KEY)!.checkout).toBe('control');
    const config = resolveConfig({ flags: { queryOverrides: true } });
    const ctx = createContext({
      request: new Request('https://example.com/cart?hyp_flag_checkout=b', {
        headers: { cookie: `${fresh}; hyp_exp=checkout:control*` },
      }),
      config,
    });
    const exposures: ExposureEvent[] = [];
    const out = await runPipeline({
      stages: [
        flagsStage(config, staticProvider({ checkout }), { onExposure: (e) => void exposures.push(e) }),
      ],
      ctx,
      next: async () => html(),
    });
    expect(ctx.state.get(FLAGS_KEY)!.checkout).toBe('b');
    expect(exposures).toEqual([]);
    expect(getSetCookies(out.response.headers).some((c) => c.startsWith('hyp_exp='))).toBe(false);
  });

  it('drops memberships of experiments that ended and clears an empty cookie', async () => {
    const concluded = {
      checkout: {
        default: 'control',
        experiment: { variants: { control: 1, b: 1 }, status: 'concluded' as const, winner: 'b' },
      },
    };
    const result = await visit({ cookie: `${fresh}; hyp_exp=checkout:control*`, definitions: concluded });
    expect(result.ctx.state.get(FLAGS_KEY)!.checkout).toBe('b');
    expect(result.experimentCookie).toMatch(/^hyp_exp=;.*Max-Age=0/);
    expect(result.exposures).toEqual([]);
  });

  it('does not fail the response when the exposure sink throws', async () => {
    const config = resolveConfig({});
    const ctx = createContext({
      request: new Request('https://example.com/cart', { headers: { cookie: fresh } }),
      config,
    });
    const warn = vi.fn();
    ctx.log = { ...ctx.log, warn } as typeof ctx.log;
    const out = await runPipeline({
      stages: [
        flagsStage(config, staticProvider({ checkout }), {
          onExposure: () => {
            throw new Error('sink down');
          },
        }),
      ],
      ctx,
      next: async () => html(),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(out.response.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      'experiment exposure failed',
      expect.objectContaining({ error: 'sink down' }),
    );
  });

  it('forwards the variant like any flag', async () => {
    const config = resolveConfig({});
    const ctx = createContext({
      request: new Request('https://example.com/cart', { headers: { cookie: fresh } }),
      config,
    });
    let forwarded: Request | undefined;
    await runPipeline({
      stages: [flagsStage(config, staticProvider({ checkout }))],
      ctx,
      next: async (request) => {
        forwarded = request;
        return html();
      },
    });
    expect(forwarded?.headers.get(config.flags.header)).toBeTruthy();
    expect(parseExperimentCookie(parseCookies(getSetCookies(new Headers()).join(';')).hyp_exp)).toEqual({});
  });
});

describe('exposure sinks', () => {
  const event: ExposureEvent = {
    experiment: 'checkout',
    variant: 'b',
    pathname: '/cart',
    route: 'app:/cart',
    country: 'US',
    buildId: 'b1',
    ts: 1_800_000_000_000,
  };

  it('writes the Analytics Engine layout the CLI reads', () => {
    const points: unknown[] = [];
    analyticsEngineExposureSink({ writeDataPoint: (p: unknown) => void points.push(p) } as never)(event);
    expect(points).toEqual([
      {
        indexes: ['checkout'],
        blobs: ['experiment.exposure', 'checkout', 'b', '/cart', 'app:/cart', 'US', 'b1'],
        doubles: [1_800_000_000_000],
      },
    ]);
  });

  it('logs one line', () => {
    const info = vi.fn();
    logExposureSink({ info } as never)(event);
    expect(info).toHaveBeenCalledWith(
      'experiment exposure',
      expect.objectContaining({ experiment: 'checkout', variant: 'b' }),
    );
  });
});
