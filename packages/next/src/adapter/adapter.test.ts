import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertManifest, createRouteMatcher, resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { appRouteAssets, parseClientReferenceManifest } from './assets';
import { buildFingerprint, buildManifest } from './build-manifest';
import { classifyOutputs } from './classify';
import { createNodeFs, rerootPaths } from './fs';
import { extractAssets, extractInlineScripts, extractLinks, scanTags } from './html';
import { renderReport } from './report';
import type { OnBuildCompleteContext } from './types';

const fixtureDir = fileURLToPath(new URL('./__fixtures__/next-16.4/', import.meta.url)).replace(/\/$/, '');
const rawContext = JSON.parse(
  readFileSync(join(fixtureDir, 'onBuildComplete.json'), 'utf8'),
) as OnBuildCompleteContext;
const context = rerootPaths(rawContext, fixtureDir);
const fs = createNodeFs();

describe('html extraction', () => {
  const html = readFileSync(
    join(
      fixtureDir,
      '.next/server/route-cache/APP_PAGE/c6377dd9ce6a1c2cd100eb4344e843eb4639b9ed26f84643f77680e9eb454c4b/$/index.html',
    ),
    'utf8',
  );

  it('tokenises tags with attributes and script bodies', () => {
    const tags = scanTags(html);
    expect(tags.find((t) => t.name === 'html')?.attrs.lang).toBe('en');
    const inline = tags.filter((t) => t.name === 'script' && t.content && !t.attrs.src);
    expect(inline.length).toBeGreaterThan(2);
  });

  it('extracts executable inline scripts only', () => {
    const scripts = extractInlineScripts(
      `${html}<script type="application/json">{"a":1}</script><script type="speculationrules">{}</script>`,
    );
    expect(scripts.some((s) => s.includes('__next_f'))).toBe(true);
    expect(scripts.some((s) => s === '{"a":1}')).toBe(false);
    expect(scripts.some((s) => s === '{}')).toBe(true);
  });

  it('extracts stylesheets, scripts and preloads', () => {
    const assets = extractAssets(html);
    expect(assets.stylesheets).toEqual(['/_next/static/chunks/2yl84hpga4wpp.css']);
    expect(assets.scripts.length).toBeGreaterThan(3);
    expect(assets.preloads.some((p) => p.as === 'script')).toBe(true);
  });

  it('extracts same-origin links', () => {
    expect(extractLinks(html)).toEqual([
      '/',
      '/blog',
      '/pricing',
      '/dashboard',
      '/blog/hello-world',
      '/blog/second',
    ]);
    expect(
      extractLinks('<a href="https://x.test/a">a</a><a href="mailto:x">m</a><a href="/b#frag">b</a>', {
        origin: 'https://x.test',
      }),
    ).toEqual(['/a', '/b']);
  });
});

describe('assets', () => {
  it('parses client reference manifests', () => {
    const src = readFileSync(
      join(fixtureDir, '.next/server/app/blog/[slug]/page_client-reference-manifest.js'),
      'utf8',
    );
    const parsed = parseClientReferenceManifest(src);
    expect(parsed?.entryCSSFiles).toEqual(['static/chunks/2yl84hpga4wpp.css']);
    expect(parsed?.entryJSFiles).toEqual(['static/chunks/0umf92h1sb77c.js']);
  });

  it('collects per-route assets from the manifests', () => {
    const assets = appRouteAssets(join(fixtureDir, '.next'), '/blog/[slug]/page', fs);
    expect(assets.css).toEqual(['/_next/static/chunks/2yl84hpga4wpp.css']);
    expect(assets.js).toContain('/_next/static/chunks/turbopack-3-ry682tkyiqk.js');
    expect(assets.js).toContain('/_next/static/chunks/0umf92h1sb77c.js');
    expect(assets.main.length).toBe(4);
  });
});

describe('classification', () => {
  const classified = classifyOutputs(context.outputs);
  const byPath = Object.fromEntries(classified.map((c) => [c.route.pathname, c.route]));

  it('derives one route per page without rsc variants', () => {
    expect(Object.keys(byPath).sort()).toEqual([
      '/',
      '/_global-error',
      '/_not-found',
      '/api/hello',
      '/api/users/[id]',
      '/blog',
      '/blog/[slug]',
      '/dashboard',
      '/docs/[...path]',
      '/pricing',
    ]);
  });

  it('classifies static, isr, dynamic and routes', () => {
    expect(byPath['/']?.classification).toBe('static');
    expect(byPath['/pricing']?.classification).toBe('static');
    expect(byPath['/blog']?.classification).toBe('static');
    expect(byPath['/blog/[slug]']?.classification).toBe('isr');
    expect(byPath['/blog/[slug]']?.prerender?.paths).toEqual(['/blog/hello-world', '/blog/second']);
    expect(byPath['/blog/[slug]']?.prerender?.revalidate).toBe(60);
    expect(byPath['/dashboard']?.classification).toBe('dynamic');
    expect(byPath['/docs/[...path]']?.classification).toBe('dynamic');
    expect(byPath['/api/hello']?.classification).toBe('route');
    expect(byPath['/api/users/[id]']?.dynamic).toBe(true);
  });

  it('orders static before dynamic', () => {
    const idx = (p: string) => classified.findIndex((c) => c.route.pathname === p);
    expect(idx('/')).toBeLessThan(idx('/blog/[slug]'));
    expect(idx('/blog/[slug]')).toBeLessThan(idx('/docs/[...path]'));
  });
});

describe('buildManifest', () => {
  const config = resolveConfig({
    budgets: { routes: { '/**': { js: '1kb' } }, failOn: 'warn' },
    cache: { edge: { policies: [{ id: 'blog', match: '/blog/**', ttl: '5m' }] } },
  });

  it('builds a valid manifest from the fixture', async () => {
    const { manifest, failures, html } = await buildManifest({
      context,
      config,
      fs,
      hypdrivVersion: '0.0.0-test',
      now: () => new Date(0),
    });
    expect(() => assertManifest(manifest)).not.toThrow();
    expect(failures).toEqual([]);
    expect(manifest.buildId).toBe('I1wNd3pCoOLr16ruV6B_d');
    expect(manifest.nextVersion).toBe('16.4.3');
    // Next 16.4 does not list `public/` files in `staticFiles`; only `_next/static` and the static error pages.
    expect(manifest.routes.some((r) => r.kind === 'static-file')).toBe(false);
    expect(manifest.staticFiles.count).toBe(12);
    expect(manifest.staticFiles.immutablePrefixes).toEqual(['/_next/static/']);
    expect(manifest.proxy?.matchers[0]?.source).toBe('/((?!_next/static|_next/image|favicon.ico).*)');
    expect(Object.keys(html)).toContain('app:/');
    expect(Object.keys(html)).toContain('app:/blog/[slug]');
  });

  it('fingerprints the build output so cache keys change whenever the output does', async () => {
    const { manifest } = await buildManifest({
      context,
      config,
      fs,
      hypdrivVersion: 't',
      now: () => new Date(0),
    });
    expect(manifest.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const again = await buildManifest({ context, config, fs, hypdrivVersion: 't', now: () => new Date(1) });
    expect(again.manifest.fingerprint).toBe(manifest.fingerprint);
    // Same BUILD_ID (deterministic from the deployment id), different output → different fingerprint.
    const route = manifest.routes.find((r) => r.assets.js.length)!;
    const changedAssets = {
      ...manifest,
      routes: manifest.routes.map((r) =>
        r.id === route.id
          ? { ...r, assets: { ...r.assets, js: [...r.assets.js, '/_next/static/chunks/new.js'] } }
          : r,
      ),
    };
    expect(await buildFingerprint(changedAssets)).not.toBe(manifest.fingerprint);
    const changedHtml = {
      ...manifest,
      csp: { ...manifest.csp, 'app:/': { scriptHashes: ["'sha256-other='"], styleHashes: [] } },
    };
    expect(await buildFingerprint(changedHtml)).not.toBe(manifest.fingerprint);
    // Order-insensitive.
    expect(await buildFingerprint({ ...manifest, routes: [...manifest.routes].reverse() })).toBe(
      manifest.fingerprint,
    );
  });

  it('computes CSP hashes only for immutable static routes', async () => {
    const { manifest } = await buildManifest({ context, config, fs, hypdrivVersion: 't' });
    expect(manifest.csp['app:/']?.scriptHashes.length).toBeGreaterThan(2);
    expect(manifest.csp['app:/']?.scriptHashes.every((h) => /^'sha256-[A-Za-z0-9+/]+=*'$/.test(h))).toBe(
      true,
    );
    expect(manifest.csp['app:/blog/[slug]']).toBeUndefined();
    expect(manifest.csp['app:/dashboard']).toBeUndefined();
  });

  it('derives early hints, speculation graph and weights', async () => {
    const { manifest } = await buildManifest({ context, config, fs, hypdrivVersion: 't' });
    const hints = manifest.earlyHints['app:/'] ?? [];
    expect(hints.some((h) => h.includes('rel=preload; as=style'))).toBe(true);
    expect(hints.some((h) => h.includes('as=script'))).toBe(true);
    expect(manifest.speculation.graph['/']).toEqual([
      '/blog',
      '/pricing',
      '/dashboard',
      '/blog/hello-world',
      '/blog/second',
    ]);
    expect(manifest.speculation.graph['/blog/[slug]']).toEqual(['/', '/blog', '/pricing', '/dashboard']);
    expect(manifest.weights.client['app:/']?.js).toBeGreaterThan(1000);
    expect(manifest.weights.client['app:/']?.css).toBeGreaterThan(0);
  });

  it('resolves cache policy ids and budgets', async () => {
    const { manifest } = await buildManifest({ context, config, fs, hypdrivVersion: 't' });
    const route = manifest.routes.find((r) => r.pathname === '/blog/[slug]');
    expect(route?.cachePolicyId).toBe('blog');
    expect(manifest.routes.find((r) => r.pathname === '/')?.cachePolicyId).toBe('inferred:app:/');
    expect(manifest.routes.find((r) => r.pathname === '/dashboard')?.cachePolicyId).toBeUndefined();
    expect(manifest.budgets?.some((b) => b.status === 'error')).toBe(true);
  });

  it('fails the build on budgets when configured and reports warnings', async () => {
    const strict = resolveConfig({ budgets: { routes: { '/**': { js: '1kb' } }, failOn: 'error' } });
    const { failures } = await buildManifest({ context, config: strict, fs, hypdrivVersion: 't' });
    expect(failures[0]).toMatch(/budget/);
  });

  it('runs the purser and secrets hooks', async () => {
    const seen: string[] = [];
    const { manifest, failures } = await buildManifest({
      context,
      config,
      fs,
      hypdrivVersion: 't',
      purser: async ({ html }) => {
        seen.push(...Object.keys(html));
        return {
          ok: false,
          warnings: ['missing atom xdead123 on app:/blog/[slug]'],
          manifest: {
            stylesheet: 'app/purser.css',
            stylesheetHash: 'abc',
            atoms: 1,
            prefix: 'x',
            layers: { tokens: 'purser.tokens', globals: 'purser.globals', atoms: 'purser.atoms' },
            atomsByRoute: {},
            unusedAtoms: [],
            missingAtoms: { 'app:/blog/[slug]': ['xdead123'] },
          },
        };
      },
      secrets: async () => ({
        findings: [
          {
            id: 'stripe-secret',
            file: join(fixtureDir, '.next/static/chunks/x.js'),
            line: 1,
            severity: 'error',
            snippet: 'sk_l***',
          },
        ],
        ok: false,
      }),
    });
    expect(seen).toContain('app:/');
    expect(manifest.purser?.missingAtoms['app:/blog/[slug]']).toEqual(['xdead123']);
    expect(failures.some((f) => f.includes('Purser'))).toBe(true);
    expect(failures.some((f) => f.includes('stripe-secret'))).toBe(true);
  });

  it('renders a report and the manifest routes match requests', async () => {
    const { manifest } = await buildManifest({ context, config, fs, hypdrivVersion: 't' });
    const report = renderReport(manifest);
    expect(report).toContain('| `/blog/[slug]` | app-page | isr (60s) | blog | nonce |');
    const matcher = createRouteMatcher(manifest);
    expect(matcher.match('/blog/hello-world')?.route.pathname).toBe('/blog/[slug]');
    expect(matcher.match('/pricing')?.route.classification).toBe('static');
    expect(matcher.match('/robots.txt')).toBeNull();
    expect(matcher.match('/api/users/42')?.params.id).toBe('42');
  });
});

describe('assets with skew-protection queries', () => {
  it('deduplicates ?dpl= spellings and keeps the document spelling for preloads', async () => {
    const { mergeWithHtml } = await import('./assets');
    const html =
      '<html><head><link rel="stylesheet" href="/_next/static/chunks/a.css?dpl=d1"><script src="/_next/static/chunks/main.js?dpl=d1" async></script></head></html>';
    const merged = mergeWithHtml(
      {
        js: ['/_next/static/chunks/main.js', '/_next/static/chunks/other.js'],
        css: ['/_next/static/chunks/a.css'],
        fonts: [],
        main: ['/_next/static/chunks/main.js'],
      },
      html,
    );
    expect(merged.css).toEqual(['/_next/static/chunks/a.css?dpl=d1']);
    expect(merged.js).toEqual(['/_next/static/chunks/main.js?dpl=d1', '/_next/static/chunks/other.js']);
    expect(merged.main).toEqual(['/_next/static/chunks/main.js?dpl=d1']);
  });
});

describe('scoped prerender artifacts (Next ≥ 16.4 with an adapter)', () => {
  it('restores the classic server/app layout without overwriting files', async () => {
    const {
      mkdtempSync,
      mkdirSync,
      writeFileSync,
      readFileSync: read,
      existsSync: exists,
      rmSync,
    } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: j } = await import('node:path');
    const { mirrorAllScopedArtifacts } = await import('./scoped-artifacts');
    const dist = mkdtempSync(j(tmpdir(), 'hypdriv-scoped-'));
    try {
      const scoped = j(dist, 'server', 'route-cache', 'APP_PAGE', 'a'.repeat(64), '$');
      mkdirSync(j(scoped, 'blog.segments'), { recursive: true });
      writeFileSync(j(scoped, 'blog.html'), '<html>blog</html>');
      writeFileSync(j(scoped, 'blog.meta'), '{"routeCache":{"key":"/route-cache/APP_PAGE/aaa/$/blog"}}');
      writeFileSync(j(scoped, 'blog.segments', '_tree.segment.rsc'), 'tree');
      const pages = j(dist, 'server', 'route-cache', 'PAGES', 'b'.repeat(64), '$');
      mkdirSync(pages, { recursive: true });
      writeFileSync(j(pages, '404.html'), 'not found');
      // a standalone copy, as OpenNext builds produce
      const standalone = j(
        dist,
        'standalone',
        'apps',
        'web',
        '.next',
        'server',
        'route-cache',
        'APP_PAGE',
        'c'.repeat(64),
        '$',
      );
      mkdirSync(standalone, { recursive: true });
      writeFileSync(j(standalone, 'index.html'), 'home');
      mkdirSync(j(dist, 'server', 'app'), { recursive: true });
      writeFileSync(j(dist, 'server', 'app', 'existing.html'), 'keep');

      const result = mirrorAllScopedArtifacts(dist);
      expect(result.copied).toBe(5);
      expect(read(j(dist, 'server', 'app', 'blog.html'), 'utf8')).toBe('<html>blog</html>');
      expect(exists(j(dist, 'server', 'app', 'blog.meta'))).toBe(true);
      expect(exists(j(dist, 'server', 'app', 'blog.segments', '_tree.segment.rsc'))).toBe(true);
      expect(read(j(dist, 'server', 'pages', '404.html'), 'utf8')).toBe('not found');
      expect(read(j(dist, 'standalone', 'apps', 'web', '.next', 'server', 'app', 'index.html'), 'utf8')).toBe(
        'home',
      );
      expect(read(j(dist, 'server', 'app', 'existing.html'), 'utf8')).toBe('keep');
      // idempotent
      expect(mirrorAllScopedArtifacts(dist).copied).toBe(0);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe('shipping the manifest with server functions', () => {
  it('adds the manifest to every server output for chained platform adapters', async () => {
    const { withExtraAssets } = await import('./index');
    const augmented = withExtraAssets(context, [join(context.projectDir, '.hypdriv', 'manifest.json')]);
    for (const output of [...augmented.outputs.appPages, ...augmented.outputs.appRoutes]) {
      expect(Object.keys(output.assets).some((k) => k.endsWith('.hypdriv/manifest.json'))).toBe(true);
    }
    // the original context is untouched
    expect(
      Object.keys(context.outputs.appPages[0]!.assets).some((k) => k.endsWith('.hypdriv/manifest.json')),
    ).toBe(false);
  });

  it('appends the manifest to server .nft.json traces once', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync: read, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { addToServerTraces } = await import('./index');
    const project = mkdtempSync(join(tmpdir(), 'hypdriv-nft-'));
    try {
      const server = join(project, '.next', 'server');
      mkdirSync(join(server, 'app', 'page'), { recursive: true });
      writeFileSync(
        join(server, 'middleware.js.nft.json'),
        JSON.stringify({ version: 1, files: ['../../node_modules/x.js'] }),
      );
      writeFileSync(join(server, 'app', 'page.js.nft.json'), JSON.stringify({ version: 1, files: [] }));
      const manifest = join(project, '.hypdriv', 'manifest.json');
      expect(addToServerTraces(join(project, '.next'), [manifest])).toBe(2);
      expect(addToServerTraces(join(project, '.next'), [manifest])).toBe(0);
      expect(JSON.parse(read(join(server, 'middleware.js.nft.json'), 'utf8')).files).toEqual([
        '../../node_modules/x.js',
        '../../.hypdriv/manifest.json',
      ]);
      expect(JSON.parse(read(join(server, 'app', 'page.js.nft.json'), 'utf8')).files).toEqual([
        '../../../.hypdriv/manifest.json',
      ]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
