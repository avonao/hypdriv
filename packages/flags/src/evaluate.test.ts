import type { FlagDefinition } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { decodeFlagsHeader, encodeFlagsHeader, flagsFromHeaders } from './encoding';
import {
  coerceFlagValue,
  evaluateFlag,
  evaluateFlags,
  type FlagEvalInput,
  flagType,
  needsStableId,
  parseQueryOverrides,
  publicFlags,
} from './evaluate';

function input(
  partial: Partial<FlagEvalInput> & { definitions: Record<string, FlagDefinition> },
): FlagEvalInput {
  return {
    stableId: 'visitor-1234',
    url: new URL('https://example.com/'),
    headers: new Headers(),
    cookies: {},
    ...partial,
  };
}

describe('evaluateFlags: rules', () => {
  it('returns defaults with reason default when no rule matches', () => {
    const r = evaluateFlags(
      input({ definitions: { a: { default: false }, b: { default: 'x' }, c: { default: 3 } } }),
    );
    expect(r.values).toEqual({ a: false, b: 'x', c: 3 });
    expect(r.reasons).toEqual({ a: 'default', b: 'default', c: 'default' });
  });

  it('first matching rule wins and is reported by index', () => {
    const definitions: Record<string, FlagDefinition> = {
      banner: {
        default: 'none',
        rules: [
          { when: { country: ['de'] }, value: 'eu' },
          { when: { country: ['US', 'CA'] }, value: 'na' },
          { when: { continent: ['EU'] }, value: 'eu-generic' },
        ],
      },
    };
    expect(evaluateFlags(input({ definitions, geo: { country: 'US' } }))).toEqual({
      values: { banner: 'na' },
      reasons: { banner: 'rule:1' },
      experiments: {},
    });
    expect(evaluateFlags(input({ definitions, geo: { country: 'DE', continent: 'EU' } })).values.banner).toBe(
      'eu',
    );
    expect(evaluateFlags(input({ definitions, geo: { country: 'FR', continent: 'EU' } })).values.banner).toBe(
      'eu-generic',
    );
    expect(evaluateFlags(input({ definitions })).reasons.banner).toBe('default');
  });

  it('matches path patterns through core matchesAny', () => {
    const definitions = {
      x: { default: false, rules: [{ when: { path: ['/blog/**', '/docs/:slug'] }, value: true }] },
    };
    expect(evaluateFlags(input({ definitions, url: new URL('https://e.com/blog/a/b') })).values.x).toBe(true);
    expect(evaluateFlags(input({ definitions, url: new URL('https://e.com/docs/intro') })).values.x).toBe(
      true,
    );
    expect(evaluateFlags(input({ definitions, url: new URL('https://e.com/docs/a/b') })).values.x).toBe(
      false,
    );
  });

  it('matches cookies and headers by equality or list membership', () => {
    const definitions = {
      beta: {
        default: false,
        rules: [
          { when: { cookie: { tier: ['gold', 'platinum'] }, header: { 'x-tenant': 'acme' } }, value: true },
        ],
      },
    };
    const headers = new Headers({ 'X-Tenant': ' acme ' });
    expect(evaluateFlags(input({ definitions, cookies: { tier: 'gold' }, headers })).values.beta).toBe(true);
    expect(evaluateFlags(input({ definitions, cookies: { tier: 'silver' }, headers })).values.beta).toBe(
      false,
    );
    expect(evaluateFlags(input({ definitions, cookies: { tier: 'gold' } })).values.beta).toBe(false);
  });

  it('matches device class', () => {
    const definitions = {
      m: { default: 'desktop', rules: [{ when: { device: 'mobile' as const }, value: 'mobile' }] },
    };
    expect(evaluateFlags(input({ definitions, device: 'mobile' })).values.m).toBe('mobile');
    expect(evaluateFlags(input({ definitions, device: 'bot' })).values.m).toBe('desktop');
    expect(evaluateFlags(input({ definitions })).values.m).toBe('desktop');
  });

  it('honours from/until windows against now', () => {
    const definitions = {
      sale: {
        default: false,
        rules: [{ when: { from: '2026-11-27T00:00:00Z', until: '2026-11-30T00:00:00Z' }, value: true }],
      },
      broken: { default: false, rules: [{ when: { from: 'not-a-date' }, value: true }] },
    };
    const at = (iso: string) => evaluateFlags(input({ definitions, now: new Date(iso) })).values;
    expect(at('2026-11-26T23:59:59Z').sale).toBe(false);
    expect(at('2026-11-27T00:00:00Z').sale).toBe(true);
    expect(at('2026-11-29T23:59:59Z').sale).toBe(true);
    expect(at('2026-11-30T00:00:00Z').sale).toBe(false);
    expect(at('2026-11-28T00:00:00Z').broken).toBe(false);
  });

  it('requires every condition of a rule to hold', () => {
    const definitions = {
      x: { default: false, rules: [{ when: { country: ['US'], device: 'mobile' as const }, value: true }] },
    };
    expect(evaluateFlags(input({ definitions, geo: { country: 'US' }, device: 'desktop' })).values.x).toBe(
      false,
    );
    expect(evaluateFlags(input({ definitions, geo: { country: 'US' }, device: 'mobile' })).values.x).toBe(
      true,
    );
  });
});

describe('evaluateFlags: percentage', () => {
  const definitions = { rollout: { default: false, rules: [{ percentage: 30, value: true }] } };

  it('is deterministic per stable id and flag name', () => {
    const a = evaluateFlags(input({ definitions, stableId: 'user-a' }));
    for (let i = 0; i < 20; i++) {
      expect(evaluateFlags(input({ definitions, stableId: 'user-a' }))).toEqual(a);
    }
    // Different flag names bucket independently.
    const two = {
      one: { default: false, rules: [{ percentage: 50, value: true }] },
      two: { default: false, rules: [{ percentage: 50, value: true }] },
    };
    let differ = 0;
    for (let i = 0; i < 200; i++) {
      const r = evaluateFlags(input({ definitions: two, stableId: `id-${i}` })).values;
      if (r.one !== r.two) differ++;
    }
    expect(differ).toBeGreaterThan(50);
  });

  it('distributes close to the configured percentage', () => {
    let on = 0;
    const total = 10000;
    for (let i = 0; i < total; i++) {
      if (evaluateFlags(input({ definitions, stableId: `visitor-${i}` })).values.rollout) on++;
    }
    const share = (on / total) * 100;
    expect(share).toBeGreaterThan(27);
    expect(share).toBeLessThan(33);
  });

  it('reports percentage-miss when the only matching rule excluded the visitor', () => {
    const results = new Set<string>();
    for (let i = 0; i < 50; i++)
      results.add(evaluateFlags(input({ definitions, stableId: `v${i}` })).reasons.rollout!);
    expect(results).toEqual(new Set(['rule:0', 'percentage-miss:0']));
  });

  it('treats 0% as never and 100% as always', () => {
    const defs = {
      never: { default: 'a', rules: [{ percentage: 0, value: 'b' }] },
      always: { default: 'a', rules: [{ percentage: 100, value: 'b' }] },
    };
    for (let i = 0; i < 100; i++) {
      const r = evaluateFlags(input({ definitions: defs, stableId: `id${i}` }));
      expect(r.values).toEqual({ never: 'a', always: 'b' });
      expect(r.reasons.never).toBe('percentage-miss:0');
    }
  });

  it('is a subset relationship: raising the percentage keeps existing members', () => {
    const at30 = new Set<number>();
    const at60 = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const d30 = { f: { default: false, rules: [{ percentage: 30, value: true }] } };
      const d60 = { f: { default: false, rules: [{ percentage: 60, value: true }] } };
      if (evaluateFlags(input({ definitions: d30, stableId: `u${i}` })).values.f) at30.add(i);
      if (evaluateFlags(input({ definitions: d60, stableId: `u${i}` })).values.f) at60.add(i);
    }
    for (const id of at30) expect(at60.has(id)).toBe(true);
  });

  it('combines conditions and percentage', () => {
    const defs = {
      f: { default: false, rules: [{ when: { country: ['US'] }, percentage: 100, value: true }] },
    };
    expect(evaluateFlags(input({ definitions: defs, geo: { country: 'US' } })).values.f).toBe(true);
    expect(evaluateFlags(input({ definitions: defs, geo: { country: 'DE' } })).reasons.f).toBe('default');
  });
});

describe('evaluateFlags: dependencies', () => {
  it('resolves flag dependencies lazily regardless of definition order', () => {
    const definitions: Record<string, FlagDefinition> = {
      child: { default: 'off', rules: [{ when: { flag: { parent: true } }, value: 'on' }] },
      parent: { default: false, rules: [{ when: { country: ['US'] }, value: true }] },
    };
    expect(evaluateFlags(input({ definitions, geo: { country: 'US' } })).values).toEqual({
      child: 'on',
      parent: true,
    });
    expect(evaluateFlags(input({ definitions, geo: { country: 'DE' } })).values).toEqual({
      child: 'off',
      parent: false,
    });
  });

  it('never matches a circular dependency and still terminates', () => {
    const definitions: Record<string, FlagDefinition> = {
      a: { default: false, rules: [{ when: { flag: { b: true } }, value: true }] },
      b: { default: false, rules: [{ when: { flag: { a: true } }, value: true }] },
      self: { default: 1, rules: [{ when: { flag: { self: 2 } }, value: 2 }] },
    };
    const r = evaluateFlags(input({ definitions }));
    expect(r.values).toEqual({ a: false, b: false, self: 1 });
    expect(r.reasons).toEqual({ a: 'default', b: 'default', self: 'default' });
  });

  it('fails the condition for unknown dependencies and mismatched types', () => {
    const definitions: Record<string, FlagDefinition> = {
      x: { default: false, rules: [{ when: { flag: { missing: true } }, value: true }] },
      y: { default: false, rules: [{ when: { flag: { n: '1' } }, value: true }] },
      n: { default: 1 },
    };
    expect(evaluateFlags(input({ definitions })).values).toEqual({ x: false, y: false, n: 1 });
  });
});

describe('evaluateFlags: overrides', () => {
  const definitions: Record<string, FlagDefinition> = {
    bool: { default: false, rules: [{ percentage: 100, value: true }] },
    str: { default: 'a' },
    num: { default: 1 },
    hidden: { default: 'secret', serverOnly: true },
  };

  it('override wins over rules and defaults with reason override', () => {
    const r = evaluateFlags(input({ definitions, overrides: { bool: false, str: 'z', num: 9 } }));
    expect(r.values).toMatchObject({ bool: false, str: 'z', num: 9 });
    expect(r.reasons).toMatchObject({ bool: 'override', str: 'override', num: 'override' });
  });

  it('coerces string overrides to the definition type and ignores impossible ones', () => {
    const r = evaluateFlags(input({ definitions, overrides: { bool: 'false', num: '42', str: 7 } }));
    expect(r.values).toMatchObject({ bool: false, num: 42, str: '7' });
    const bad = evaluateFlags(input({ definitions, overrides: { bool: 'maybe', num: 'NaN' } }));
    expect(bad.values.bool).toBe(true);
    expect(bad.reasons.bool).toBe('rule:0');
    expect(bad.values.num).toBe(1);
  });

  it('ignores overrides for undefined flags', () => {
    const r = evaluateFlags(input({ definitions, overrides: { unknown: true } }));
    expect(r.values).not.toHaveProperty('unknown');
  });

  it('parses hyp_flag_ query overrides for known flags only', () => {
    const url = new URL('https://e.com/?hyp_flag_bool=true&hyp_flag_num=3&hyp_flag_nope=1&other=1');
    expect(parseQueryOverrides(url, definitions)).toEqual({ bool: 'true', num: '3' });
  });

  it('publicFlags drops serverOnly flags', () => {
    const { values } = evaluateFlags(input({ definitions }));
    expect(publicFlags(values, definitions)).toEqual({ bool: true, str: 'a', num: 1 });
  });
});

describe('helpers', () => {
  it('flagType and coerceFlagValue', () => {
    expect(flagType({ default: true })).toBe('boolean');
    expect(flagType({ default: 2 })).toBe('number');
    expect(flagType({ default: 'x' })).toBe('string');
    expect(coerceFlagValue('on', 'boolean')).toBe(true);
    expect(coerceFlagValue('0', 'boolean')).toBe(false);
    expect(coerceFlagValue(1, 'boolean')).toBe(true);
    expect(coerceFlagValue('1.5', 'number')).toBe(1.5);
    expect(coerceFlagValue('', 'number')).toBeUndefined();
    expect(coerceFlagValue(true, 'number')).toBe(1);
    expect(coerceFlagValue(true, 'string')).toBe('true');
    expect(coerceFlagValue({}, 'string')).toBeUndefined();
  });

  it('needsStableId detects percentage rules', () => {
    expect(needsStableId({ a: { default: false } })).toBe(false);
    expect(needsStableId({ a: { default: false, rules: [{ percentage: 5, value: true }] } })).toBe(true);
  });

  it('evaluateFlag returns a single value or null', () => {
    const definitions = { a: { default: 'x' } };
    expect(evaluateFlag('a', input({ definitions }))).toEqual({ value: 'x', reason: 'default' });
    expect(evaluateFlag('zzz', input({ definitions }))).toBeNull();
  });
});

describe('header encoding', () => {
  it('round-trips with sorted keys', () => {
    const encoded = encodeFlagsHeader({ b: 'two', a: true, c: 3 });
    expect(encoded).toBe(encodeFlagsHeader({ c: 3, a: true, b: 'two' }));
    expect(/^[A-Za-z0-9_-]+$/.test(encoded)).toBe(true);
    expect(decodeFlagsHeader(encoded)).toEqual({ a: true, b: 'two', c: 3 });
  });

  it('is tolerant of garbage, raw JSON, padding and non-flag values', () => {
    expect(decodeFlagsHeader(null)).toEqual({});
    expect(decodeFlagsHeader('')).toEqual({});
    expect(decodeFlagsHeader('%%%')).toEqual({});
    expect(decodeFlagsHeader('{"a":true,"b":{"nested":1},"c":null}')).toEqual({ a: true });
    expect(decodeFlagsHeader(btoa('{"n":2}'))).toEqual({ n: 2 });
    expect(decodeFlagsHeader(btoa('[1,2]'))).toEqual({});
    expect(encodeFlagsHeader({ ok: 1, bad: Number.NaN })).toBe(encodeFlagsHeader({ ok: 1 }));
  });

  it('flagsFromHeaders reads the default header name', () => {
    const headers = new Headers({ 'x-hypdriv-flags': encodeFlagsHeader({ a: 'b' }) });
    expect(flagsFromHeaders(headers)).toEqual({ a: 'b' });
    expect(flagsFromHeaders(new Headers())).toEqual({});
  });
});
