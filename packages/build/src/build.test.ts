import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HypRoute, loadConfig } from '@hypdriv/core';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleManifest, hashesFor } from './assemble';
import { mergeWithHtml } from './assets';
import { createNodeFs } from './fs';
import {
  CLOUDFLARE_HEADERS_LIMITS,
  mergeVercelRoutes,
  renderCloudflareHeaders,
  type StaticHeaderRule,
  staticCspHeaders,
  vercelSource,
} from './static-headers';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

function route(partial: Partial<HypRoute> & Pick<HypRoute, 'id' | 'pathname'>): HypRoute {
  return {
    regex: `^${partial.pathname}$`,
    kind: 'page',
    classification: 'static',
    runtime: 'nodejs',
    dynamic: false,
    assets: { js: [], css: [], fonts: [], preload: [], main: [] } as unknown as HypRoute['assets'],
    ...partial,
  } as HypRoute;
}

describe('hashesFor', () => {
  it('hashes inline scripts and styles, not external ones or JSON data blocks', async () => {
    const html =
      '<html><head><style>body{margin:0}</style><script src="/a.js"></script></head><body><script>boot()</script><script type="application/json">{"a":1}</script></body></html>';
    const { scriptHashes, styleHashes } = await hashesFor(html);
    expect(scriptHashes).toContain(sha('boot()'));
    expect(scriptHashes).not.toContain(sha('{"a":1}'));
    expect(styleHashes).toEqual([sha('body{margin:0}')]);
  });
});

describe('mergeWithHtml', () => {
  it('puts what the HTML references first and de-duplicates skew-protection spellings', () => {
    const merged = mergeWithHtml(
      {
        js: ['/assets/b.js', '/assets/a.js?dpl=1'],
        css: ['/assets/a.css'],
        fonts: [],
        main: ['/assets/b.js'],
      },
      '<script type="module" src="/assets/a.js"></script><link rel="stylesheet" href="/assets/a.css">',
    );
    expect(merged.js).toEqual(['/assets/a.js', '/assets/b.js']);
    expect(merged.css).toEqual(['/assets/a.css']);
  });
});

describe('assembleManifest', () => {
  it('records the framework, hashes prerendered documents and infers cache policies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-build-'));
    dirs.push(root);
    const client = join(root, 'dist');
    mkdirSync(join(client, 'assets'), { recursive: true });
    writeFileSync(join(client, 'assets', 'app.js'), 'console.log(1)');
    const doc =
      '<html><head><script type="module" src="/assets/app.js"></script></head><body><script>boot()</script></body></html>';
    const result = await assembleManifest({
      config: loadConfig({}),
      framework: { name: 'astro', version: '7.4.4' },
      buildId: 'b1',
      routes: [
        { route: route({ id: 'page:/', pathname: '/' }), document: doc },
        { route: route({ id: 'page:/served', pathname: '/served', servedStatically: true }), document: doc },
        { route: route({ id: 'page:/[...path]', pathname: '/[...path]', fallback: true }), document: doc },
        {
          route: route({
            id: 'endpoint:/api',
            pathname: '/api',
            kind: 'endpoint',
            classification: 'route',
            dynamic: true,
          }),
        },
      ],
      staticFiles: { count: 1, immutablePrefixes: ['/assets/'] },
      projectDir: root,
      distDir: client,
      clientDirs: [client],
      assetFile: (p) => (p === '/assets/app.js' ? join(client, 'assets', 'app.js') : null),
      fs: createNodeFs(),
      hypdrivVersion: '0.0.0-test',
    });
    const { manifest } = result;
    expect(manifest.framework).toEqual({ name: 'astro', version: '7.4.4' });
    expect(manifest.nextVersion).toBeUndefined();
    expect(manifest.csp['page:/']!.scriptHashes).toContain(sha('boot()'));
    const byId = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));
    expect(byId['page:/']!.assets.js).toContain('/assets/app.js');
    expect(byId['page:/']!.cachePolicyId).toBe('inferred:page:/');
    // Documents the static layer serves and shared fallback documents are never edge-cached by inference.
    expect(byId['page:/served']!.cachePolicyId).toBeUndefined();
    expect(byId['page:/[...path]']!.cachePolicyId).toBeUndefined();
    expect(byId['endpoint:/api']!.cachePolicyId).toBeUndefined();
    expect(manifest.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.failures).toEqual([]);
  });
});

describe('static headers rendering', () => {
  const config = loadConfig({});

  it('emits report-only and off policies as configured per route', () => {
    const manifest = { csp: { 'page:/': { scriptHashes: [sha('a()')], styleHashes: [] } } } as never;
    const reportOnly = loadConfig({ security: { csp: { reportOnly: true } } });
    const ro = staticCspHeaders(reportOnly, manifest, { routeId: 'page:/', pathname: '/' });
    expect(ro['content-security-policy']).toBeUndefined();
    expect(ro['content-security-policy-report-only']).toContain(sha('a()'));
    const enforced = staticCspHeaders(config, manifest, { routeId: 'page:/', pathname: '/' });
    expect(enforced['content-security-policy']).toContain(sha('a()'));
    expect(enforced['x-hypdriv-csp']).toBe('hash');
    const off = loadConfig({ security: { csp: { routes: [{ match: '/legacy/**', mode: 'off' }] } } });
    expect(staticCspHeaders(off, manifest, { routeId: 'page:/', pathname: '/legacy/a' })).toEqual({
      'x-hypdriv-csp': 'off',
    });
  });

  it("keeps within Cloudflare's rule budget, counting the rules already in the file", () => {
    const rules: StaticHeaderRule[] = Array.from({ length: 120 }, (_, i) => ({
      path: `/p${i}`,
      set: { 'x-a': String(i) },
    }));
    const existing = '/user\n  x-user: 1\n/other\n  x-other: 1\n';
    const { content, dropped } = renderCloudflareHeaders(rules, existing);
    const ruleLines = content.split('\n').filter((l) => l.length && !/^\s/.test(l) && !l.startsWith('#'));
    expect(ruleLines).toHaveLength(CLOUDFLARE_HEADERS_LIMITS.rules);
    expect(dropped).toHaveLength(120 - (CLOUDFLARE_HEADERS_LIMITS.rules - 2));
    expect(content).toContain('/user\n  x-user: 1');
    const long = renderCloudflareHeaders([{ path: '/long', set: { 'x-long': 'v'.repeat(2100) } }]);
    expect(long.dropped).toEqual(['/long']);
  });

  it("leaves headers the framework's own rules set for the same path to them", () => {
    const existing =
      '# Cache content-hashed assets immutably (generated by vinext)\n/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n';
    const { content } = renderCloudflareHeaders(
      [
        { path: '/*', set: { 'x-content-type-options': 'nosniff' } },
        { path: '/_next/static/*', set: { 'cache-control': 'public, max-age=31536000, immutable' } },
      ],
      existing,
    );
    expect(content.match(/max-age=31536000/g)).toHaveLength(1);
    expect(content).toContain('x-content-type-options: nosniff');
    expect(content).toContain('generated by vinext');
    // Re-rendering over its own output keeps the decision stable.
    expect(
      renderCloudflareHeaders([{ path: '/_next/static/*', set: { 'cache-control': 'x' } }], content).content,
    ).not.toContain('cache-control: x');
  });

  it('converts rule paths into anchored Build Output sources', () => {
    expect(vercelSource('/*')).toBe('^/(?:.*)$');
    expect(vercelSource('/_app/immutable/*')).toBe('^/_app/immutable/(?:.*)$');
    expect(vercelSource('/a.b(c)')).toBe('^/a\\.b\\(c\\)$');
    const routes = mergeVercelRoutes([], [{ path: '/x', set: { 'x-a': '1' }, unset: ['x-b'] }]);
    expect(routes).toEqual([
      { src: '^/x$', headers: { 'x-b': '', 'x-a': '1', 'x-hypdriv-static': '1' }, continue: true },
    ]);
  });
});
