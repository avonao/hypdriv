import { describe, expect, it } from 'vitest';
import {
  experimentControl,
  experimentTag,
  parseExperimentCookie,
  runningExperiments,
  serializeExperimentCookie,
  variantFromTag,
} from './experiments';

describe('experiment cookie', () => {
  it('round-trips memberships, sorted by name', () => {
    const value = serializeExperimentCookie({
      hero: { variant: 'b', exposed: true },
      checkout: { variant: 'control', exposed: false },
    });
    expect(value).toBe('checkout:control.hero:b*');
    expect(parseExperimentCookie(value)).toEqual({
      checkout: { variant: 'control', exposed: false },
      hero: { variant: 'b', exposed: true },
    });
  });

  it('drops malformed entries and keeps the first of a repeated name', () => {
    expect(parseExperimentCookie('a:b.:x.c.d:e:f.g:h:i.ok:y*.a:z')).toEqual({
      a: { variant: 'b', exposed: false },
      ok: { variant: 'y', exposed: true },
    });
    expect(parseExperimentCookie('bad name:x.fine:v')).toEqual({ fine: { variant: 'v', exposed: false } });
    expect(parseExperimentCookie(undefined)).toEqual({});
    expect(parseExperimentCookie('')).toEqual({});
    expect(parseExperimentCookie('a:b'.repeat(2000))).toEqual({});
  });

  it('bounds what it writes', () => {
    const many: Record<string, { variant: string; exposed: boolean }> = {};
    for (let i = 0; i < 60; i++) many[`exp${String(i).padStart(2, '0')}`] = { variant: 'v', exposed: true };
    const value = serializeExperimentCookie(many);
    expect(Object.keys(parseExperimentCookie(value))).toHaveLength(24);
    expect(value.length).toBeLessThanOrEqual(1800);
    expect(serializeExperimentCookie({ 'bad name': { variant: 'v', exposed: false } })).toBe('');
    expect(serializeExperimentCookie({})).toBe('');
  });
});

describe('experiment tag', () => {
  it('delimits both ends so one variant is an exact match', () => {
    const tag = experimentTag({
      hero: { variant: 'b', exposed: true },
      checkout: { variant: 'a', exposed: false },
    });
    expect(tag).toBe('|checkout:a|hero:b|');
    expect(tag).toContain('|hero:b|');
    expect(tag).not.toContain('|hero:a|');
    expect(experimentTag({})).toBe('');
  });

  it('reads a variant back out', () => {
    expect(variantFromTag('|checkout:a|hero:b|', 'hero')).toBe('b');
    expect(variantFromTag('|checkout:a|hero:b|', 'checkout')).toBe('a');
    expect(variantFromTag('|checkout:a|', 'hero')).toBeUndefined();
    expect(variantFromTag('|superhero:b|', 'hero')).toBeUndefined();
    expect(variantFromTag('', 'hero')).toBeUndefined();
    expect(variantFromTag(undefined, 'hero')).toBeUndefined();
  });
});

describe('experimentControl', () => {
  it('is the default when it names a variant, else the first variant', () => {
    expect(experimentControl({ default: 'b' }, { variants: { a: 1, b: 1 } })).toBe('b');
    expect(experimentControl({ default: 'zzz' }, { variants: { a: 1, b: 1 } })).toBe('a');
    expect(experimentControl({ default: true }, { variants: { a: 1, b: 1 } })).toBe('a');
    // `Object.hasOwn`: inherited property names are not variants.
    expect(experimentControl({ default: 'toString' }, { variants: { a: 1, b: 1 } })).toBe('a');
  });
});

describe('runningExperiments', () => {
  it('lists the experiments that still assign, sorted, leaving plain flags and concluded ones out', () => {
    expect(
      runningExperiments({
        zeta: { experiment: {} },
        alpha: { experiment: { status: 'running' } },
        paused: { experiment: { status: 'paused' } },
        done: { experiment: { status: 'concluded' } },
        plain: {},
      }),
    ).toEqual(['alpha', 'paused', 'zeta']);
    expect(runningExperiments({})).toEqual([]);
  });
});
