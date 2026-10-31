import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, openNextProject, tempProject } from './__tests__/helpers';
import { analyzeNextConfig, detectPlatform, detectProject } from './project';
import { importSpecifiers, scanNodeApis } from './source-scan';

afterEach(cleanupProjects);

describe('detectProject', () => {
  it('detects versions, wrangler config with comments, next.config, router and package manager', () => {
    const p = openNextProject();
    const info = detectProject(p.dir, { env: {} });
    expect(info.root).toBe(p.dir);
    expect(info.name).toBe('@acme/shop');
    expect(info.packageManager).toBe('pnpm');
    expect(info.next).toEqual({ installed: '16.4.3', range: '16.4.3' });
    expect(info.react.installed).toBe('19.3.1');
    expect(info.opennext.installed).toBe('1.20.14');
    expect(info.wrangler.installed).toBe('4.156.0');
    expect(info.typescript).toMatchObject({ installed: '6.0.3', major: 6 });
    expect(info.wrangler.format).toBe('jsonc');
    expect(info.wrangler.config?.main).toBe('.open-next/worker.js');
    expect(info.wrangler.parseError).toBeNull();
    expect(info.nextConfig).toMatchObject({
      module: 'esm',
      wrapped: false,
      importsWithHypDriv: false,
      initOpenNextDev: true,
      defaultExport: 'identifier',
    });
    expect(info.router).toEqual({ app: true, pages: false });
    expect(info.platform).toBe('cloudflare');
    expect(info.platformDetection.signals.cloudflare).toEqual(
      expect.arrayContaining(['wrangler.jsonc', '@opennextjs/cloudflare']),
    );
    expect(info.tsconfigExcludesWorker).toBe(false);
    expect(info.manifest).toBeNull();
    expect(info.proxyFile).toBeNull();
  });

  it('distinguishes middleware.ts from proxy.ts and finds edge runtime exports and Node APIs', () => {
    const p = openNextProject({
      'middleware.ts': 'export function middleware() {}\n',
      'app/api/edge/route.ts':
        "export const runtime = 'edge';\nexport async function GET() { return new Response('x'); }\n",
      'lib/convert.ts':
        "import { execFile } from 'node:child_process';\nimport sharp from 'sharp';\nexport const run = () => execFile('ls');\n",
      'lib/shutdown.ts': 'export function stop() {\n  process.exit(1);\n}\n',
      'lib/browser.ts': "import puppeteer from '@cloudflare/puppeteer';\nexport default puppeteer;\n",
    });
    let info = detectProject(p.dir, { env: {} });
    expect(info.middlewareFile).toMatch(/middleware\.ts$/);
    expect(info.proxyFile).toBeNull();
    expect(info.sources.edgeRuntime).toEqual([
      expect.objectContaining({ file: 'app/api/edge/route.ts', line: 1, kind: 'segment' }),
    ]);
    const apis = info.sources.nodeApis.map((f) => `${f.api}@${f.file}:${f.line}`);
    expect(apis).toEqual(
      expect.arrayContaining([
        'child_process@lib/convert.ts:1',
        'sharp@lib/convert.ts:2',
        'process.exit@lib/shutdown.ts:2',
      ]),
    );
    expect(apis.some((a) => a.startsWith('puppeteer'))).toBe(false);
    p.write('proxy.ts', "import { createProxy } from 'hypdriv/proxy';\n");
    info = detectProject(p.dir, { env: {} });
    expect(info.proxyFile).toMatch(/proxy\.ts$/);
  });

  it('analyses next.config variants', () => {
    const a = analyzeNextConfig(
      'next.config.mjs',
      "import { withHypDriv } from 'hypdriv/config';\nexport default withHypDriv({ output: 'standalone', adapterPath: './adapter.mjs', images: { loader: 'custom', loaderFile: './loader.ts' }, cacheComponents: true });\n",
    );
    expect(a).toMatchObject({
      wrapped: true,
      importsWithHypDriv: true,
      output: 'standalone',
      adapterPath: './adapter.mjs',
      imagesLoader: 'custom',
      imagesLoaderFile: './loader.ts',
      cacheComponents: true,
      defaultExport: 'call',
    });
    const legacy = analyzeNextConfig(
      'next.config.ts',
      "import { withHypDriv } from '@hypdriv/next/config';\nexport default withHypDriv(config);",
    );
    expect(legacy.importsWithHypDriv).toBe(true);
    const cjs = analyzeNextConfig('next.config.js', "module.exports = { output: 'export' };\n");
    expect(cjs).toMatchObject({ module: 'cjs', defaultExport: 'cjs', output: 'export', wrapped: false });
    expect(
      analyzeNextConfig('x', 'export default async function config() { return {}; }').defaultExport,
    ).toBe('function');
    expect(analyzeNextConfig('x', 'export default { reactStrictMode: true };').defaultExport).toBe('object');
  });

  it('reads the Wrangler config named by `wrangler` instead of the project one (generated configs outside the project)', () => {
    const area = tempProject({
      'package.json': '{"name":"area"}',
      'wrangler.jsonc': '{ "name": "build-only", "main": ".open-next/worker.js" }',
    });
    const shared = tempProject({
      'package.json': '{"name":"infra"}',
      'web.wrangler.jsonc': '// generated\n{ "name": "web-site", "main": "../area/hypdriv.worker.ts" }',
      'broken.wrangler.jsonc': '{ "name": ',
    });
    const file = join(shared.dir, 'web.wrangler.jsonc');
    const info = detectProject(area.dir, { env: {}, wrangler: file });
    expect(info.wrangler).toMatchObject({ configFile: file, format: 'jsonc', parseError: null });
    expect(info.wrangler.config).toMatchObject({ name: 'web-site', main: '../area/hypdriv.worker.ts' });
    // Without the option the project's own file is used.
    expect(detectProject(area.dir, { env: {} }).wrangler.config?.name).toBe('build-only');
    // A missing or broken file is reported, never silently replaced by the project's.
    const missing = detectProject(area.dir, { env: {}, wrangler: join(shared.dir, 'nope.jsonc') });
    expect(missing.wrangler).toMatchObject({ config: null });
    expect(missing.wrangler.parseError).toContain('could not be read');
    const broken = detectProject(area.dir, { env: {}, wrangler: join(shared.dir, 'broken.wrangler.jsonc') });
    expect(broken.wrangler.config).toBeNull();
    expect(broken.wrangler.parseError).toBeTruthy();
  });

  it('reads wrangler.toml and reports parse errors of broken JSONC', () => {
    const toml = openNextProject({
      'wrangler.jsonc': '',
      'wrangler.toml': 'name = "shop"\nmain = "hypdriv.worker.ts"\ncompatibility_flags = ["nodejs_compat"]\n',
    });
    // jsonc takes precedence; an empty file is a parse error
    expect(detectProject(toml.dir, { env: {} }).wrangler.parseError).toBeTruthy();
    const onlyToml = tempProject({
      'package.json': '{"name":"x"}',
      'wrangler.toml': 'name = "shop"\nmain = "hypdriv.worker.ts"\n',
    });
    const info = detectProject(onlyToml.dir, { env: {} });
    expect(info.wrangler).toMatchObject({ format: 'toml', parseError: null });
    expect(info.wrangler.config?.main).toBe('hypdriv.worker.ts');
  });
});

describe('platform detection', () => {
  it('detects Vercel from vercel.json, the VERCEL env and @hypdriv/vercel', () => {
    const p = tempProject({
      'package.json': JSON.stringify({
        name: 'site',
        dependencies: { next: '16.4.3', '@vercel/analytics': '^1' },
      }),
      ...installed('next', '16.4.3'),
      'vercel.json': JSON.stringify({
        crons: [{ path: '/api/jobs/digest', schedule: '0 9 * * 1' }],
        regions: ['iad1'],
      }),
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.platform).toBe('vercel');
    expect(info.vercel).toMatchObject({ format: 'json', linked: false, outputDir: null });
    expect(info.vercel.config?.crons).toEqual([{ path: '/api/jobs/digest', schedule: '0 9 * * 1' }]);
    expect(info.vercel.config?.regions).toEqual(['iad1']);
  });

  it('finds a monorepo app linked at the repository root (vercel link / pull / build there)', () => {
    const p = tempProject({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '16.4.3' } }),
      'apps/web/vercel.json': JSON.stringify({ regions: ['iad1'] }),
      '.vercel/project.json': JSON.stringify({
        projectId: 'prj_1',
        orgId: 'team_1',
        settings: { rootDirectory: 'apps/web' },
      }),
      '.vercel/.env.production.local': 'HYPDRIV_SESSION_SECRET="x"\nCRON_SECRET="y"\n',
      '.vercel/output/config.json': '{"version":3}',
    });
    const info = detectProject(join(p.dir, 'apps/web'), { env: {} });
    expect(info.vercel.linked).toBe(true);
    expect(info.vercel.linkDir).toBe(p.dir);
    expect(info.vercel.outputDir).toBe(join(p.dir, '.vercel', 'output'));
    expect(info.envFiles).toContainEqual({
      file: join('..', '..', '.vercel', '.env.production.local'),
      keys: ['HYPDRIV_SESSION_SECRET', 'CRON_SECRET'],
    });
    // A link for another app of the repository is not this app's.
    p.write(
      '.vercel/project.json',
      JSON.stringify({ projectId: 'prj_2', orgId: 'team_1', settings: { rootDirectory: 'apps/docs' } }),
    );
    expect(detectProject(join(p.dir, 'apps/web'), { env: {} }).vercel).toMatchObject({
      linked: false,
      linkDir: null,
      outputDir: null,
    });
  });

  it('weighs signals and honours --platform', () => {
    const base = {
      wranglerConfig: null,
      cloudflareConfig: null,
      workerFile: null,
      opennext: { installed: null, range: null },
      pkg: null,
      nextInstalled: true,
    };
    const vercel = {
      configFile: null,
      format: null,
      config: null,
      parseError: null,
      linked: false,
      linkDir: null,
      outputDir: null,
      cli: null,
    } as const;
    expect(detectPlatform({ ...base, env: {}, vercel }).platform).toBe('node');
    expect(detectPlatform({ ...base, env: {}, vercel, nextInstalled: false }).platform).toBe('unknown');
    expect(
      detectPlatform({ ...base, env: { VERCEL: '1' }, vercel, wranglerConfig: '/x/wrangler.jsonc' }).platform,
    ).toBe('vercel');
    expect(
      detectPlatform({
        ...base,
        env: {},
        vercel: { ...vercel, linked: true },
        wranglerConfig: '/x/wrangler.jsonc',
      }).platform,
    ).toBe('cloudflare');
    expect(
      detectPlatform({ ...base, env: {}, vercel: { ...vercel, configFile: '/x/vercel.json' } }).platform,
    ).toBe('vercel');
    expect(detectPlatform({ ...base, env: {}, vercel }, 'vercel')).toMatchObject({
      platform: 'vercel',
      explicit: true,
    });
  });

  it('reads vercel.ts statically', () => {
    const p = tempProject({
      'package.json': '{"name":"site"}',
      'vercel.ts':
        "import type { VercelConfig } from '@vercel/config/v1';\nexport const config: VercelConfig = {\n  regions: ['iad1', 'sfo1'],\n  crons: [{ path: '/api/jobs/digest', schedule: '0 9 * * 1' }],\n};\n",
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.platform).toBe('vercel');
    expect(info.vercel.format).toBe('ts');
    expect(info.vercel.config).toMatchObject({
      approximate: true,
      regions: ['iad1', 'sfo1'],
      crons: [{ path: '/api/jobs/digest', schedule: '0 9 * * 1' }],
    });
  });
});

describe('source scan helpers', () => {
  it('collects import specifiers of every form', () => {
    const src =
      "import a from 'a';\nimport { b } from \"b\";\nimport 'side';\nexport * from 'c';\nconst d = await import('d');\nconst e = require('e');\nimport type { T } from 't';";
    expect(importSpecifiers(src).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'side', 't']);
  });

  it('only flags fs.watch when fs is imported', () => {
    expect(scanNodeApis('/r/x.ts', "const w = watch('x');", '/r')).toEqual([]);
    expect(scanNodeApis('/r/x.ts', "import fs from 'node:fs';\nfs.watch('x');", '/r')[0]).toMatchObject({
      api: 'fs.watch',
      line: 2,
    });
  });
});
