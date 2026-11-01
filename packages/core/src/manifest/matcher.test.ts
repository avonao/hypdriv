import { describe, expect, it, vi } from 'vitest';
import { createRouteMatcher, routePatternToRegex } from './matcher';
import type { HypRoute } from './types';

function route(pathname: string, partial: Partial<HypRoute> = {}): HypRoute {
  return {
    id: `app:${pathname}`,
    pathname,
    regex: routePatternToRegex(pathname),
    kind: 'app-page',
    classification: 'dynamic',
    runtime: 'nodejs',
    dynamic: /\[/.test(pathname),
    assets: { js: [], css: [], fonts: [] },
    ...partial,
  };
}

const matcherFor = (...routes: HypRoute[]) =>
  createRouteMatcher({ routes, basePath: '', trailingSlash: false });

describe('routePatternToRegex', () => {
  it('gives every capture group a distinct name', () => {
    expect(() => new RegExp(routePatternToRegex('/a/[x]/b/[x]'))).not.toThrow();
    const match = matcherFor(route('/a/[x]/b/[x]')).match('/a/1/b/2');
    expect(match?.params).toEqual({ x: '1', x_2: '2' });
  });

  it('keeps names apart that only differ in characters a group name cannot hold', () => {
    const match = matcherFor(route('/[a-b]/[a_b]/[a.b]')).match('/1/2/3');
    expect(match?.params).toEqual({ a_b: '1', a_b_2: '2', a_b_3: '3' });
  });

  it('turns a leading digit into a legal name', () => {
    expect(() => new RegExp(routePatternToRegex('/[1]/[...2]'))).not.toThrow();
    expect(matcherFor(route('/[1]/[...2]')).match('/a/b/c')?.params).toEqual({ _1: 'a', _2: 'b/c' });
  });

  it('still matches optional and catch-all segments', () => {
    const optional = matcherFor(route('/docs/[[...slug]]'));
    expect(optional.match('/docs')?.params).toEqual({});
    expect(optional.match('/docs/a/b')?.params).toEqual({ slug: 'a/b' });
  });
});

describe('createRouteMatcher with routes that cannot compile', () => {
  it('falls back to the expression derived from the pattern when the stored one is invalid', () => {
    const onInvalidRoute = vi.fn();
    const matcher = createRouteMatcher(
      { routes: [route('/p/[id]', { regex: '(' })], basePath: '', trailingSlash: false },
      { onInvalidRoute },
    );
    expect(matcher.match('/p/7')?.params).toEqual({ id: '7' });
    expect(onInvalidRoute).not.toHaveBeenCalled();
  });

  it('skips a route nobody can compile, reports it and keeps matching the others', () => {
    const broken = route('/broken/[id]', { regex: '(' });
    Object.defineProperty(broken, 'pathname', {
      get() {
        throw new Error('no pattern');
      },
    });
    const onInvalidRoute = vi.fn();
    const matcher = createRouteMatcher(
      { routes: [broken, route('/ok/[id]')], basePath: '', trailingSlash: false },
      { onInvalidRoute },
    );
    expect(matcher.match('/ok/1')?.params).toEqual({ id: '1' });
    expect(matcher.match('/broken/1')).toBeNull();
    expect(onInvalidRoute).toHaveBeenCalledTimes(1);
    expect(onInvalidRoute.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it('does not throw without a callback', () => {
    const broken = route('/broken/[id]', { regex: '(' });
    Object.defineProperty(broken, 'pathname', {
      get() {
        throw new Error('no pattern');
      },
    });
    expect(() => matcherFor(broken, route('/ok/[id]'))).not.toThrow();
  });
});
