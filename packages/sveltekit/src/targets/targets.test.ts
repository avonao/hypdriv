import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StaticHeaderRule } from '@hypdriv/build';
import { emptyManifest } from '@hypdriv/core';
import { afterAll, describe, expect, it } from 'vitest';
import { cloudflareLayout, isPagesBuild, SVELTEKIT_WORKER, wrapWorker } from './cloudflare';
import { placeHeaderRoutes, writeVercelHeaders } from './vercel';

const tmp = mkdtempSync(join(tmpdir(), 'hypdriv-sk-targets-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('Cloudflare layout', () => {
  it("decides Pages vs Workers like adapter-cloudflare's is_building_for_cloudflare_pages", () => {
    expect(isPagesBuild({}, {})).toBe(true);
    expect(isPagesBuild({ main: 'x.js' }, {})).toBe(false);
    expect(isPagesBuild({ assets: { directory: 'dist' } }, {})).toBe(false);
    expect(isPagesBuild({ main: 'x.js' }, { CF_PAGES: '1' })).toBe(true);
    expect(isPagesBuild({ pages_build_output_dir: 'out' }, {})).toBe(true);
    expect(isPagesBuild({}, { WORKERS_CI: '1' })).toBe(false);
  });

  it('resolves the assets directory and Worker file', () => {
    const root = '/app';
    const buildDir = '/app/.svelte-kit/cloudflare';
    expect(
      cloudflareLayout({
        root,
        buildDir,
        env: {},
        wrangler: {
          configPath: '/app/wrangler.jsonc',
          main: '/app/.svelte-kit/cloudflare/_worker.js',
          assets: { directory: '.svelte-kit/cloudflare' },
        },
      }),
    ).toEqual({
      pages: false,
      assetsDir: '/app/.svelte-kit/cloudflare',
      workerFile: '/app/.svelte-kit/cloudflare/_worker.js',
      configPath: '/app/wrangler.jsonc',
    });
    expect(
      cloudflareLayout({
        root,
        buildDir,
        env: {},
        wrangler: { configPath: '/app/wrangler.toml', pages_build_output_dir: 'out' },
      }),
    ).toMatchObject({ pages: true, assetsDir: '/app/out', workerFile: '/app/out/_worker.js' });
    expect(cloudflareLayout({ root, buildDir, env: {}, wrangler: {} })).toMatchObject({
      pages: true,
      assetsDir: buildDir,
      workerFile: `${buildDir}/_worker.js`,
      configPath: null,
    });
  });
});

describe('wrapWorker', () => {
  const root = join(tmp, 'cf');
  const assetsDir = join(root, '.svelte-kit', 'cloudflare');
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'hypdriv.config.ts'), 'export default {};\n');
  writeFileSync(join(root, 'src', 'worker-exports.ts'), 'export class Counter {}\n');
  writeFileSync(join(assetsDir, '.assetsignore'), '_worker.js\n_headers\n');
  writeFileSync(
    join(assetsDir, '_worker.js'),
    'export default { fetch() { return new Response("kit"); } };\n',
  );
  const manifest = emptyManifest({ buildId: 'b1' });

  it("moves the adapter's Worker aside and writes Hypdriv's shell in its place", () => {
    const layout = { pages: false, assetsDir, workerFile: join(assetsDir, '_worker.js'), configPath: null };
    const { appFile } = wrapWorker({
      layout,
      buildDir: join(root, '.svelte-kit', 'hypdriv'),
      config: { file: join(root, 'hypdriv.config.ts'), raw: {}, resolved: {} as never },
      csp: { directives: { 'script-src': ['self'] } },
      manifest,
      exports: 'src/worker-exports.ts',
      root,
    });
    expect(appFile).toBe(join(assetsDir, SVELTEKIT_WORKER));
    expect(readFileSync(appFile, 'utf8')).toContain('"kit"');
    const shell = readFileSync(layout.workerFile, 'utf8');
    expect(shell).toContain("import { createSvelteKitWorker } from '@hypdriv/sveltekit/worker';");
    expect(shell).toContain('import config from "../hypdriv/worker-config.js";');
    expect(shell).toContain(`import app from "./${SVELTEKIT_WORKER}";`);
    expect(shell).toContain(
      "export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/sveltekit/durable-objects';",
    );
    expect(shell).toContain('export * from "../../src/worker-exports.ts";');
    expect(shell).toContain('const csp = {"directives":{"script-src":["self"]}};');
    expect(shell).toContain('\\"buildId\\":\\"b1\\"');
    expect(readFileSync(join(root, '.svelte-kit', 'hypdriv', 'worker-config.js'), 'utf8')).toBe(
      'export { default } from "../../hypdriv.config.ts";\n',
    );
    expect(readFileSync(join(assetsDir, '.assetsignore'), 'utf8').split('\n')).toContain(SVELTEKIT_WORKER);
    // Running it again without a fresh adapter output is refused rather than wrapping the shell in itself.
    expect(() =>
      wrapWorker({
        layout,
        buildDir: join(root, '.svelte-kit', 'hypdriv'),
        config: { file: null, raw: {}, resolved: {} as never },
        csp: null,
        manifest,
        root,
      }),
    ).toThrow(/already Hypdriv's Worker shell/);
  });

  it('serialises an inline config and reports a missing Worker or exports module', () => {
    const dir = join(tmp, 'cf-inline', '.svelte-kit', 'cloudflare');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_worker.js'), 'export default {};\n');
    const layout = { pages: false, assetsDir: dir, workerFile: join(dir, '_worker.js'), configPath: null };
    expect(() =>
      wrapWorker({
        layout,
        buildDir: join(tmp, 'cf-inline', '.svelte-kit', 'hypdriv'),
        config: { file: null, raw: { site: { name: 'inline' } }, resolved: {} as never },
        csp: null,
        manifest,
        exports: 'src/missing.ts',
        root: join(tmp, 'cf-inline'),
      }),
    ).toThrow(/exports module not found/);
    writeFileSync(join(dir, '_worker.js'), 'export default {};\n');
    wrapWorker({
      layout,
      buildDir: join(tmp, 'cf-inline', '.svelte-kit', 'hypdriv'),
      config: { file: null, raw: { site: { name: 'inline' } }, resolved: {} as never },
      csp: null,
      manifest,
      root: join(tmp, 'cf-inline'),
    });
    expect(
      readFileSync(join(tmp, 'cf-inline', '.svelte-kit', 'hypdriv', 'worker-config.js'), 'utf8'),
    ).toContain('"name": "inline"');
    expect(() =>
      wrapWorker({
        layout: { ...layout, workerFile: join(dir, 'nope.js') },
        buildDir: dir,
        config: { file: null, raw: {}, resolved: {} as never },
        csp: null,
        manifest,
        root: tmp,
      }),
    ).toThrow(/was not found/);
  });
});

describe('Vercel header routes', () => {
  const adapterRoutes = [
    { src: '.*', continue: true, transforms: [] },
    { src: '/about', dest: '/about/' },
    { src: '/about/', status: 308, headers: { Location: '/about' } },
    { src: '/_app/immutable/.+', headers: { 'cache-control': 'public, immutable, max-age=31536000' } },
    { handle: 'filesystem' },
    { src: '^/ssr/?(?:/__data.json)?$', dest: '/ssr' },
    { src: '/.*', dest: '/![-]/catchall' },
  ];
  const rules: StaticHeaderRule[] = [
    { path: '/*', set: { 'x-frame-options': 'DENY' } },
    { path: '/about', set: { 'content-security-policy': "script-src 'sha256-a='", 'x-hypdriv-csp': 'hash' } },
  ];

  it("places Hypdriv's routes before the adapter's prerender rewrites", () => {
    const outDir = join(tmp, 'vercel', '.vercel', 'output');
    mkdirSync(join(outDir, 'static', '.hypdriv'), { recursive: true });
    writeFileSync(join(outDir, 'config.json'), JSON.stringify({ version: 3, routes: adapterRoutes }));
    expect(writeVercelHeaders(outDir, rules).routes).toBe(2);
    // Idempotent: a second run replaces Hypdriv's routes.
    writeVercelHeaders(outDir, rules);
    const config = JSON.parse(readFileSync(join(outDir, 'config.json'), 'utf8')) as {
      routes: Array<Record<string, unknown>>;
    };
    expect(config.routes.map((r) => r.src ?? r.handle)).toEqual([
      '.*',
      '^/(?:.*)$',
      '^/about$',
      '/about',
      '/about/',
      '/_app/immutable/.+',
      'filesystem',
      '^/ssr/?(?:/__data.json)?$',
      '/.*',
    ]);
    expect(config.routes[2]).toMatchObject({ continue: true, headers: { 'x-hypdriv-csp': 'hash' } });
    expect(existsSync(join(outDir, 'static', '.hypdriv'))).toBe(false);
  });

  it('appends at the end when every route continues', () => {
    const own = { src: '^/x$', headers: { 'x-hypdriv-static': '1' }, continue: true };
    expect(placeHeaderRoutes([own, { src: '.*', continue: true }])).toEqual([
      { src: '.*', continue: true },
      own,
    ]);
  });

  it('requires the Build Output adapter-vercel writes', () => {
    expect(() => writeVercelHeaders(join(tmp, 'missing'), rules)).toThrow(/did not write a Build Output/);
  });
});
