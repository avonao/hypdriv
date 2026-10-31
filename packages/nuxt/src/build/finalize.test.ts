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
import { entryKeys, pageAssets, readNuxtClientManifest } from './client-manifest';
import { cloudflareEntryCode, cloudflareExportsCode } from './cloudflare';
import {
  assertFinalized,
  completeNuxtOutput,
  finalizeNuxtManifest,
  prerenderedDocuments,
  runtimeManifestFiles,
} from './finalize';
import { discoverRoutes } from './routes';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const ENTRY = '../node_modules/nuxt/dist/app/entry.js';
const clientManifest: ViteManifest = {
  [ENTRY]: { file: 'entry.js', src: ENTRY, isEntry: true, css: ['entry.css'], imports: ['_shared.js'] },
  '_shared.js': { file: 'shared.js' },
  'pages/index.vue': { file: 'index.js', src: 'pages/index.vue', isDynamicEntry: true, imports: [ENTRY] },
  'pages/about.vue': { file: 'about.js', src: 'pages/about.vue', isDynamicEntry: true, imports: [ENTRY] },
  'pages/ssr.vue': {
    file: 'ssr.js',
    src: 'pages/ssr.vue',
    isDynamicEntry: true,
    imports: [ENTRY],
    css: ['ssr.css'],
  },
};

const doc = (title: string) =>
  `<!DOCTYPE html><html><head><title>${title}</title><script type="importmap">{"imports":{"#entry":"/_nuxt/entry.js"}}</script><link rel="modulepreload" href="/_nuxt/entry.js"></head><body><h1>${title}</h1><script>window.__NUXT__={}</script></body></html>`;

/** A Nuxt build on disk: Nitro's public directory after prerendering and the copy of the client build. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-nuxt-'));
  dirs.push(root);
  const publicDir = join(root, '.output', 'public');
  write(join(publicDir, 'index.html'), doc('Home'));
  write(join(publicDir, 'about', 'index.html'), doc('About'));
  write(join(publicDir, 'about', '_payload.json'), '[{}]');
  for (const file of ['entry.js', 'shared.js', 'index.js', 'about.js', 'ssr.js'])
    write(join(publicDir, '_nuxt', file), `console.log(${JSON.stringify(file)})`);
  write(join(publicDir, '_nuxt', 'entry.css'), 'body{margin:0}');
  write(join(publicDir, '_nuxt', 'ssr.css'), 'h1{color:red}');
  const routes = discoverRoutes({
    pages: [
      { path: '/', file: join(root, 'app/pages/index.vue') },
      { path: '/about', file: join(root, 'app/pages/about.vue') },
      { path: '/ssr', file: join(root, 'app/pages/ssr.vue') },
    ],
    handlers: [{ route: '/api/hello', method: 'get', handler: join(root, 'server/api/hello.get.ts') }],
    rootDir: root,
  });
  return { root, publicDir, routes };
}

async function finalize(root: string, publicDir: string, routes: ReturnType<typeof discoverRoutes>) {
  return finalizeNuxtManifest({
    rootDir: root,
    srcDir: join(root, 'app'),
    config: loadConfig({ performance: { earlyHints: true } }),
    framework: {
      name: 'nuxt',
      version: '4.6.3',
      bundler: 'vite',
      bundlerVersion: '8.3.5',
      adapter: 'node-server',
    },
    buildId: 'build-1',
    baseURL: '/',
    buildAssetsPath: '/_nuxt/',
    routes,
    prerendered: [
      { route: '/', fileName: '/index.html', contentType: 'text/html;charset=utf-8' },
      { route: '/about', fileName: '/about/index.html', contentType: 'text/html;charset=utf-8' },
      { route: '/about/_payload.json', fileName: '/about/_payload.json', contentType: 'application/json' },
      { route: '/broken', fileName: '/broken/index.html', error: new Error('500') },
    ],
    publicDir,
    clientManifest,
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

describe('client manifest', () => {
  it('reads Nuxt’s client manifest module and resolves page assets with the app entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-nuxt-cm-'));
    dirs.push(root);
    expect(await readNuxtClientManifest(root)).toBeNull();
    write(
      join(root, 'dist', 'server', 'client.manifest.mjs'),
      `export default (${JSON.stringify(clientManifest)})`,
    );
    const manifest = await readNuxtClientManifest(root);
    expect(manifest).toEqual(clientManifest);
    expect(entryKeys(manifest!)).toEqual([ENTRY]);
    const assets = pageAssets(manifest!, {
      srcDir: '/app/app',
      file: '/app/app/pages/ssr.vue',
      base: '/_nuxt/',
    });
    expect(assets?.js).toEqual(['/_nuxt/ssr.js', '/_nuxt/entry.js', '/_nuxt/shared.js']);
    expect(assets?.css).toEqual(['/_nuxt/ssr.css', '/_nuxt/entry.css']);
    expect(pageAssets(manifest!, { srcDir: '/app/app', file: '/app/app/pages/x.vue', base: '/_nuxt/' })).toBe(
      undefined,
    );
  });
});

describe('finalizeNuxtManifest', () => {
  it('classifies pages and endpoints, hashes prerendered documents and attaches client assets', async () => {
    const { root, publicDir, routes } = fixture();
    const result = await finalize(root, publicDir, routes);
    assertFinalized(result);
    const { manifest } = result;
    expect(manifest.framework).toMatchObject({ name: 'nuxt', version: '4.6.3', adapter: 'node-server' });
    expect(manifest.buildId).toBe('build-1');
    const byId = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));
    expect(byId['page:/']?.classification).toBe('static');
    expect(byId['page:/about']?.classification).toBe('static');
    expect(byId['page:/ssr']?.classification).toBe('dynamic');
    expect(byId['endpoint:/api/hello']?.classification).toBe('route');
    // Both inline scripts of the prerendered documents are hashed.
    expect(manifest.csp['page:/']?.scriptHashes.length).toBeGreaterThanOrEqual(2);
    expect(manifest.csp['page:/ssr']).toBeUndefined();
    expect(byId['page:/ssr']?.assets.js).toContain('/_nuxt/ssr.js');
    expect(byId['page:/ssr']?.assets.js).toContain('/_nuxt/entry.js');
    expect(byId['page:/ssr']?.assets.css).toEqual(
      expect.arrayContaining(['/_nuxt/entry.css', '/_nuxt/ssr.css']),
    );
    expect(manifest.earlyHints['page:/']?.join(',')).toContain('/_nuxt/entry.js');
    expect(manifest.staticFiles.immutablePrefixes).toEqual(['/_nuxt/']);
    expect(result.documents.map((d) => d.pathname).sort()).toEqual(['/', '/about']);
    expect(existsSync(join(root, '.hypdriv', 'manifest.json'))).toBe(true);
  });
});

describe('completeNuxtOutput', () => {
  it('Cloudflare: patches the Worker bundle and merges the static rules into Nitro’s _headers', async () => {
    const { root, publicDir, routes } = fixture();
    const result = await finalize(root, publicDir, routes);
    const serverDir = join(root, '.output', 'server');
    const stale = manifestModuleCode(emptyManifest({ buildId: 'development' }));
    write(join(serverDir, 'index.mjs'), `${stale}\nexport default {};`);
    write(join(serverDir, 'chunks', 'other.mjs'), 'export const x = 1;');
    write(join(publicDir, '_headers'), '/_nuxt/*\n  cache-control: public, max-age=31536000, immutable\n');

    expect(runtimeManifestFiles([serverDir], result.manifest).stale).toHaveLength(1);
    const out = completeNuxtOutput({
      target: 'cloudflare',
      config: loadConfig({}),
      result,
      publicDir,
      outputDir: join(root, '.output'),
      serverDir,
    });
    expect(out.patched).toEqual([join(serverDir, 'index.mjs')]);
    expect(out.embedded).toEqual([join(serverDir, 'index.mjs')]);
    expect(readFileSync(join(serverDir, 'index.mjs'), 'utf8')).toContain('build-1');
    const headers = readFileSync(join(publicDir, '_headers'), 'utf8');
    expect(out.headersFile).toBe(join(publicDir, '_headers'));
    expect(headers).toContain('# hypdriv:start');
    expect(headers).toMatch(/\n\/about\n {2}content-security-policy: [^\n]*'sha256-/);
    expect(headers).toMatch(/\n\/about\/\n/);
    expect(headers).toContain('x-content-type-options: nosniff');
    // Nitro's own asset caching rule is kept, and HypDriv does not add a second one.
    expect(headers.match(/^\/_nuxt\/\*$/gm)).toHaveLength(1);
    // A second run (no changes) finds the final manifest already embedded.
    const again = completeNuxtOutput({
      target: 'cloudflare',
      config: loadConfig({}),
      result,
      publicDir,
      outputDir: join(root, '.output'),
      serverDir,
    });
    expect(again.patched).toEqual([]);
    expect(again.embedded).toHaveLength(1);
  });

  it('Vercel: inserts header routes before the filesystem and patches the function once', async () => {
    const { root, publicDir, routes } = fixture();
    const result = await finalize(root, publicDir, routes);
    const outputDir = join(root, '.vercel', 'output');
    const fallback = join(outputDir, 'functions', '__fallback.func');
    write(join(fallback, '.vc-config.json'), '{"runtime":"nodejs22.x","handler":"index.mjs"}');
    write(join(fallback, 'chunks', 'nitro.mjs'), manifestModuleCode(emptyManifest()));
    symlinkSync('./__fallback.func', join(outputDir, 'functions', 'ssr.func'));
    write(
      join(outputDir, 'config.json'),
      JSON.stringify({
        version: 3,
        routes: [
          {
            src: '/_nuxt/(.*)',
            headers: { 'cache-control': 'public, max-age=31536000, immutable' },
            continue: true,
          },
          { handle: 'filesystem' },
          { src: '/(.*)', dest: '/__fallback' },
        ],
      }),
    );
    const out = completeNuxtOutput({
      target: 'vercel',
      config: loadConfig({}),
      result,
      publicDir,
      outputDir,
      serverDir: fallback,
    });
    expect(out.patched).toEqual([join(fallback, 'chunks', 'nitro.mjs')]);
    const config = JSON.parse(readFileSync(join(outputDir, 'config.json'), 'utf8')) as {
      routes: Array<{ src?: string; handle?: string; headers?: Record<string, string> }>;
    };
    const fs = config.routes.findIndex((r) => r.handle === 'filesystem');
    const about = config.routes.findIndex((r) => r.src === '^/about$');
    expect(about).toBeGreaterThan(0);
    expect(about).toBeLessThan(fs);
    expect(config.routes[about]?.headers?.['content-security-policy']).toContain("'sha256-");
    expect(config.routes[0]?.src).toBe('/_nuxt/(.*)');
  });

  it('Node: patches the server and writes no static configuration', async () => {
    const { root, publicDir, routes } = fixture();
    const result = await finalize(root, publicDir, routes);
    const serverDir = join(root, '.output', 'server');
    write(join(serverDir, 'chunks', 'nitro.mjs'), manifestModuleCode(emptyManifest()));
    const out = completeNuxtOutput({
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
    const root = mkdtempSync(join(tmpdir(), 'hypdriv-nuxt-rm-'));
    dirs.push(root);
    write(join(root, 'a.mjs'), 'export default 1;');
    write(join(root, 'b.mjs'), `// mentions ${MANIFEST_SENTINEL_VALUE} only in a comment`);
    expect(runtimeManifestFiles([root], emptyManifest())).toEqual({ current: [], stale: [] });
  });
});

describe('Worker entry sources', () => {
  it('imports Nitro’s polyfills before HypDriv’s Worker and re-exports the Durable Objects', () => {
    const entry = cloudflareEntryCode('/pkg/dist/runtime/cloudflare-worker');
    const lines = entry.trim().split('\n');
    expect(lines[0]).toBe("import '#nitro-internal-pollyfills';");
    expect(lines[1]).toBe('export { default } from "/pkg/dist/runtime/cloudflare-worker";');
    expect(lines[2]).toBe('export * from "#hypdriv/cloudflare-exports";');
    expect(cloudflareExportsCode(null)).toBe(
      "export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';\n",
    );
    expect(cloudflareExportsCode('/app/server/worker-exports.ts')).toContain(
      'export * from "/app/server/worker-exports.ts";',
    );
  });
});
