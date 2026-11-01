import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { emptyManifest, loadConfig } from '@hypdriv/core';
import { MANIFEST_SENTINEL_VALUE, manifestModuleCode, type ViteManifest } from '@hypdriv/vite';
import { afterEach, describe, expect, it } from 'vitest';
import { cloudflareEntryCode, cloudflareExportsCode } from './cloudflare';
import {
  assertFinalized,
  completeNitroOutput,
  entryKeys,
  finalizeNitroManifest,
  prerenderedDocuments,
  runtimeManifestFiles,
  withSharedAssets,
} from './finalize';
import { discoverNitroRoutes } from './routes';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const clientManifest: ViteManifest = {
  'index.html': {
    file: 'assets/main-1.js',
    src: 'index.html',
    isEntry: true,
    css: ['assets/main-1.css'],
    imports: ['_shared.js'],
  },
  '_shared.js': { file: 'assets/shared-1.js' },
};

const doc = (title: string) =>
  `<!DOCTYPE html><html><head><title>${title}</title><link rel="modulepreload" href="/assets/main-1.js"></head><body><h1>${title}</h1><script>window.__APP__={}</script></body></html>`;

/** A Nitro build on disk: the public directory after prerendering and the copy of the client build. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-nitro-'));
  dirs.push(root);
  const publicDir = join(root, '.output', 'public');
  write(join(publicDir, 'index.html'), doc('Home'));
  write(join(publicDir, 'about', 'index.html'), doc('About'));
  for (const file of ['main-1.js', 'shared-1.js'])
    write(join(publicDir, 'assets', file), `console.log(${JSON.stringify(file)})`);
  write(join(publicDir, 'assets', 'main-1.css'), 'body{margin:0}');
  const routes = discoverNitroRoutes({
    pages: [
      { pathname: '/', kind: 'page' },
      { pathname: '/about', kind: 'page' },
      { pathname: '/ssr', kind: 'page' },
    ],
    handlers: [{ route: '/api/hello', method: 'get', handler: join(root, 'server/api/hello.get.ts') }],
  });
  return { root, publicDir, routes };
}

async function finalize(
  root: string,
  publicDir: string,
  routes: ReturnType<typeof discoverNitroRoutes>,
  extra: Partial<Parameters<typeof finalizeNitroManifest>[0]> = {},
) {
  return finalizeNitroManifest({
    rootDir: root,
    config: loadConfig({ performance: { earlyHints: true } }),
    framework: {
      name: 'nitro',
      version: '2.13.5',
      bundler: 'vite',
      bundlerVersion: '8.3.5',
      adapter: 'node-server',
    },
    buildId: 'build-1',
    baseURL: '/',
    routes,
    prerendered: [
      { route: '/', fileName: '/index.html', contentType: 'text/html;charset=utf-8' },
      { route: '/about', fileName: '/about/index.html', contentType: 'text/html;charset=utf-8' },
      { route: '/broken', fileName: '/broken/index.html', error: new Error('500') },
    ],
    publicDir,
    clientManifest,
    assetPrefixes: ['/assets/'],
    ...extra,
  });
}

describe('prerenderedDocuments', () => {
  it('keeps HTML documents and maps them to URL paths', () => {
    const docs = prerenderedDocuments(
      [
        { route: '/', fileName: '/index.html' },
        { route: '/blog/hello%20world', fileName: '/blog/hello%20world/index.html' },
        { route: '/feed.xml', fileName: '/feed.xml', contentType: 'application/xml' },
        { route: '/skipped', fileName: '/skipped/index.html', skip: true },
      ],
      '/out',
    );
    expect(docs).toEqual([
      { pathname: '/', file: '/out/index.html' },
      { pathname: '/blog/hello%20world', file: '/out/blog/hello world/index.html' },
    ]);
  });
});

describe('shared client assets', () => {
  it('attaches the entry chunks to page routes only', () => {
    expect(entryKeys(clientManifest)).toEqual(['index.html']);
    const routes = withSharedAssets(
      [
        { pathname: '/', kind: 'page' },
        { pathname: '/api/x', kind: 'endpoint' },
      ],
      clientManifest,
      '/',
    );
    expect(routes[0]?.sources?.js).toEqual(['/assets/main-1.js', '/assets/shared-1.js']);
    expect(routes[0]?.sources?.css).toEqual(['/assets/main-1.css']);
    expect(routes[1]?.sources).toBeUndefined();
    expect(withSharedAssets([{ pathname: '/', kind: 'page' }], null, '/')[0]?.sources).toBeUndefined();
  });

  it('adds a framework’s per-page assets on top', () => {
    const routes = withSharedAssets([{ pathname: '/ssr', kind: 'page' }], clientManifest, '/', () => ({
      js: ['/assets/ssr-1.js'],
      css: [],
      fonts: [],
      main: [],
    }));
    expect(routes[0]?.sources?.js).toEqual(expect.arrayContaining(['/assets/ssr-1.js', '/assets/main-1.js']));
  });
});

describe('finalizeNitroManifest', () => {
  it('classifies pages and endpoints, hashes prerendered documents and attaches client assets', async () => {
    const { root, publicDir, routes } = fixture();
    const result = await finalize(root, publicDir, routes);
    assertFinalized(result);
    const { manifest } = result;
    expect(manifest.framework).toMatchObject({ name: 'nitro', version: '2.13.5', adapter: 'node-server' });
    expect(manifest.buildId).toBe('build-1');
    const byId = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));
    expect(byId['page:/']?.classification).toBe('static');
    expect(byId['page:/about']?.classification).toBe('static');
    expect(byId['page:/ssr']?.classification).toBe('dynamic');
    expect(byId['endpoint:/api/hello']?.classification).toBe('route');
    expect(manifest.csp['page:/']?.scriptHashes.length).toBeGreaterThanOrEqual(1);
    expect(manifest.csp['page:/ssr']).toBeUndefined();
    expect(byId['page:/ssr']?.assets.js).toContain('/assets/main-1.js');
    expect(manifest.earlyHints['page:/']?.join(',')).toContain('/assets/main-1.js');
    expect(manifest.staticFiles.immutablePrefixes).toEqual(['/assets/']);
    expect(result.documents.map((d) => d.pathname).sort()).toEqual(['/', '/about']);
    expect(existsSync(join(root, '.hypdriv', 'manifest.json'))).toBe(true);
  });
});

describe('finalizeNitroManifest under a base URL', () => {
  it('serves the client assets from the base, or from an explicit client base', async () => {
    const { root, publicDir, routes } = fixture();
    const underBase = await finalize(root, publicDir, routes, {
      baseURL: '/docs/',
      assetPrefixes: ['/docs/assets/'],
    });
    expect(underBase.manifest.routes.find((r) => r.id === 'page:/ssr')?.assets.js).toContain(
      '/docs/assets/main-1.js',
    );
    const cdn = await finalize(root, publicDir, routes, { baseURL: '/', clientBase: '/static/' });
    expect(cdn.manifest.routes.find((r) => r.id === 'page:/ssr')?.assets.js).toContain(
      '/static/assets/main-1.js',
    );
  });
});

describe('completeNitroOutput', () => {
  it('Cloudflare: patches the Worker bundle and merges the static rules into Nitro’s _headers', async () => {
    const { root, publicDir, routes } = fixture();
    const result = await finalize(root, publicDir, routes);
    const serverDir = join(root, '.output', 'server');
    const stale = manifestModuleCode(emptyManifest({ buildId: 'development' }));
    write(join(serverDir, 'index.mjs'), `${stale}\nexport default {};`);
    write(join(serverDir, 'chunks', 'other.mjs'), 'export const x = 1;');
    write(join(publicDir, '_headers'), '/assets/*\n  cache-control: public, max-age=31536000, immutable\n');

    expect(runtimeManifestFiles([serverDir], result.manifest).stale).toHaveLength(1);
    const input = {
      target: 'cloudflare' as const,
      config: loadConfig({}),
      result,
      publicDir,
      outputDir: join(root, '.output'),
      serverDir,
    };
    const out = completeNitroOutput(input);
    expect(out.patched).toEqual([join(serverDir, 'index.mjs')]);
    expect(out.embedded).toEqual([join(serverDir, 'index.mjs')]);
    expect(readFileSync(join(serverDir, 'index.mjs'), 'utf8')).toContain('build-1');
    const headers = readFileSync(join(publicDir, '_headers'), 'utf8');
    expect(out.headersFile).toBe(join(publicDir, '_headers'));
    expect(headers).toContain('# hypdriv:start');
    expect(headers).toMatch(/\n\/about\n {2}content-security-policy: [^\n]*'sha256-/);
    expect(headers).toContain('x-content-type-options: nosniff');
    // Nitro's own asset caching rule is kept, and Hypdriv does not add a second one.
    expect(headers.match(/^\/assets\/\*$/gm)).toHaveLength(1);
    // A second run (no changes) finds the final manifest already embedded.
    const again = completeNitroOutput(input);
    expect(again.patched).toEqual([]);
    expect(again.embedded).toHaveLength(1);
  });

  it('Cloudflare: writes the rules into an empty _headers Nitro 3 generated', async () => {
    const { root, publicDir, routes } = fixture();
    const result = await finalize(root, publicDir, routes);
    const serverDir = join(root, '.output', 'server');
    write(join(serverDir, 'index.mjs'), manifestModuleCode(emptyManifest()));
    write(join(publicDir, '_headers'), '');
    const out = completeNitroOutput({
      target: 'cloudflare',
      config: loadConfig({}),
      result,
      publicDir,
      outputDir: join(root, '.output'),
      serverDir,
    });
    expect(readFileSync(out.headersFile as string, 'utf8')).toContain('content-security-policy');
  });

  it('Vercel: inserts header routes before the filesystem and patches the function once', async () => {
    const { root, publicDir, routes } = fixture();
    const result = await finalize(root, publicDir, routes);
    const outputDir = join(root, '.vercel', 'output');
    const main = join(outputDir, 'functions', '__server.func');
    write(join(main, '.vc-config.json'), '{"runtime":"nodejs22.x","handler":"index.mjs"}');
    write(join(main, 'chunks', 'nitro.mjs'), manifestModuleCode(emptyManifest()));
    symlinkSync('./__server.func', join(outputDir, 'functions', 'ssr.func'));
    write(
      join(outputDir, 'config.json'),
      JSON.stringify({
        version: 3,
        routes: [
          {
            src: '/assets/(.*)',
            headers: { 'cache-control': 'public, max-age=31536000, immutable' },
            continue: true,
          },
          { handle: 'filesystem' },
          { src: '/(.*)', dest: '/__server' },
        ],
      }),
    );
    const out = completeNitroOutput({
      target: 'vercel',
      config: loadConfig({}),
      result,
      publicDir,
      outputDir,
      serverDir: main,
    });
    expect(out.patched).toEqual([join(main, 'chunks', 'nitro.mjs')]);
    const config = JSON.parse(readFileSync(join(outputDir, 'config.json'), 'utf8')) as {
      routes: Array<{ src?: string; handle?: string; headers?: Record<string, string> }>;
    };
    const fs = config.routes.findIndex((r) => r.handle === 'filesystem');
    const about = config.routes.findIndex((r) => r.src === '^/about$');
    expect(about).toBeGreaterThan(0);
    expect(about).toBeLessThan(fs);
    expect(config.routes[about]?.headers?.['content-security-policy']).toContain("'sha256-");
    expect(config.routes[0]?.src).toBe('/assets/(.*)');
  });

  it('Node: patches the server and writes no static configuration', async () => {
    const { root, publicDir, routes } = fixture();
    const result = await finalize(root, publicDir, routes);
    const serverDir = join(root, '.output', 'server');
    write(join(serverDir, 'chunks', 'nitro.mjs'), manifestModuleCode(emptyManifest()));
    const out = completeNitroOutput({
      target: 'node',
      config: loadConfig({}),
      result,
      publicDir,
      outputDir: join(root, '.output'),
      serverDir,
    });
    expect(out.headersFile).toBeNull();
    expect(out.embedded).toHaveLength(1);
    expect(existsSync(join(publicDir, '_headers'))).toBe(false);
  });
});

describe('runtimeManifestFiles', () => {
  it('ignores files without the runtime manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-nitro-rm-'));
    dirs.push(root);
    write(join(root, 'a.mjs'), 'export default 1;');
    write(join(root, 'b.mjs'), `// mentions ${MANIFEST_SENTINEL_VALUE} only in a comment`);
    expect(runtimeManifestFiles([root], emptyManifest())).toEqual({ current: [], stale: [] });
  });
});

describe('Worker entry sources', () => {
  it('imports Nitro 2’s polyfills before Hypdriv’s Worker; Nitro 3 injects them itself', () => {
    const nitro2 = cloudflareEntryCode('/pkg/dist/runtime/nitro2/cloudflare-worker', 2).trim().split('\n');
    expect(nitro2[0]).toBe("import '#nitro-internal-pollyfills';");
    expect(nitro2[1]).toBe('export { default } from "/pkg/dist/runtime/nitro2/cloudflare-worker";');
    expect(nitro2[2]).toBe('export * from "#hypdriv/cloudflare-exports";');
    const nitro3 = cloudflareEntryCode('/pkg/dist/runtime/nitro3/cloudflare-worker', 3).trim().split('\n');
    expect(nitro3).toEqual([
      'export { default } from "/pkg/dist/runtime/nitro3/cloudflare-worker";',
      'export * from "#hypdriv/cloudflare-exports";',
    ]);
  });

  it('re-exports the Durable Objects and the application’s own exports', () => {
    expect(cloudflareExportsCode(null)).toBe(
      "export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';\n",
    );
    expect(cloudflareExportsCode('/app/server/worker-exports.ts')).toContain(
      'export * from "/app/server/worker-exports.ts";',
    );
  });
});
