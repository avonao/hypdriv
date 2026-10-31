import { firstMatch, isResolvedConfig, loadConfig, matchesAny } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import {
  dataRedirect,
  dataRequestVariants,
  isDataRequest,
  redirectsWithData,
  withDataRequests,
  withDataVariants,
} from './data-requests';

describe('data request spellings', () => {
  it('derives the data-request variants of a pattern', () => {
    expect(dataRequestVariants('/login')).toEqual(['/login.data', '/login/_.data']);
    expect(dataRequestVariants('/login/')).toEqual(['/login.data', '/login/_.data']);
    expect(dataRequestVariants('/')).toEqual(['/_root.data', '/_.data']);
    expect(dataRequestVariants('/account/**')).toEqual(['/account.data']);
    expect(dataRequestVariants('/**')).toEqual([]);
    expect(dataRequestVariants('/files/*')).toEqual([]);
    expect(dataRequestVariants('/blog/:slug')).toEqual(['/blog/:slug.data', '/blog/:slug/_.data']);
    expect(dataRequestVariants('^/raw$')).toEqual([]);
    expect(dataRequestVariants('/search\\?q=*')).toEqual([]);
  });

  it('extends patterns so rules match React Router data requests', () => {
    const extended = withDataVariants(['/login', /^\/x$/]);
    expect(matchesAny(extended, '/login.data')).toBe(true);
    expect(matchesAny(extended, '/login/_.data')).toBe(true);
    expect(matchesAny(withDataVariants('/blog/:slug'), '/blog/hello.data')).toBe(true);
    expect(matchesAny(withDataVariants('/account/**'), '/account.data')).toBe(true);
    expect(matchesAny(withDataVariants('/account/**'), '/account/settings.data')).toBe(true);
    expect(withDataVariants('/files/*')).toBe('/files/*');
    expect(withDataVariants(undefined)).toBeUndefined();
  });

  it('extends redirect rules with their data sources', () => {
    const rules = redirectsWithData([
      { from: '/old', to: '/new' },
      { from: '/blog/:slug', to: '/posts/:slug' },
      { from: '/legacy/**', to: '/' },
      { from: '/', to: '/home' },
    ]);
    expect(rules.map((r) => r.from)).toEqual([
      '/old',
      '/blog/:slug',
      '/legacy/**',
      '/',
      '/old.data',
      '/blog/:slug.data',
      '/_root.data',
    ]);
    expect(rules.find((r) => r.from === '/blog/:slug.data')?.to).toBe('/posts/:slug');
  });
});

describe('withDataRequests', () => {
  const input = {
    security: {
      rateLimit: [{ id: 'login', match: '/login', limit: 5, window: '1m' as const }],
      csrf: { match: '/forms/**', exempt: '/hooks/stripe' },
      maxBody: [{ match: '/upload', limit: '5mb' }],
      bots: { exempt: ['/status'] },
    },
    maintenance: { bypassPaths: ['/status'] },
    redirects: { rules: [{ from: '/old', to: '/new' }] },
  };

  it('extends the gating rules of hypdriv.config input', () => {
    const out = withDataRequests(input);
    expect(out.security.rateLimit[0]!.match).toEqual(['/login', '/login.data', '/login/_.data']);
    expect(out.security.csrf).toMatchObject({ match: ['/forms/**', '/forms.data'] });
    expect((out.security.csrf as unknown as { exempt: string[] }).exempt).toContain('/hooks/stripe.data');
    expect(out.security.maxBody[0]!.match).toContain('/upload.data');
    expect(out.security.bots.exempt).toContain('/status.data');
    expect(out.maintenance.bypassPaths).toContain('/status.data');
    expect(out.redirects.rules.map((r) => r.from)).toEqual(['/old', '/old.data']);
    // The input is not mutated.
    expect(input.security.rateLimit[0]!.match).toBe('/login');
  });

  it('keeps resolved configs resolved', () => {
    const resolved = loadConfig(input);
    const out = withDataRequests(resolved);
    expect(isResolvedConfig(out)).toBe(true);
    expect(firstMatch(out.security.rateLimit, '/login.data')?.id).toBe('login');
    expect(out.redirects.rules.some((r) => r.from === '/old.data')).toBe(true);
    expect(firstMatch(resolved.security.rateLimit, '/login.data')).toBeUndefined();
  });
});

describe('dataRedirect', () => {
  it('turns redirects of data requests into single-fetch redirects', async () => {
    const req = new Request('https://app.example/old.data');
    const res = dataRedirect(
      req,
      new Response(null, {
        status: 308,
        headers: { location: 'https://app.example/new', 'x-request-id': 'r1' },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('x-remix-redirect')).toBe('https://app.example/new');
    expect(res.headers.get('x-remix-status')).toBe('308');
    expect(res.headers.get('x-remix-reload-document')).toBe('true');
    expect(res.headers.get('x-request-id')).toBe('r1');
    expect(res.headers.get('location')).toBeNull();
  });

  it('leaves documents and non-redirects alone', () => {
    const redirect = new Response(null, { status: 302, headers: { location: '/x' } });
    expect(dataRedirect(new Request('https://app.example/old'), redirect)).toBe(redirect);
    const ok = new Response('[]', { status: 200 });
    expect(dataRedirect(new Request('https://app.example/a.data'), ok)).toBe(ok);
    expect(isDataRequest(new URL('https://app.example/a.data'))).toBe(true);
    expect(isDataRequest(new Request('https://app.example/a'))).toBe(false);
  });
});
