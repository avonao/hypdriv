import {
  createContext,
  type ExperimentSpec,
  experimentGeneration,
  type FlagDefinition,
  getSetCookies,
  type HypRoute,
  parseExperimentCookie,
  type Runner,
  resolveConfig,
  runPipeline,
} from '@hypdriv/core';
import { describe, expect, it, vi } from 'vitest';
import { evaluateFlags, type FlagEvalInput, parseQueryOverrides } from './evaluate';
import { evaluateExperiment } from './experiments';
import type { ExposureEvent } from './exposure';
import { parseFlagDefinitions, staticProvider } from './providers';
import { EXPERIMENTS_KEY, FLAGS_KEY, flagsStage } from './stage';

const checkout: FlagDefinition = {
  default: 'control',
  experiment: { variants: { control: 50, b: 50 } },
};
const fresh = 'hyp_uid=visitor-000001';
const html = () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } });
const marker = () => new Response(null, { headers: { 'x-middleware-next': '1' } });

function route(pathname: string, kind: HypRoute['kind'] = 'app-page'): { route: HypRoute; params: object } {
  return { route: { id: `app:${pathname}`, pathname, kind } as HypRoute, params: {} };
}

async function visit(
  options: {
    cookie?: string;
    url?: string;
    definitions?: Record<string, FlagDefinition>;
    response?: () => Response;
    headers?: Record<string, string>;
    runner?: Runner;
    route?: ReturnType<typeof route> | null;
    config?: Parameters<typeof resolveConfig>[0];
  } = {},
) {
  const config = resolveConfig(options.config ?? {});
  const exposures: ExposureEvent[] = [];
  const request = new Request(options.url ?? 'https://example.com/cart', {
    headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
  });
  const ctx = createContext({
    request,
    config,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.route !== undefined ? { route: options.route as never } : {}),
  });
  const warn = vi.fn();
  ctx.log = { ...ctx.log, warn } as typeof ctx.log;
  const result = await runPipeline({
    stages: [
      flagsStage(config, staticProvider(options.definitions ?? { checkout }), {
        onExposure: (event) => void exposures.push(event),
      }),
    ],
    ctx,
    next: async () => (options.response ?? html)(),
  });
  await Promise.resolve();
  await Promise.resolve();
  const cookies = getSetCookies(result.response.headers);
  return {
    ctx,
    warn,
    exposures,
    cookies,
    experimentCookie: cookies.find((c) => c.startsWith('hyp_exp=')),
    idCookie: cookies.find((c) => c.startsWith('hyp_uid=')),
  };
}

describe('exposures under proxy.ts (finding 1)', () => {
  it('counts a page view that only shows Next’s pass-through marker', async () => {
    const result = await visit({
      cookie: fresh,
      runner: 'proxy',
      response: marker,
      route: route('/cart'),
    });
    expect(result.exposures).toHaveLength(1);
    expect(result.experimentCookie).toMatch(/^hyp_exp=checkout%3A(control|b)\*;/);
  });

  it('counts a client navigation (RSC) behind the marker, but not API routes or prefetches', async () => {
    const rsc = await visit({
      cookie: fresh,
      runner: 'proxy',
      response: marker,
      headers: { rsc: '1' },
      route: route('/cart'),
    });
    expect(rsc.exposures).toHaveLength(1);
    const api = await visit({
      cookie: fresh,
      runner: 'proxy',
      url: 'https://example.com/api/cart',
      response: marker,
      route: route('/api/cart', 'route-handler' as HypRoute['kind']),
    });
    expect(api.exposures).toEqual([]);
    const prefetch = await visit({
      cookie: fresh,
      runner: 'proxy',
      response: marker,
      headers: { 'next-router-prefetch': '1', rsc: '1' },
      route: route('/cart'),
    });
    expect(prefetch.exposures).toEqual([]);
  });
});

describe('requests that are not visitors (finding 2)', () => {
  it('a warm-up request is neither assigned, counted nor given a cookie', async () => {
    for (let i = 0; i < 5; i++) {
      const warm = await visit({ headers: { 'x-hypdriv-warm': '1' } });
      expect(warm.exposures).toEqual([]);
      expect(warm.cookies).toEqual([]);
      expect(warm.ctx.state.get(FLAGS_KEY)!.checkout).toBe('control');
      expect(warm.ctx.state.get(EXPERIMENTS_KEY)!.checkout).toMatchObject({ reason: 'warm', member: false });
    }
  });

  it('a warm-up fills the variant its cookie names, so every cached copy can be warmed', async () => {
    const warm = await visit({ cookie: 'hyp_exp=checkout%3Ab', headers: { 'x-hypdriv-warm': '1' } });
    expect(warm.ctx.state.get(FLAGS_KEY)!.checkout).toBe('b');
    expect(warm.exposures).toEqual([]);
    expect(warm.cookies).toEqual([]);
    const unknown = await visit({
      cookie: 'hyp_exp=checkout%3Anope',
      headers: { 'x-hypdriv-warm': '1' },
    });
    expect(unknown.ctx.state.get(FLAGS_KEY)!.checkout).toBe('control');
  });

  it('a crawler gets the control, no exposure, no assignment and no cookie', async () => {
    const bot = await visit({
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    });
    expect(bot.exposures).toEqual([]);
    expect(bot.cookies).toEqual([]);
    expect(bot.ctx.state.get(FLAGS_KEY)!.checkout).toBe('control');
    expect(bot.ctx.state.get(EXPERIMENTS_KEY)!.checkout?.reason).toBe('bot');
    // Even holding a cookie for the other variant.
    const withCookie = await visit({
      cookie: 'hyp_exp=checkout%3Ab',
      headers: { 'user-agent': 'Googlebot/2.1' },
    });
    expect(withCookie.ctx.state.get(FLAGS_KEY)!.checkout).toBe('control');
  });

  it('follows the bot shield’s verdict and the owner’s audit token', async () => {
    const claims: Array<Record<string, string>> = [
      { 'x-hypdriv-bot': 'likely' },
      { 'x-hypdriv-bot': 'verified' },
      { 'x-hypdriv-audit': 'v1.1.abc' },
    ];
    for (const headers of claims) {
      const result = await visit({ headers });
      expect(result.exposures).toEqual([]);
      expect(result.cookies).toEqual([]);
      expect(result.ctx.state.get(FLAGS_KEY)!.checkout).toBe('control');
    }
    const human = await visit({ cookie: fresh, headers: { 'x-hypdriv-bot': 'human' } });
    expect(human.exposures).toHaveLength(1);
  });
});

describe('audience before anything stored (finding 3)', () => {
  const consent: FlagDefinition = {
    default: 'control',
    experiment: { variants: { control: 1, b: 1 }, when: { cookie: { consent: '1' } } },
  };

  it('a stored assignment cannot bypass the audience: no consent, no variant, no exposure, no cookie', async () => {
    const result = await visit({
      cookie: `${fresh}; hyp_exp=checkout:b*`,
      definitions: { checkout: consent },
    });
    expect(result.ctx.state.get(FLAGS_KEY)!.checkout).toBe('control');
    expect(result.ctx.state.get(EXPERIMENTS_KEY)!.checkout?.reason).toBe('excluded');
    expect(result.exposures).toEqual([]);
    // The membership is removed from the cookie rather than refreshed.
    expect(result.experimentCookie).toMatch(/^hyp_exp=;.*Max-Age=0/);
  });

  it('with consent the stored assignment holds', async () => {
    const result = await visit({
      cookie: `${fresh}; consent=1; hyp_exp=checkout:b*`,
      definitions: { checkout: consent },
    });
    expect(result.ctx.state.get(FLAGS_KEY)!.checkout).toBe('b');
    expect(result.experimentCookie).toBeUndefined();
  });

  it('applies to a paused experiment as well', () => {
    const spec: ExperimentSpec = { ...consent.experiment!, status: 'paused' };
    expect(
      evaluateExperiment('checkout', consent, spec, {
        stableId: 'visitor-000001',
        inAudience: false,
        memberships: { checkout: { variant: 'b', exposed: true } },
      }),
    ).toEqual({ variant: 'control', reason: 'excluded', member: false });
  });
});

describe('salt restarts an experiment (finding 4)', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `visitor-${i.toString(36).padStart(6, '0')}`);
  const salted = (salt: string | undefined): FlagDefinition => ({
    default: 'control',
    experiment: { variants: { control: 50, b: 50 }, ...(salt ? { salt } : {}) },
  });

  function assign(stableId: string, def: FlagDefinition, cookieValue?: string) {
    const input: FlagEvalInput = {
      definitions: { checkout: def },
      stableId,
      url: new URL('https://example.com/'),
      headers: new Headers(),
      cookies: {},
      memberships: parseExperimentCookie(cookieValue),
    };
    return evaluateFlags(input).experiments.checkout!;
  }

  it('voids the stored assignment of the previous salt', async () => {
    const v1 = salted('v1');
    const v2 = salted('v2');
    let moved = 0;
    for (const id of ids) {
      const first = await visit({ cookie: `hyp_uid=${id}`, definitions: { checkout: v1 } });
      const stored = first.experimentCookie!.split(';')[0]!.slice('hyp_exp='.length);
      const cookie = decodeURIComponent(stored);
      expect(cookie).toMatch(/^checkout:(control|b)~[a-z0-9]+\*$/);
      // Same salt: sticky.
      expect(assign(id, v1, cookie).reason).toBe('sticky');
      // New salt: assigned again by the new salt, not kept.
      const after = assign(id, v2, cookie);
      expect(after.reason).toBe('variant');
      if (after.variant !== first.ctx.state.get(FLAGS_KEY)!.checkout) moved++;
    }
    expect(moved / ids.length).toBeGreaterThan(0.35);
  });

  it('counts a visitor again after a restart, and not again while the salt is unchanged', async () => {
    const id = ids[7]!;
    const run1 = await visit({ cookie: `hyp_uid=${id}`, definitions: { checkout: salted('v1') } });
    expect(run1.exposures).toHaveLength(1);
    const cookie1 = decodeURIComponent(run1.experimentCookie!.split(';')[0]!.slice('hyp_exp='.length));
    const again = await visit({
      cookie: `hyp_uid=${id}; hyp_exp=${cookie1}`,
      definitions: { checkout: salted('v1') },
    });
    expect(again.exposures).toEqual([]);
    const restarted = await visit({
      cookie: `hyp_uid=${id}; hyp_exp=${cookie1}`,
      definitions: { checkout: salted('v2') },
    });
    expect(restarted.exposures).toHaveLength(1);
  });

  it('a cookie from before generations existed (no marker) is void once a salt is set, valid without one', () => {
    expect(assign(ids[0]!, salted(undefined), 'checkout:b*').reason).toBe('sticky');
    expect(assign(ids[0]!, salted('v1'), 'checkout:b*').reason).toBe('variant');
  });

  it('changing weights, traffic or adding a variant does not restart', () => {
    const first = assign(ids[3]!, salted('v1'));
    const stored = `checkout:${first.variant}~${experimentGeneration('v1')}`;
    const changed: FlagDefinition = {
      default: 'control',
      experiment: { variants: { control: 1, b: 99, c: 10 }, traffic: 10, salt: 'v1' },
    };
    expect(assign(ids[3]!, changed, stored)).toEqual({
      variant: first.variant,
      reason: 'sticky',
      member: true,
    });
  });
});

describe('exposures are only counted when the cookie can remember them (finding 5)', () => {
  it('remote definitions with an unsafe experiment name are skipped with a warning', () => {
    const invalid: Array<[string, string]> = [];
    const parsed = parseFlagDefinitions(
      {
        'new.checkout': { default: 'control', experiment: { variants: { control: 1, b: 1 } } },
        ok: { default: 'control', experiment: { variants: { control: 1, b: 1 } } },
        broken: { default: 'zzz', experiment: { variants: { control: 1, b: 1 } } },
      },
      (name, reason) => invalid.push([name, reason]),
    )!;
    expect(parsed['new.checkout']?.experiment).toBeUndefined();
    expect(parsed['new.checkout']?.default).toBe('control');
    expect(parsed.ok?.experiment).toBeDefined();
    expect(invalid.map(([name]) => name).sort()).toEqual(['broken', 'new.checkout']);
    expect(invalid[0]![1]).toMatch(/experiment/);
  });

  it('a name the cookie cannot hold is never counted (not once per page view) and is reported once', async () => {
    const definitions = {
      'new.checkout': { default: 'control', experiment: { variants: { control: 1, b: 1 } } },
    } satisfies Record<string, FlagDefinition>;
    for (let view = 0; view < 4; view++) {
      const result = await visit({ cookie: fresh, definitions });
      expect(result.exposures).toEqual([]);
      expect(result.warn).toHaveBeenCalledWith(
        'experiment cannot be remembered in the cookie, so it is not counted',
        expect.objectContaining({ experiment: 'new.checkout' }),
      );
    }
  });

  it('with more experiments than the cookie holds, each one that fits is counted once', async () => {
    const definitions: Record<string, FlagDefinition> = {};
    for (let i = 0; i < 26; i++)
      definitions[`exp${String(i).padStart(2, '0')}`] = {
        default: 'control',
        experiment: { variants: { control: 1, b: 1 } },
      };
    const first = await visit({ cookie: fresh, definitions });
    expect(first.exposures).toHaveLength(24);
    const cookie = decodeURIComponent(first.experimentCookie!.split(';')[0]!.slice('hyp_exp='.length));
    expect(Object.keys(parseExperimentCookie(cookie))).toHaveLength(24);
    const second = await visit({ cookie: `${fresh}; hyp_exp=${cookie}`, definitions });
    // Only the two that never fit are looked at again, and they are never counted.
    expect(second.exposures).toEqual([]);
  });
});

describe('exposure rows carry the route, not the URL (finding 10)', () => {
  it('records the route pattern for a dynamic path', async () => {
    const result = await visit({
      cookie: fresh,
      url: 'https://example.com/reset/s3cr3t-t0ken-123?next=/account',
      route: route('/reset/[token]'),
    });
    expect(result.exposures).toHaveLength(1);
    expect(result.exposures[0]).toMatchObject({ pathname: '/reset/[token]', route: 'app:/reset/[token]' });
    expect(JSON.stringify(result.exposures)).not.toContain('s3cr3t');
  });

  it('records a placeholder when no route matched', async () => {
    const result = await visit({ cookie: fresh, url: 'https://example.com/reset/s3cr3t-t0ken-123' });
    expect(result.exposures[0]?.pathname).toBe('(unmatched)');
    expect(JSON.stringify(result.exposures)).not.toContain('s3cr3t');
  });
});

describe('minor findings (finding 11)', () => {
  it('Firefox X-moz: prefetch and X-Purpose: preview are not page views', async () => {
    const speculative: Array<Record<string, string>> = [{ 'x-moz': 'prefetch' }, { 'x-purpose': 'preview' }];
    for (const headers of speculative) {
      const result = await visit({ cookie: fresh, headers });
      expect(result.exposures).toEqual([]);
    }
  });

  it('inherited property names are neither QA-override targets nor variants', () => {
    const definitions = { checkout };
    expect(parseQueryOverrides(new URL('https://x.test/?hyp_flag_toString=1'), definitions)).toEqual({});
    expect(parseQueryOverrides(new URL('https://x.test/?hyp_flag_checkout=b'), definitions)).toEqual({
      checkout: 'b',
    });
    const parsed = parseFlagDefinitions({
      x: { default: 'toString', experiment: { variants: { a: 1, b: 1 } } },
      y: {
        default: 'a',
        experiment: { variants: { a: 1, b: 1 }, status: 'concluded', winner: 'constructor' },
      },
    })!;
    expect(parsed.x?.experiment).toBeUndefined();
    expect(parsed.y?.experiment?.winner).toBeUndefined();
  });

  it('a cookie entry named __proto__ cannot change what a lookup finds', () => {
    const parsed = parseExperimentCookie('__proto__:b.checkout:b');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(parsed).toEqual({ checkout: { variant: 'b', exposed: false } });
  });
});
