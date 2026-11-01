import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverRoutes,
  isPageExtension,
  mergeRoutes,
  promotePrerendered,
  type QwikBuiltRoute,
  sourcePageOf,
} from './routes';

const built = (
  partial: Partial<QwikBuiltRoute> & Pick<QwikBuiltRoute, 'routeName' | 'ext'>,
): QwikBuiltRoute => ({
  id: `r-${partial.routeName}`,
  filePath: `/app/src/routes${partial.routeName}index${partial.ext}`,
  pathname: partial.routeName,
  ...partial,
});

describe('isPageExtension', () => {
  it('treats components and Markdown as pages, everything else as endpoints', () => {
    for (const ext of ['.tsx', '.jsx', '.md', '.mdx', '.TSX']) expect(isPageExtension(ext)).toBe(true);
    for (const ext of ['.ts', '.js', '.json', '']) expect(isPageExtension(ext)).toBe(false);
  });
});

describe('sourcePageOf', () => {
  it('gives the same forward-slash path whichever way Windows spells the file', () => {
    // Vite's root is posix-style (`C:/proj`); Qwik may hand the route file over with either separator.
    for (const file of ['C:\\proj\\src\\routes\\blog\\index.tsx', 'C:/proj/src/routes/blog/index.tsx'])
      expect(sourcePageOf('C:/proj', file, win32)).toBe('src/routes/blog/index.tsx');
    expect(sourcePageOf('C:\\proj', 'c:/proj/src/routes/index.tsx', win32)).toBe('src/routes/index.tsx');
  });

  it('keeps a backslash in a POSIX file name', () => {
    expect(sourcePageOf('/app', '/app/src/routes/we\\ird/index.tsx', posix)).toBe(
      'src/routes/we\\ird/index.tsx',
    );
    expect(sourcePageOf('/app', '/app/src/routes/index.tsx', posix)).toBe('src/routes/index.tsx');
  });

  it('is what discoverRoutes records, on either platform', () => {
    const windows = discoverRoutes(
      [built({ routeName: '/blog/', ext: '.tsx', filePath: 'C:\\proj\\src\\routes\\blog\\index.tsx' })],
      { root: 'C:/proj', path: win32 },
    );
    expect(windows[0]?.sourcePage).toBe('src/routes/blog/index.tsx');
  });
});

describe('discoverRoutes', () => {
  it('turns Qwik Router routes into Hypdriv routes without the trailing slash', () => {
    const routes = discoverRoutes(
      [
        built({ routeName: '/', ext: '.tsx' }),
        built({ routeName: '/about/', ext: '.tsx' }),
        built({ routeName: '/blog/[slug]/', ext: '.tsx' }),
        built({ routeName: '/docs/[...path]/', ext: '.mdx' }),
        built({ routeName: '/api/hello/', ext: '.ts' }),
      ],
      { root: '/app' },
    );
    expect(routes.map((r) => `${r.kind}:${r.pathname}`)).toEqual([
      'page:/',
      'page:/about',
      'endpoint:/api/hello',
      'page:/blog/[slug]',
      'page:/docs/[...path]',
    ]);
  });

  it('keeps the source file relative to the project and Qwik’s route id', () => {
    const [route] = discoverRoutes([built({ routeName: '/about/', ext: '.tsx', id: 'abc' })], {
      root: '/app',
    });
    expect(route).toMatchObject({
      sourcePage: 'src/routes/about/index.tsx',
      frameworkId: 'abc',
    });
  });

  it('lists a page and an endpoint of one path separately and drops exact duplicates', () => {
    const routes = discoverRoutes(
      [
        built({ routeName: '/feed/', ext: '.tsx' }),
        built({ routeName: '/feed/', ext: '.ts' }),
        built({ routeName: '/feed/', ext: '.tsx', id: 'again' }),
      ],
      { root: '/app' },
    );
    expect(routes.map((r) => `${r.kind}:${r.pathname}`)).toEqual(['endpoint:/feed', 'page:/feed']);
  });

  it('carries Qwik’s own matcher for a parameter next to literal text', () => {
    const partial = built({
      routeName: '/post-[slug]/',
      ext: '.tsx',
      pattern: /^\/post-([^/]+?)\/?$/,
      segments: [
        [
          { content: 'post-', dynamic: false, rest: false },
          { content: 'slug', dynamic: true, rest: false },
        ],
      ],
    });
    const whole = built({
      routeName: '/blog/[slug]/',
      ext: '.tsx',
      pattern: /^\/blog\/([^/]+?)\/?$/,
      segments: [
        [{ content: 'blog', dynamic: false, rest: false }],
        [{ content: 'slug', dynamic: true, rest: false }],
      ],
    });
    const routes = discoverRoutes([partial, whole], { root: '/app' });
    expect(routes.find((r) => r.pathname === '/post-[slug]')?.regex).toBe(partial.pattern?.source);
    expect(routes.find((r) => r.pathname === '/blog/[slug]')?.regex).toBeUndefined();
  });
});

describe('mergeRoutes', () => {
  const discovered = [
    { pathname: '/', kind: 'page' as const },
    { pathname: '/about', kind: 'page' as const },
  ];

  it('returns the discovered routes when there is no option', () => {
    expect(mergeRoutes(discovered, undefined)).toBe(discovered);
  });

  it('adds the routes of the option and lets them win over discovered ones', () => {
    const merged = mergeRoutes(discovered, [
      { pathname: '/about/', kind: 'page', prerendered: true },
      { pathname: '/shop', kind: 'page' },
    ]);
    expect(merged.map((r) => r.pathname).sort()).toEqual(['/', '/about/', '/shop']);
    expect(merged.find((r) => r.pathname === '/about/')?.prerendered).toBe(true);
  });

  it('lets a function decide the final list', () => {
    expect(mergeRoutes(discovered, (list) => list.filter((r) => r.pathname === '/'))).toEqual([
      { pathname: '/', kind: 'page' },
    ]);
  });
});

describe('promotePrerendered', () => {
  const routes = [
    { pathname: '/', kind: 'page' as const, sourcePage: 'src/routes/index.tsx' },
    { pathname: '/about', kind: 'page' as const },
    {
      pathname: '/blog/[slug]',
      kind: 'page' as const,
      sourcePage: 'src/routes/blog/[slug]/index.tsx',
      frameworkId: 'blog',
    },
    { pathname: '/api/hello', kind: 'endpoint' as const },
  ];

  it('gives each prerendered path of a dynamic page route a static route of its own', () => {
    const out = promotePrerendered(routes, ['/', '/about', '/blog/hello', '/blog/qwik']);
    expect(out.map((r) => `${r.kind}:${r.pathname}`)).toEqual([
      'page:/',
      'page:/about',
      'endpoint:/api/hello',
      'page:/blog/[slug]',
      'page:/blog/hello',
      'page:/blog/qwik',
    ]);
    expect(out.find((r) => r.pathname === '/blog/hello')).toEqual({
      pathname: '/blog/hello',
      kind: 'page',
      prerendered: true,
      sourcePage: 'src/routes/blog/[slug]/index.tsx',
      frameworkId: 'blog',
    });
  });

  it('leaves documents of literal routes and documents no route matches to the manifest', () => {
    expect(promotePrerendered(routes, ['/', '/about'])).toBe(routes);
    expect(promotePrerendered(routes, ['/nowhere/at/all'])).toBe(routes);
    expect(promotePrerendered(routes, [])).toBe(routes);
  });

  it('does not treat an endpoint as an owner of a document', () => {
    const only = [{ pathname: '/api/[name]', kind: 'endpoint' as const }];
    expect(promotePrerendered(only, ['/api/a'])).toBe(only);
  });

  it('accepts pathnames with a trailing slash and adds each path once', () => {
    const out = promotePrerendered(routes, ['/blog/hello/', '/blog/hello']);
    expect(out.filter((r) => r.pathname === '/blog/hello')).toHaveLength(1);
  });

  it('matches catch-all routes', () => {
    const docs = [{ pathname: '/docs/[...path]', kind: 'page' as const }];
    const out = promotePrerendered(docs, ['/docs/a/b']);
    expect(out.map((r) => r.pathname)).toEqual(['/docs/[...path]', '/docs/a/b']);
  });
});
