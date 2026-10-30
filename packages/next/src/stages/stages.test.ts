import {
  createContext,
  createRouteMatcher,
  emptyManifest,
  type HypManifest,
  resolveConfig,
  routePatternToRegex,
  runPipeline,
} from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { buildSpeculationRules, speculationScript } from '../shared/speculation';
import { earlyHintsStage } from './early-hints';
import { decodeGeoHeader, GEO_KEY, geoFrom, geoStage } from './geo';
import { i18nStage, LOCALE_KEY, splitLocale } from './i18n';
import { maintenanceStage, renderMaintenancePage } from './maintenance';
import { matchRedirect, redirectsStage } from './redirects';
import { skewStage } from './skew';

const manifest: HypManifest = emptyManifest({
  buildId: 'b1',
  deploymentId: 'dep-2',
  routes: [
    {
      id: 'app:/',
      pathname: '/',
      regex: routePatternToRegex('/'),
      kind: 'app-page',
      classification: 'static',
      runtime: 'nodejs',
      dynamic: false,
      assets: {
        js: ['/_next/static/chunks/a.js', '/_next/static/chunks/b.js'],
        css: ['/_next/static/chunks/a.css'],
        fonts: ['/_next/static/media/f.woff2'],
      },
    },
    {
      id: 'app:/blog/[slug]',
      pathname: '/blog/[slug]',
      regex: routePatternToRegex('/blog/[slug]'),
      kind: 'app-page',
      classification: 'isr',
      runtime: 'nodejs',
      dynamic: true,
      assets: { js: [], css: [], fonts: [] },
    },
  ],
  earlyHints: { 'app:/': ['</_next/static/chunks/a.css>; rel=preload; as=style'] },
  speculation: { graph: { '/': ['/blog', '/pricing', '/logout', '/docs/a'] }, excluded: [] },
});
const matcher = createRouteMatcher(manifest);

function ctxFor(
  url: string,
  init: RequestInit & {
    cf?: Record<string, unknown>;
    config?: ReturnType<typeof resolveConfig>;
    env?: Record<string, unknown>;
    ip?: string;
    development?: boolean;
  } = {},
) {
  const { cf, config, env, ip, development, ...rest } = init;
  const request = new Request(url, rest);
  const ctx = createContext({
    request,
    config: config ?? resolveConfig({}),
    manifest,
    cf,
    env,
    ip,
    development,
    runner: 'test',
  });
  ctx.route = matcher.match(ctx.url.pathname);
  return ctx;
}

const htmlResponse = () =>
  new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('geo', () => {
  it('reads cloudflare cf properties', () => {
    const geo = geoFrom(
      { country: 'DE', city: 'Berlin', colo: 'FRA', latitude: '52.5', asn: 3320, isEUCountry: '1' },
      new Headers(),
    );
    expect(geo).toMatchObject({
      country: 'DE',
      city: 'Berlin',
      colo: 'FRA',
      latitude: 52.5,
      asn: 3320,
      isEU: true,
      source: 'cloudflare',
    });
  });
  it('falls back to headers and detects EU', () => {
    const geo = geoFrom(undefined, new Headers({ 'cf-ipcountry': 'FR' }));
    expect(geo).toMatchObject({ country: 'FR', isEU: true, source: 'headers' });
    expect(geoFrom(undefined, new Headers()).source).toBe('none');
  });
  it('forwards an encoded header to the app', async () => {
    const ctx = ctxFor('https://x.test/', { cf: { country: 'US', region: 'California' } });
    await runPipeline({ stages: [geoStage(ctx.config)], ctx, next: async () => new Response('') });
    expect(ctx.state.get(GEO_KEY)?.country).toBe('US');
    expect(decodeGeoHeader(ctx.requestHeaders.get('x-hypdriv-geo'))?.region).toBe('California');
    expect(ctx.requestHeaders.get('x-hypdriv-country')).toBe('US');
  });
});

describe('i18n', () => {
  const config = resolveConfig({
    i18n: { locales: ['en', 'de', 'fr'], defaultLocale: 'en', geoMap: { CH: 'de' } },
  });
  it('splits locale prefixes', () => {
    expect(splitLocale('/de/about', ['en', 'de'])).toEqual({ locale: 'de', rest: '/about' });
    expect(splitLocale('/about', ['en', 'de'])).toEqual({ locale: null, rest: '/about' });
  });
  it('redirects to the negotiated locale except the default', async () => {
    const ctx = ctxFor('https://x.test/pricing', {
      headers: { 'accept-language': 'de-DE,de;q=0.9' },
      config,
    });
    const { response } = await runPipeline({
      stages: [i18nStage(config)!],
      ctx,
      next: async () => htmlResponse(),
    });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://x.test/de/pricing');
    const en = ctxFor('https://x.test/pricing', { headers: { 'accept-language': 'en-US' }, config });
    const r2 = await runPipeline({ stages: [i18nStage(config)!], ctx: en, next: async () => htmlResponse() });
    expect(r2.response.status).toBe(200);
    expect(r2.response.headers.get('content-language')).toBe('en');
    expect(en.requestHeaders.get('x-hypdriv-locale')).toBe('en');
  });
  it('uses cookie, geo map and path precedence', async () => {
    const byCookie = ctxFor('https://x.test/', {
      headers: { cookie: 'hyp_locale=fr', 'accept-language': 'de' },
      config,
    });
    await runPipeline({ stages: [i18nStage(config)!], ctx: byCookie, next: async () => htmlResponse() });
    expect(byCookie.state.get(LOCALE_KEY)?.source).toBe('cookie');
    const byGeo = ctxFor('https://x.test/', { headers: { 'cf-ipcountry': 'CH' }, config });
    await runPipeline({ stages: [i18nStage(config)!], ctx: byGeo, next: async () => htmlResponse() });
    expect(byGeo.state.get(LOCALE_KEY)).toEqual({ locale: 'de', source: 'geo' });
    const byPath = ctxFor('https://x.test/fr/x', { headers: { 'accept-language': 'de' }, config });
    const r = await runPipeline({
      stages: [i18nStage(config)!],
      ctx: byPath,
      next: async () => htmlResponse(),
    });
    expect(r.response.status).toBe(200);
    expect(byPath.state.get(LOCALE_KEY)?.locale).toBe('fr');
  });
  it('skips api and assets', async () => {
    const ctx = ctxFor('https://x.test/api/x', { headers: { 'accept-language': 'de' }, config });
    const r = await runPipeline({ stages: [i18nStage(config)!], ctx, next: async () => new Response('{}') });
    expect(r.response.status).toBe(200);
  });
});

describe('redirects', () => {
  const rules = [
    { from: '/old/:slug', to: '/new/:slug', status: 308 as const, preserveQuery: true, host: null },
    {
      from: '/docs/:path*',
      to: 'https://docs.x.test/:path*',
      status: 302 as const,
      preserveQuery: false,
      host: null,
    },
    { from: '/self', to: '/self', status: 308 as const, preserveQuery: true, host: null },
  ];
  it('matches rules and expands params', () => {
    expect(matchRedirect(rules, new URL('https://x.test/old/a?b=1'))?.location.href).toBe(
      'https://x.test/new/a?b=1',
    );
    expect(matchRedirect(rules, new URL('https://x.test/docs/g/h?q=1'))?.location.href).toBe(
      'https://docs.x.test/g/h',
    );
    expect(matchRedirect(rules, new URL('https://x.test/self'))).toBeNull();
    expect(matchRedirect(rules, new URL('https://x.test/other'))).toBeNull();
  });
  it('enforces https, canonical host and kv rules', async () => {
    const config = resolveConfig({
      site: { origin: 'https://www.x.test' },
      redirects: { rules: [{ from: '/a', to: '/b' }], canonicalHost: 'www.x.test', kvBinding: 'HYPDRIV_KV' },
    });
    const kv = {
      get: async (key: string) =>
        key === 'redirects' ? [{ from: '/kv', to: '/from-kv', status: 302 }] : null,
    };
    const stage = redirectsStage(config, { kv: kv as never })!;
    const run = (url: string, headers: Record<string, string> = {}) =>
      runPipeline({
        stages: [stage],
        ctx: ctxFor(url, { headers, config }),
        next: async () => new Response('next'),
      });
    expect((await run('https://www.x.test/a')).response.headers.get('location')).toBe('https://www.x.test/b');
    expect((await run('https://x.test/a')).response.headers.get('location')).toBe('https://www.x.test/a');
    expect((await run('https://www.x.test/x', { 'x-forwarded-proto': 'http' })).response.status).toBe(308);
    expect((await run('https://www.x.test/kv')).response.headers.get('location')).toBe(
      'https://www.x.test/from-kv',
    );
    expect(await (await run('https://www.x.test/other')).response.text()).toBe('next');
  });
  it('returns null when nothing is configured', () => {
    expect(redirectsStage(resolveConfig({ redirects: { forceHttps: false } }))).toBeNull();
  });
});

describe('maintenance', () => {
  it('serves the page when enabled by env and honours bypasses', async () => {
    const config = resolveConfig({
      site: { name: 'Acme' },
      maintenance: { allowIps: ['9.9.9.9'], bypassCookie: 'ok' },
    });
    const stage = maintenanceStage(config)!;
    const on = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/', { env: { HYPDRIV_MAINTENANCE: '1' } }),
      next: async () => new Response('app'),
    });
    expect(on.response.status).toBe(503);
    expect(on.response.headers.get('retry-after')).toBe('300');
    expect(await on.response.text()).toContain('Acme is briefly unavailable');
    const api = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/api/x', { env: { HYPDRIV_MAINTENANCE: 'true' } }),
      next: async () => new Response('app'),
    });
    expect(api.response.headers.get('content-type')).toContain('application/json');
    const ip = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/', { env: { HYPDRIV_MAINTENANCE: '1' }, ip: '9.9.9.9' }),
      next: async () => new Response('app'),
    });
    expect(await ip.response.text()).toBe('app');
    const cookie = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/', { env: { HYPDRIV_MAINTENANCE: '1' }, headers: { cookie: 'ok=1' } }),
      next: async () => new Response('app'),
    });
    expect(await cookie.response.text()).toBe('app');
    const off = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/', { env: {} }),
      next: async () => new Response('app'),
    });
    expect(await off.response.text()).toBe('app');
  });
  it('reads structured state from kv', async () => {
    const config = resolveConfig({ maintenance: { kvBinding: 'HYPDRIV_KV' } });
    const kv = {
      get: async () =>
        JSON.stringify({ enabled: true, message: 'Back at noon', until: '2026-11-01T12:00:00Z' }),
    };
    const r = await runPipeline({
      stages: [maintenanceStage(config, { kv: kv as never })!],
      ctx: ctxFor('https://x.test/'),
      next: async () => new Response('app'),
    });
    expect(await r.response.text()).toContain('Back at noon');
    expect(renderMaintenancePage('X', { enabled: true })).toContain('<title>X — maintenance</title>');
  });
});

describe('early hints', () => {
  it('adds precomputed and computed link headers to html responses only', async () => {
    const config = resolveConfig({ performance: { earlyHints: { preconnect: ['https://cdn.x.test'] } } });
    const stage = earlyHintsStage(config)!;
    const r = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/', { config }),
      next: async () => htmlResponse(),
    });
    expect(r.response.headers.get('link')).toBe('</_next/static/chunks/a.css>; rel=preload; as=style');
    const rsc = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/', { config, headers: { rsc: '1' } }),
      next: async () => new Response('', { headers: { 'content-type': 'text/x-component' } }),
    });
    expect(rsc.response.headers.get('link')).toBeNull();
    const dynamic = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/blog/x', { config }),
      next: async () => htmlResponse(),
    });
    expect(dynamic.response.headers.get('link')).toBe(
      '<https://cdn.x.test>; rel=preconnect; crossorigin=anonymous',
    );
  });
  it('computes from assets when the manifest has no entry', async () => {
    const config = resolveConfig({ performance: { earlyHints: { scripts: true } } });
    const m2 = { ...manifest, earlyHints: {} };
    const request = new Request('https://x.test/');
    const ctx = createContext({ request, config, manifest: m2, runner: 'test' });
    ctx.route = createRouteMatcher(m2).match('/');
    const r = await runPipeline({
      stages: [earlyHintsStage(config)!],
      ctx,
      next: async () => htmlResponse(),
    });
    const link = r.response.headers.get('link') ?? '';
    expect(link).toContain('as=style');
    expect(link).toContain('as=font');
    expect(link).toContain('b.js');
  });
});

describe('skew', () => {
  it('forces a hard navigation for stale RSC clients and tags html', async () => {
    const config = resolveConfig({});
    const stage = skewStage(config)!;
    const stale = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/', { headers: { rsc: '1', 'x-deployment-id': 'dep-1' } }),
      next: async () => new Response('rsc', { headers: { 'content-type': 'text/x-component' } }),
    });
    expect(stale.response.headers.get('content-type')).toContain('text/html');
    expect(stale.response.headers.get('x-hypdriv-skew')).toBe('1');
    const fresh = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/', { headers: { rsc: '1', 'x-deployment-id': 'dep-2' } }),
      next: async () => new Response('rsc', { headers: { 'content-type': 'text/x-component' } }),
    });
    expect(await fresh.response.text()).toBe('rsc');
    const page = await runPipeline({
      stages: [stage],
      ctx: ctxFor('https://x.test/'),
      next: async () => htmlResponse(),
    });
    expect(page.response.headers.get('x-deployment-id')).toBe('dep-2');
    expect(page.response.headers.get('x-hypdriv-build')).toBe('b1');
  });
});

describe('speculation rules', () => {
  it('builds document rules with exclusions and top urls from the graph', () => {
    const config = resolveConfig({ performance: { speculation: { prerender: { topN: 2 } } } }).performance
      .speculation!;
    const rules = buildSpeculationRules({ manifest, config, pathname: '/' })!;
    const script = speculationScript(rules);
    expect(rules.prerender?.[0]).toEqual({ source: 'list', urls: ['/blog', '/pricing'], eagerness: 'eager' });
    expect(script).toContain('"href_matches":"/*"');
    expect(script).toContain('/logout');
    expect(script).toContain('selector_matches');
    expect(rules.prefetch?.length).toBe(1);
  });
  it('returns null when both prerender and prefetch are off', () => {
    const config = resolveConfig({ performance: { speculation: { prerender: false, prefetch: false } } })
      .performance.speculation!;
    expect(buildSpeculationRules({ manifest, config, pathname: '/' })).toBeNull();
  });
});

describe('devtools', () => {
  it('exposes request facts as Server-Timing entries in development, public flags only', async () => {
    const { devtoolsStage } = await import('./devtools');
    const { FLAGS_KEY } = await import('@hypdriv/flags');
    const config = resolveConfig({
      flags: { definitions: { beta: { default: false }, secret: { default: true, serverOnly: true } } },
    });
    const ctx = ctxFor('https://x.test/', { config, development: true });
    ctx.state.set(FLAGS_KEY, { beta: true, secret: true });
    await runPipeline({ stages: [devtoolsStage(config)!], ctx, next: async () => htmlResponse() });
    const entries = Object.fromEntries(ctx.timings.list().map((e) => [e.name, e.desc]));
    expect(entries['hyp-request']).toBe(ctx.id);
    expect(entries['hyp-route']).toBe('app:/');
    expect(entries['hyp-build']).toBe('b1');
    expect(entries['hyp-deployment']).toBe('dep-2');
    const { decodeFlagsHeader } = await import('@hypdriv/flags');
    expect(decodeFlagsHeader(entries['hyp-flags'])).toEqual({ beta: true });
  });

  it('stays silent in production unless enabled', async () => {
    const { devtoolsStage } = await import('./devtools');
    const config = resolveConfig({});
    const ctx = ctxFor('https://x.test/', { config, development: false });
    await runPipeline({ stages: [devtoolsStage(config)!], ctx, next: async () => htmlResponse() });
    expect(ctx.timings.list().some((e) => e.name.startsWith('hyp-'))).toBe(false);
    expect(devtoolsStage(resolveConfig({ devtools: false }))).toBeNull();
  });
});

describe('geo on Vercel', () => {
  it('reads Vercel geo headers', () => {
    const geo = geoFrom(
      undefined,
      new Headers({
        'x-vercel-ip-country': 'US',
        'x-vercel-ip-country-region': 'CA',
        'x-vercel-ip-city': 'San%20Francisco',
        'x-vercel-ip-postal-code': '94107',
        'x-vercel-ip-timezone': 'America/Los_Angeles',
        'x-vercel-ip-latitude': '37.77',
        'x-vercel-ip-longitude': '-122.41',
        'x-vercel-ip-continent': 'NA',
        'x-vercel-id': 'sfo1::iad1::abc-123',
      }),
    );
    expect(geo).toMatchObject({ country: 'US', regionCode: 'CA', city: 'San Francisco', postalCode: '94107', timezone: 'America/Los_Angeles', latitude: 37.77, colo: 'sfo1', continent: 'NA', isEU: false, source: 'vercel' });
  });
});
