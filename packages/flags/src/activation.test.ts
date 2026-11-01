import {
  type ExperimentMembership,
  experimentGeneration,
  type FlagDefinition,
  parseCookies,
  parseExperimentCookie,
  serializeExperimentCookie,
} from '@hypdriv/core';
import { describe, expect, it, vi } from 'vitest';
import { exposeActivatedPrerender } from './activation';
import type { ExposureEvent } from './exposure';

const definitions: Record<string, FlagDefinition> = {
  checkout: {
    default: 'control',
    experiment: { variants: { control: 1, b: 1 }, expose: ['/checkout/**'] },
  },
  hero: { default: 'a', experiment: { variants: { a: 1, b: 1 } } },
  restarted: { default: 'a', experiment: { variants: { a: 1, b: 1 }, salt: 'v2' } },
  done: { default: 'a', experiment: { variants: { a: 1, b: 1 }, status: 'concluded', winner: 'b' } },
};

function cookieOf(memberships: Record<string, ExperimentMembership>): string {
  return `hyp_exp=${encodeURIComponent(serializeExperimentCookie(memberships))}`;
}

function run(memberships: Record<string, ExperimentMembership>, pathname = '/checkout/pay') {
  const events: ExposureEvent[] = [];
  const setCookie = exposeActivatedPrerender({
    cookieHeader: cookieOf(memberships),
    pathname,
    definitions,
    cookieName: 'hyp_exp',
    route: { id: 'app:/checkout/[step]', pathname: '/checkout/[step]' },
    country: 'US',
    buildId: 'b1',
    secure: true,
    onExposure: (event) => {
      events.push(event);
    },
  });
  return { events, setCookie };
}

const written = (setCookie: string | null) =>
  parseExperimentCookie(parseCookies((setCookie ?? '').split(';')[0]).hyp_exp);

describe('exposeActivatedPrerender', () => {
  it('counts the experiments the opened page exposes, once, and marks them counted', async () => {
    const { events, setCookie } = run({
      checkout: { variant: 'b', exposed: false },
      hero: { variant: 'a', exposed: false },
    });
    await Promise.resolve();
    // `hero` exposes on any page and `checkout` on /checkout/**: both are counted.
    expect(events.map((e) => [e.experiment, e.variant]).sort()).toEqual([
      ['checkout', 'b'],
      ['hero', 'a'],
    ]);
    expect(events[0]).toMatchObject({
      pathname: '/checkout/[step]',
      route: 'app:/checkout/[step]',
      country: 'US',
      buildId: 'b1',
    });
    expect(JSON.stringify(events)).not.toContain('/checkout/pay');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(written(setCookie)).toEqual({
      checkout: { variant: 'b', exposed: true },
      hero: { variant: 'a', exposed: true },
    });
  });

  it('does not count a visitor twice, or a page outside expose, or an experiment that ended or restarted', () => {
    expect(run({ checkout: { variant: 'b', exposed: true } })).toEqual({ events: [], setCookie: null });
    expect(run({ checkout: { variant: 'b', exposed: false } }, '/pricing')).toEqual({
      events: [],
      setCookie: null,
    });
    expect(run({ done: { variant: 'b', exposed: false } }).setCookie).toBeNull();
    // Assigned before the restart: the stored assignment is void.
    expect(run({ restarted: { variant: 'a', exposed: false } }).setCookie).toBeNull();
    const current = run({
      restarted: { variant: 'a', exposed: false, generation: experimentGeneration('v2') },
    });
    expect(current.setCookie).not.toBeNull();
  });

  it('ignores unknown experiments, removed variants and a forged cookie', () => {
    expect(run({ nope: { variant: 'x', exposed: false } }).setCookie).toBeNull();
    expect(run({ checkout: { variant: 'gone', exposed: false } }).setCookie).toBeNull();
    const events: ExposureEvent[] = [];
    for (const cookieHeader of [null, '', 'hyp_exp=', 'hyp_exp=__proto__%3Ax', 'other=1']) {
      expect(
        exposeActivatedPrerender({
          cookieHeader,
          pathname: '/checkout/pay',
          definitions,
          cookieName: 'hyp_exp',
          secure: false,
          onExposure: (event) => {
            events.push(event);
          },
        }),
      ).toBeNull();
    }
    expect(events).toEqual([]);
  });

  it('reports (unmatched) without a route and survives a failing sink', async () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const setCookie = exposeActivatedPrerender({
      cookieHeader: cookieOf({ hero: { variant: 'a', exposed: false } }),
      pathname: '/anything',
      definitions,
      cookieName: 'hyp_exp',
      secure: false,
      onExposure: () => {
        throw new Error('sink down');
      },
      log: log as never,
    });
    expect(setCookie).not.toBeNull();
    expect(setCookie).not.toContain('Secure');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.warn).toHaveBeenCalledWith(
      'experiment exposure failed',
      expect.objectContaining({ experiment: 'hero' }),
    );
  });
});
