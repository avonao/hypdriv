import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeVercelRoutes, renderCloudflareHeaders, staticHeaderRules } from '@hypdriv/build';
import { emptyManifest, loadConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { finalizeManifest } from './finalize';
import { manifestModuleCode, patchRuntimeManifest, replaceRuntimeManifest, toModuleSource } from './host';
import { htmlPathname } from './plugin';
import { fromColonPath, fromSvelteKitId, fromTanStackPath, fromVueRouterPath, toHypRoute } from './routes';
import { rulesFor } from './targets';
import { vercelNodeRuntime } from './vercel-output';
import { assetsForEntries } from './vite-manifest';

describe('route pattern converters', () => {
  it('converts framework syntaxes to the canonical form', () => {
    expect(fromColonPath('blog/:slug')).toBe('/blog/[slug]');
    expect(fromColonPath(':lang?/about')).toBe('/[[lang]]/about');
    expect(fromColonPath('files/*')).toBe('/files/[...splat]');
    expect(fromTanStackPath('/posts/$postId')).toBe('/posts/[postId]');
    expect(fromTanStackPath('/_layout/docs/$')).toBe('/docs/[...splat]');
    expect(fromTanStackPath('/{-$lang}/about')).toBe('/[[lang]]/about');
    expect(fromVueRouterPath('/blog/:slug()')).toBe('/blog/[slug]');
    expect(fromVueRouterPath('/:slug(.*)*')).toBe('/[[...slug]]');
    expect(fromVueRouterPath('/user/:id?')).toBe('/user/[[id]]');
    expect(fromSvelteKitId('/(app)/blog/[slug=word]')).toBe('/blog/[slug]');
    expect(fromSvelteKitId('/[[lang]]/docs/[...rest]')).toBe('/[[lang]]/docs/[...rest]');
  });

  it('classifies discovered routes', () => {
    expect(toHypRoute({ pathname: '/about', kind: 'page', prerendered: true }).classification).toBe('static');
    expect(
      toHypRoute({ pathname: '/news', kind: 'page', prerendered: true, revalidate: 60 }).classification,
    ).toBe('isr');
    expect(toHypRoute({ pathname: '/account', kind: 'page' }).classification).toBe('dynamic');
    expect(toHypRoute({ pathname: '/api/x', kind: 'endpoint' })).toMatchObject({
      id: 'endpoint:/api/x',
      classification: 'route',
      kind: 'endpoint',
    });
    const blog = toHypRoute({ pathname: '/blog/[slug]', kind: 'page' }, ['/blog/a', '/blog/b']);
    expect(blog).toMatchObject({ dynamic: true, classification: 'dynamic', prerender: { pathCount: 2 } });
  });

  it('maps HTML files to pathnames', () => {
    expect(htmlPathname('index.html')).toBe('/');
    expect(htmlPathname('about.html')).toBe('/about');
    expect(htmlPathname('docs/index.html')).toBe('/docs');
  });
});

describe('runtime manifest module', () => {
  it('replaces the embedded manifest in any quoting a minifier picks', () => {
    const first = emptyManifest({ buildId: 'early' });
    const final = emptyManifest({ buildId: 'final' });
    const code = manifestModuleCode(first);
    const json = code.slice(code.indexOf('JSON.parse(') + 11, code.lastIndexOf(')'));
    const single = `const m=JSON.parse('${JSON.parse(json).replace(/'/g, "\\'")}');export{m as default};`;
    for (const variant of [code, single, `x=\`${JSON.parse(json)}\``]) {
      const next = replaceRuntimeManifest(variant, final);
      expect(next).not.toBeNull();
      expect(next).toContain('\\"buildId\\":\\"final\\"');
      expect(next).not.toContain('"early\\"');
    }
    expect(replaceRuntimeManifest('export default 1', final)).toBeNull();
  });

  it('patches built files on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypdriv-patch-'));
    mkdirSync(join(dir, 'chunks'));
    writeFileSync(join(dir, 'chunks', 'a.mjs'), manifestModuleCode(emptyManifest({ buildId: 'early' })));
    writeFileSync(join(dir, 'b.js'), 'console.log(1)');
    const patched = patchRuntimeManifest([dir], emptyManifest({ buildId: 'final' }));
    expect(patched).toEqual([join(dir, 'chunks', 'a.mjs')]);
    expect(readFileSync(join(dir, 'chunks', 'a.mjs'), 'utf8')).toContain('final');
  });

  it('serialises inline configs with regular expressions', () => {
    expect(toModuleSource({ a: [/x\/y/gi, 'b'], c: { d: true } })).toBe(
      '{ "a": [new RegExp("x\\\\/y", "gi"), "b"], "c": { "d": true } }',
    );
    expect(() => toModuleSource({ f: () => 1 })).toThrow(/function/);
  });
});

describe('static headers', () => {
  const config = loadConfig({ security: { csp: { mode: 'auto' } } });
  const manifest = emptyManifest({
    routes: [
      toHypRoute({ pathname: '/', kind: 'page', prerendered: true }),
      toHypRoute({ pathname: '/about', kind: 'page', prerendered: true }),
    ],
    csp: {
      'page:/': { scriptHashes: ["'sha256-root'"], styleHashes: [] },
      'page:/about': { scriptHashes: ["'sha256-about'"], styleHashes: [] },
    },
    staticFiles: { count: 2, immutablePrefixes: ['/assets/'] },
  });
  const documents = [
    { routeId: 'page:/', pathname: '/' },
    { routeId: 'page:/about', pathname: '/about' },
  ];

  it('builds a base rule, immutable assets and a CSP per document', () => {
    const rules = staticHeaderRules({ config, manifest, documents });
    expect(rules[0]).toMatchObject({ path: '/*' });
    expect(rules[0]!.set['x-content-type-options']).toBe('nosniff');
    expect(rules[0]!.set['content-security-policy']).toBeUndefined();
    expect(rules.find((r) => r.path === '/assets/*')!.set['cache-control']).toContain('immutable');
    const about = rules.find((r) => r.path === '/about')!;
    expect(about.set['content-security-policy']).toContain("'sha256-about'");
    expect(rules.find((r) => r.path === '/about/')).toBeDefined();
  });

  it('gives a single-page app one catch-all policy and detaches it elsewhere', () => {
    const rules = rulesFor({
      config,
      manifest,
      documents,
      immutablePrefixes: ['/assets/'],
      spaShell: { routeId: 'page:/', pathname: '/' },
    });
    const all = rules.find((r) => r.path === '/*')!;
    expect(all.set['content-security-policy']).toContain("'sha256-root'");
    const about = rules.find((r) => r.path === '/about')!;
    expect(about.unset).toContain('content-security-policy');
    const cf = renderCloudflareHeaders(rules, '/legacy\n  x-old: 1\n').content;
    expect(cf.startsWith('# hypdriv:start')).toBe(true);
    expect(cf).toContain('  ! content-security-policy');
    expect(cf).toContain('/legacy\n  x-old: 1');
    // Re-rendering replaces the block instead of appending a second one.
    const again = renderCloudflareHeaders(rules, cf).content;
    expect(again.match(/hypdriv:start/g)).toHaveLength(1);
  });

  it('inserts Vercel routes before the filesystem handler and replaces earlier runs', () => {
    const rules = staticHeaderRules({ config, manifest, documents });
    const once = mergeVercelRoutes(
      [{ src: '^/old$', status: 308 }, { handle: 'filesystem' }, { src: '/(.*)', dest: '/index' }],
      rules,
    );
    const fs = once.findIndex((r) => r.handle === 'filesystem');
    expect(once[0]).toEqual({ src: '^/old$', status: 308 });
    expect(once.slice(1, fs).every((r) => r.continue === true)).toBe(true);
    const twice = mergeVercelRoutes(once, rules);
    expect(twice).toHaveLength(once.length);
  });
});

describe('finalizeManifest', () => {
  it('assigns documents to routes and hashes their inline scripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-final-'));
    const client = join(root, 'dist');
    mkdirSync(join(client, 'blog'), { recursive: true });
    mkdirSync(join(client, 'assets'));
    writeFileSync(join(client, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(
      join(client, 'index.html'),
      '<html><head><script type="module" src="/assets/app.js"></script></head><body><script>boot()</script><a href="/blog/a">a</a></body></html>',
    );
    writeFileSync(join(client, 'blog', 'a.html'), '<html><body><script>a()</script></body></html>');
    writeFileSync(join(client, 'legal.html'), '<html><body>legal</body></html>');
    const result = await finalizeManifest({
      root,
      config: loadConfig({}),
      framework: { name: 'vite', version: '8.3.5' },
      routes: [
        { pathname: '/', kind: 'page' },
        { pathname: '/blog/[slug]', kind: 'page' },
        { pathname: '/api/items', kind: 'endpoint' },
      ],
      documents: [
        { pathname: '/', file: join(client, 'index.html') },
        { pathname: '/blog/a', file: join(client, 'blog', 'a.html') },
        { pathname: '/legal', file: join(client, 'legal.html') },
      ],
      clientDir: client,
      immutablePrefixes: ['/assets/'],
      write: false,
    });
    const byId = Object.fromEntries(result.manifest.routes.map((r) => [r.id, r]));
    expect(byId['page:/']!.classification).toBe('static');
    expect(byId['page:/']!.assets.js).toEqual(['/assets/app.js']);
    expect(byId['page:/blog/[slug]']).toMatchObject({
      classification: 'dynamic',
      prerender: { paths: ['/blog/a'] },
    });
    expect(byId['page:/legal']!.classification).toBe('static');
    // Prerendered documents are files the static layer serves: no inferred edge-cache policy.
    expect(byId['page:/']).toMatchObject({ servedStatically: true });
    expect(byId['page:/']!.cachePolicyId).toBeUndefined();
    expect(byId['page:/legal']!.servedStatically).toBe(true);
    expect(byId['page:/blog/[slug]']!.servedStatically).toBeUndefined();
    expect(byId['endpoint:/api/items']!.classification).toBe('route');
    expect(result.manifest.csp['page:/']!.scriptHashes).toHaveLength(1);
    expect(result.manifest.framework).toEqual({ name: 'vite', version: '8.3.5' });
    expect(result.manifest.speculation.graph['/']).toEqual(['/blog/a']);
    expect(result.documents).toContainEqual({ routeId: 'page:/blog/[slug]', pathname: '/blog/a' });
  });
});

describe('vite manifest assets', () => {
  it('collects entry chunks, static imports and CSS without dynamic imports', () => {
    const assets = assetsForEntries(
      {
        'index.html': {
          file: 'assets/main.js',
          isEntry: true,
          imports: ['_shared.js'],
          css: ['assets/main.css'],
          dynamicImports: ['src/lazy.ts'],
        },
        '_shared.js': { file: 'assets/shared.js', css: ['assets/shared.css'] },
        'src/lazy.ts': { file: 'assets/lazy.js', isDynamicEntry: true },
      },
      ['index.html'],
    );
    expect(assets).toEqual({
      js: ['/assets/main.js', '/assets/shared.js'],
      css: ['/assets/main.css', '/assets/shared.css'],
      fonts: [],
      main: ['/assets/main.js'],
    });
  });
});

describe('vercelNodeRuntime', () => {
  it('picks the newest Vercel runtime not newer than the building Node', () => {
    expect(vercelNodeRuntime('24.11.0')).toBe('nodejs24.x');
    expect(vercelNodeRuntime('25.2.1')).toBe('nodejs24.x');
    expect(vercelNodeRuntime('27.0.0')).toBe('nodejs26.x');
    expect(vercelNodeRuntime('20.19.0')).toBe('nodejs22.x');
  });
});
