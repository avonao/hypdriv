import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, openNextProject, tempProject } from './__tests__/helpers';
import { canEvaluateCloudflareConfig } from './cloudflare-config';
import { analyzeNextConfig, detectPlatform, detectProject } from './project';
import { importSpecifiers, scanNodeApis, scanRevalidation } from './source-scan';

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

describe('cloudflare.config.ts (cf CLI format)', () => {
  const evaluable = canEvaluateCloudflareConfig();
  const CF = `import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./hypdriv.worker.ts" with { type: "cf-worker" };
export default defineConfig({
  worker: {
    name: "shop",
    entrypoint,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    observability: { enabled: true },
    env: { ASSETS: bindings.assets(), CACHE: bindings.kv({ title: "cache" }) },
    exports: { HypDrivChannel: exports.durableObject({ storage: "sqlite" }) },
    triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
  },
});
`;

  it.skipIf(!evaluable)('reads the Worker configuration when there is no Wrangler file', () => {
    const p = tempProject({
      'package.json': '{"name":"x","type":"module"}',
      'hypdriv.worker.ts': 'export default {};\n',
      'cloudflare.config.ts': CF,
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.wrangler).toMatchObject({ format: 'cloudflare-config', parseError: null });
    expect(info.wrangler.configFile).toBe(join(p.dir, 'cloudflare.config.ts'));
    expect(info.wrangler.config).toMatchObject({
      name: 'shop',
      main: './hypdriv.worker.ts',
      compatibility_flags: ['nodejs_compat'],
      assets: { binding: 'ASSETS' },
      triggers: { crons: ['*/15 * * * *'] },
    });
    expect(info.cloudflareConfigFile).toBe(join(p.dir, 'cloudflare.config.ts'));
    expect(info.platform).toBe('cloudflare');
  });

  it.skipIf(!evaluable)('prefers a Wrangler file when both exist, and reports a broken config file', () => {
    const both = tempProject({
      'package.json': '{"name":"x"}',
      'wrangler.jsonc': '{ "name": "from-wrangler" }',
      'cloudflare.config.ts': CF,
    });
    const info = detectProject(both.dir, { env: {} });
    expect(info.wrangler).toMatchObject({ format: 'jsonc' });
    expect(info.wrangler.config?.name).toBe('from-wrangler');
    expect(info.cloudflareConfigFile).toBeTruthy();

    const broken = tempProject({
      'package.json': '{"name":"x","type":"module"}',
      'cloudflare.config.ts':
        'import { defineConfig } from "cf/config";\nexport default defineConfig(() => { throw new Error("missing account"); });\n',
    });
    const failed = detectProject(broken.dir, { env: {} });
    expect(failed.wrangler.format).toBe('cloudflare-config');
    expect(failed.wrangler.config).toBeNull();
    expect(failed.wrangler.parseError).toContain('missing account');
  });

  it.skipIf(!evaluable)(
    'selects the mode with the environment option and accepts the file as the override',
    () => {
      const p = tempProject({
        'package.json': '{"name":"x","type":"module"}',
        'cloudflare.config.ts':
          'import { defineConfig } from "cf/config";\nexport default defineConfig(({ mode }) => ({ worker: { name: mode === "staging" ? "shop-staging" : "shop", compatibilityDate: "2026-09-01" } }));\n',
      });
      expect(detectProject(p.dir, { env: {} }).wrangler.config?.name).toBe('shop');
      expect(detectProject(p.dir, { env: {}, wranglerEnv: 'staging' }).wrangler.config?.name).toBe(
        'shop-staging',
      );
      const viaFlag = detectProject(p.dir, { env: {}, wrangler: join(p.dir, 'cloudflare.config.ts') });
      expect(viaFlag.wrangler.format).toBe('cloudflare-config');
    },
  );
});

describe('Express and Fastify detection', () => {
  it('detects a declared Express dependency and reports the entry that registers Hypdriv', () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'api', type: 'module', dependencies: { express: '^5.2.1' } }),
      ...installed('express', '5.3.0'),
      ...installed('@hypdriv/express', '0.1.0'),
      // The server module comes first in the search order but does not register Hypdriv.
      'src/server.ts': "import app from './app.js';\napp.listen(3000);\n",
      'src/index.ts':
        "import express from 'express';\nimport { useHypDriv } from '@hypdriv/express';\nconst app = express();\nuseHypDriv(app, { config });\n",
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.framework).toMatchObject({
      name: 'express',
      version: '5.3.0',
      integration: '@hypdriv/express',
      integrationInstalled: '0.1.0',
      registered: true,
    });
    expect(info.framework.configFile).toMatch(/src\/index\.ts$/);
    expect(info.hypdriv.packages['@hypdriv/express']).toBe('0.1.0');
  });

  it('ignores Express or Fastify that is only installed (a tool dependency) and falls through to Vite', () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'site', devDependencies: { vite: '^8.3.5' } }),
      ...installed('vite', '8.3.5'),
      ...installed('express', '5.3.0'),
      ...installed('fastify', '5.12.7'),
    });
    expect(detectProject(p.dir, { env: {} }).framework.name).toBe('vite');
  });

  it('detects Fastify and reports an entry without the plugin as unregistered', () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'api', dependencies: { fastify: '^5.8.0' } }),
      ...installed('fastify', '5.12.7'),
      'server.js': "import Fastify from 'fastify';\nconst app = Fastify();\napp.listen({ port: 3000 });\n",
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.framework).toMatchObject({
      name: 'fastify',
      integration: '@hypdriv/fastify',
      integrationInstalled: null,
      registered: false,
    });
    expect(info.framework.configFile).toMatch(/server\.js$/);
  });
});

describe('Waku detection', () => {
  it('detects Waku before Hono and Vite and finds waku.config', () => {
    const p = tempProject({
      'package.json': JSON.stringify({
        name: 'wk',
        dependencies: { waku: '1.0.0-rc.4', hono: '^4.12.14' },
        devDependencies: { vite: '^8.3.5' },
      }),
      ...installed('waku', '1.0.0-rc.4'),
      ...installed('@hypdriv/waku', '0.1.0'),
      'waku.config.ts':
        "import { withHypDriv } from '@hypdriv/waku';\nexport default defineConfig(withHypDriv({}));\n",
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.framework).toMatchObject({
      name: 'waku',
      version: '1.0.0-rc.4',
      integration: '@hypdriv/waku',
      integrationInstalled: '0.1.0',
      registered: true,
    });
    expect(info.framework.configFile).toMatch(/waku\.config\.ts$/);
    expect(info.hypdriv.packages['@hypdriv/waku']).toBe('0.1.0');
  });

  it('reports a Waku project whose config does not reference the integration as unregistered', () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'wk', dependencies: { waku: '1.0.0-rc.4' } }),
      ...installed('waku', '1.0.0-rc.4'),
      'waku.config.mjs': 'export default {};\n',
    });
    expect(detectProject(p.dir, { env: {} }).framework).toMatchObject({
      name: 'waku',
      integrationInstalled: null,
      registered: false,
    });
  });
});

describe('RedwoodSDK detection', () => {
  it('detects RedwoodSDK before Vite and finds vite.config.mts', () => {
    const p = tempProject({
      'package.json': JSON.stringify({
        name: 'rw',
        dependencies: { rwsdk: '1.7.5', react: '19.3.1' },
        devDependencies: { vite: '^8.3.5', '@cloudflare/vite-plugin': '1.66.0' },
      }),
      ...installed('rwsdk', '1.7.5'),
      ...installed('@hypdriv/rwsdk', '0.1.0'),
      'vite.config.mts':
        "import { hypdriv } from '@hypdriv/rwsdk';\nexport default defineConfig({ plugins: [redwood(), hypdriv()] });\n",
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.framework).toMatchObject({
      name: 'rwsdk',
      version: '1.7.5',
      integration: '@hypdriv/rwsdk',
      integrationInstalled: '0.1.0',
      registered: true,
    });
    expect(info.framework.configFile).toMatch(/vite\.config\.mts$/);
    expect(info.hypdriv.packages['@hypdriv/rwsdk']).toBe('0.1.0');
  });

  it('reports a RedwoodSDK project whose Vite config does not reference the integration as unregistered', () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'rw', dependencies: { rwsdk: '1.7.5' } }),
      ...installed('rwsdk', '1.7.5'),
      'vite.config.mts': 'export default {};\n',
    });
    expect(detectProject(p.dir, { env: {} }).framework).toMatchObject({
      name: 'rwsdk',
      integrationInstalled: null,
      registered: false,
    });
  });

  it('leaves a plain Vite project alone', () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'v', devDependencies: { vite: '^8.3.5' } }),
      ...installed('vite', '8.3.5'),
      'vite.config.ts': 'export default {};\n',
    });
    expect(detectProject(p.dir, { env: {} }).framework.name).toBe('vite');
  });
});

describe('SolidStart detection', () => {
  it('detects SolidStart before Vite and finds vite.config', () => {
    const p = tempProject({
      'package.json': JSON.stringify({
        name: 'sol',
        dependencies: { '@solidjs/start': '^2.1.0', 'solid-js': '^1.9.18' },
        devDependencies: { vite: '^8.3.5' },
      }),
      ...installed('@solidjs/start', '2.1.0'),
      ...installed('@hypdriv/solid-start', '0.1.0'),
      'vite.config.ts':
        "import { hypdriv } from '@hypdriv/solid-start/vite';\nexport default defineConfig({ plugins: [solidStart(), nitro(), hypdriv()] });\n",
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.framework).toMatchObject({
      name: 'solid-start',
      version: '2.1.0',
      integration: '@hypdriv/solid-start',
      integrationInstalled: '0.1.0',
      registered: true,
    });
    expect(info.framework.configFile).toMatch(/vite\.config\.ts$/);
    expect(info.hypdriv.packages['@hypdriv/solid-start']).toBe('0.1.0');
  });

  it('reports an unregistered config, and finds the app.config of SolidStart 1', () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'sol', dependencies: { '@solidjs/start': '^2.1.0' } }),
      ...installed('@solidjs/start', '2.1.0'),
      'vite.config.ts': 'export default defineConfig({ plugins: [solidStart()] });\n',
    });
    expect(detectProject(p.dir, { env: {} }).framework).toMatchObject({
      name: 'solid-start',
      integrationInstalled: null,
      registered: false,
    });

    const old = tempProject({
      'package.json': JSON.stringify({ name: 'old', dependencies: { '@solidjs/start': '^1.3.2' } }),
      ...installed('@solidjs/start', '1.3.2'),
      'app.config.ts': 'export default defineConfig({});\n',
    });
    const info = detectProject(old.dir, { env: {} });
    expect(info.framework).toMatchObject({ name: 'solid-start', version: '1.3.2', registered: false });
    expect(info.framework.configFile).toMatch(/app\.config\.ts$/);
  });
});

describe('Qwik detection', () => {
  it('detects Qwik v2 before Hono and Vite and finds vite.config', () => {
    const p = tempProject({
      'package.json': JSON.stringify({
        name: 'qk',
        dependencies: { '@qwik.dev/router': '2.0.0-rc.4', hono: '^4.12.14' },
        devDependencies: { vite: '^8.3.5' },
      }),
      ...installed('@qwik.dev/router', '2.0.0-rc.4'),
      ...installed('@hypdriv/qwik', '0.1.0'),
      'vite.config.ts':
        "import { hypdriv } from '@hypdriv/qwik';\nexport default { plugins: [qwikRouter(), qwikVite(), hypdriv()] };\n",
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.framework).toMatchObject({
      name: 'qwik',
      version: '2.0.0-rc.4',
      integration: '@hypdriv/qwik',
      integrationInstalled: '0.1.0',
      registered: true,
    });
    expect(info.framework.configFile).toMatch(/vite\.config\.ts$/);
    expect(info.hypdriv.packages['@hypdriv/qwik']).toBe('0.1.0');
  });

  it('recognises a Qwik v1 project (Qwik City) so the doctor can name the migration', () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'qk1', dependencies: { '@builder.io/qwik-city': '1.20.3' } }),
      ...installed('@builder.io/qwik-city', '1.20.3'),
      'vite.config.ts': 'export default {};\n',
    });
    expect(detectProject(p.dir, { env: {} }).framework).toMatchObject({
      name: 'qwik',
      version: '1.20.3',
      integrationInstalled: null,
      registered: false,
    });
  });
});

describe('Nitro and Analog detection', () => {
  it('detects Analog before Nitro (Analog projects depend on nitropack too) and Vite', () => {
    const p = tempProject({
      'package.json': JSON.stringify({
        name: 'an',
        dependencies: { '@analogjs/platform': '^2.9.4', nitropack: '^2.13.5' },
        devDependencies: { vite: '^8.3.5' },
      }),
      ...installed('@analogjs/platform', '2.9.4'),
      ...installed('@hypdriv/analog', '0.1.0'),
      'vite.config.ts':
        "import { hypdriv, withHypDriv } from '@hypdriv/analog';\nexport default defineConfig({ plugins: [analog(withHypDriv({})), hypdriv()] });\n",
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.framework).toMatchObject({
      name: 'analog',
      version: '2.9.4',
      integration: '@hypdriv/analog',
      integrationInstalled: '0.1.0',
      registered: true,
    });
    expect(info.hypdriv.packages['@hypdriv/analog']).toBe('0.1.0');
  });

  it('detects Nitro 2 (nitropack) and Nitro 3 (nitro) before Vite and registers in nitro.config', () => {
    const nitro2 = tempProject({
      'package.json': JSON.stringify({ name: 'n2', dependencies: { nitropack: '^2.13.5' } }),
      ...installed('nitropack', '2.13.5'),
      'nitro.config.ts':
        "import { hypdrivNitro } from '@hypdriv/nitro';\nexport default { modules: [hypdrivNitro()] };\n",
    });
    expect(detectProject(nitro2.dir, { env: {} }).framework).toMatchObject({
      name: 'nitro',
      version: '2.13.5',
      integration: '@hypdriv/nitro',
      registered: true,
    });
    const nitro3 = tempProject({
      'package.json': JSON.stringify({
        name: 'n3',
        dependencies: { nitro: '3.0.261029-rc' },
        devDependencies: { vite: '^8.3.5' },
      }),
      ...installed('nitro', '3.0.261029-rc'),
      'vite.config.ts': 'export default defineConfig({ plugins: [nitro()] });\n',
    });
    expect(detectProject(nitro3.dir, { env: {} }).framework).toMatchObject({
      name: 'nitro',
      version: '3.0.261029-rc',
      registered: false,
    });
  });

  it('finds the Nitro 3 registration in vite.config when a nitro.config exists without it', () => {
    const p = tempProject({
      'package.json': JSON.stringify({ name: 'n3', dependencies: { nitro: '3.0.261029-rc' } }),
      ...installed('nitro', '3.0.261029-rc'),
      'nitro.config.ts': 'export default {};\n',
      'vite.config.ts':
        "import { hypdriv } from '@hypdriv/nitro/vite';\nimport { nitro } from 'nitro/vite';\nexport default defineConfig({ plugins: [nitro(), hypdriv()] });\n",
    });
    const info = detectProject(p.dir, { env: {} });
    expect(info.framework.registered).toBe(true);
    expect(info.framework.configFile).toMatch(/vite\.config\.ts$/);
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

describe('scanRevalidation', () => {
  const scan = (source: string) => scanRevalidation('/r/x.ts', source, '/r');
  it('finds the APIs that need the OpenNext tag cache and queue', () => {
    expect(scan("import { revalidateTag } from 'next/cache';\nrevalidateTag('posts');")).toHaveLength(1);
    expect(scan("revalidatePath('/blog');")).toHaveLength(1);
    expect(scan("'use cache';\nexport async function f() {}")).toHaveLength(1);
    expect(scan("export async function f() {\n  'use cache: remote';\n}")).toHaveLength(1);
    expect(scan("const r = await fetch(u, { next: { tags: ['a'] } });")).toHaveLength(1);
    expect(scan('const r = await fetch(u, { next: { revalidate: 60 } });')).toHaveLength(1);
    expect(scan('cacheTag("x"); cacheLife("hours");')).toHaveLength(2);
  });
  it('ignores code that does not touch the cache', () => {
    expect(
      scan("const revalidated = true;\nfetch('/x', { cache: 'no-store' });\n// revalidate later"),
    ).toEqual([]);
  });
});
