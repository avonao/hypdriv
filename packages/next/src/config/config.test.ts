import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@hypdriv/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPurserCompiler,
  BUILD_DEPLOYMENT_ID_ENV,
  defaultDeploymentId,
  PHASE,
  PURSER_COMPILE_GLOB,
  type PurserCompileLike,
  withHypDriv,
} from './index';
import { reviveConfig, serializeConfig } from './serialize';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hypdriv-config-'));
  delete process.env.HYPDRIV_BASE_ADAPTER;
  delete process.env.NEXT_ADAPTER_PATH;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('serializeConfig', () => {
  it('round-trips RegExps and drops functions', () => {
    const json = serializeConfig({
      cache: { edge: { policies: [{ match: /^\/x\/\d+$/i, ttl: 10, bypass: { when: () => true } }] } },
    });
    const revived = reviveConfig(json);
    const policy =
      revived.cache?.edge && typeof revived.cache.edge === 'object'
        ? revived.cache.edge.policies?.[0]
        : undefined;
    expect(policy?.match).toBeInstanceOf(RegExp);
    expect((policy!.match as RegExp).flags).toBe('i');
    expect(policy?.bypass?.when).toBeUndefined();
  });
});

describe('deploy targets', () => {
  it('resolves the build target from config, environment and project files', async () => {
    const { resolveBuildTarget } = await import('./index');
    expect(resolveBuildTarget(dir, { platform: 'node' }, {})).toBe('node');
    expect(resolveBuildTarget(dir, { platform: 'auto' }, { VERCEL: '1' })).toBe('vercel');
    expect(resolveBuildTarget(dir, { platform: 'auto' }, {})).toBe('node');
    writeFileSync(join(dir, 'vercel.json'), '{}');
    expect(resolveBuildTarget(dir, { platform: 'auto' }, {})).toBe('vercel');
    writeFileSync(join(dir, 'wrangler.jsonc'), '{}');
    expect(resolveBuildTarget(dir, { platform: 'auto' }, {})).toBe('cloudflare');
  });

  it('keeps Vercel in charge of deployment ids and image optimization', async () => {
    const fn = withHypDriv(
      {},
      {
        projectDir: dir,
        config: { performance: { skewProtection: true } },
        adapterPath: '/virtual/adapter.js',
        log: silentLogger,
        purser: false,
        target: 'vercel',
        deploymentId: () => 'from-git',
      },
    );
    const out = await fn(PHASE.productionBuild, { defaultConfig: {} });
    expect(out.deploymentId).toBeUndefined();
    expect(out.images?.loaderFile).toBeUndefined();
    const node = await withHypDriv(
      {},
      {
        projectDir: dir,
        adapterPath: '/virtual/adapter.js',
        log: silentLogger,
        purser: false,
        target: 'node',
        deploymentId: () => 'from-git',
      },
    )(PHASE.productionBuild, { defaultConfig: {} });
    expect(node.deploymentId).toBe('from-git');
    expect(node.images?.loaderFile).toBeUndefined();
  });
});

describe('withHypDriv on Vercel', () => {
  const policies = {
    cache: {
      edge: {
        policies: [
          {
            id: 'catalog',
            match: '/products/**',
            ttl: '5m',
            swr: '1h',
            respectOrigin: false,
            tags: ['catalog'],
          },
          { id: 'origin', match: '/blog/**', ttl: '1m' },
        ],
      },
    },
  };

  it('turns explicit edge-cache policies into Vercel CDN route headers ahead of the app rules', async () => {
    const appRule = {
      source: '/products/special',
      headers: [{ key: 'Vercel-CDN-Cache-Control', value: 'no-store' }],
    };
    const out = await withHypDriv(
      { headers: async () => [appRule] },
      {
        projectDir: dir,
        config: policies,
        adapterPath: '/virtual/adapter.js',
        log: silentLogger,
        purser: false,
        target: 'vercel',
      },
    )(PHASE.productionBuild, { defaultConfig: {} });
    const rules = await out.headers!();
    expect(rules.at(-1)).toEqual(appRule);
    const catalog = rules.find((r) => r.source.startsWith('/products/:'));
    expect(catalog).toBeDefined();
    const headers = Object.fromEntries(catalog!.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(headers['vercel-cdn-cache-control']).toMatch(/s-maxage=300/);
    expect(headers['vercel-cache-tag']).toContain('catalog');
    // respectOrigin policies keep following the page's own Cache-Control.
    expect(rules.some((r) => r.source.startsWith('/blog'))).toBe(false);
  });

  it('adds no header rules on other targets', async () => {
    const out = await withHypDriv(
      {},
      {
        projectDir: dir,
        config: policies,
        adapterPath: '/virtual/adapter.js',
        log: silentLogger,
        purser: false,
        target: 'cloudflare',
      },
    )(PHASE.productionBuild, { defaultConfig: {} });
    expect(out.headers).toBeUndefined();
  });
});

describe('withHypDriv', () => {
  it('applies safe defaults, sets the adapter path and writes the adapter config', async () => {
    const fn = withHypDriv(
      { reactStrictMode: false, images: { remotePatterns: [] } },
      {
        projectDir: dir,
        config: { security: { sri: true }, performance: { skewProtection: { deploymentId: 'abc123' } } },
        adapterPath: '/virtual/adapter.js',
        log: silentLogger,
        purser: false,
        target: 'cloudflare',
      },
    );
    const out = await fn(PHASE.productionBuild, { defaultConfig: {} });
    expect(out.poweredByHeader).toBe(false);
    expect(out.reactStrictMode).toBe(false);
    expect(out.adapterPath).toBe('/virtual/adapter.js');
    expect(out.deploymentId).toBe('abc123');
    expect((out.experimental as { sri?: { algorithm: string } }).sri).toEqual({ algorithm: 'sha256' });
    expect(out.images?.loader).toBe('custom');
    expect(out.images?.loaderFile).toMatch(/image/);
    expect(existsSync(join(dir, '.hypdriv/adapter-config.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, '.hypdriv/adapter-config.json'), 'utf8')).security.sri).toBe(
      true,
    );
  });

  it('supports async config functions and chains the base adapter', async () => {
    const fn = withHypDriv(async () => ({ adapterPath: './my-adapter.mjs', basePath: '/app' }), {
      projectDir: dir,
      configFile: false,
      adapterPath: '/virtual/adapter.js',
      log: silentLogger,
      purser: false,
    });
    const out = await fn(PHASE.productionBuild, { defaultConfig: {} });
    expect(out.basePath).toBe('/app');
    expect(out.adapterPath).toBe('/virtual/adapter.js');
    expect(process.env.HYPDRIV_BASE_ADAPTER).toBe(join(dir, 'my-adapter.mjs'));
  });

  it('reads hypdriv.config.mjs from the project directory', async () => {
    writeFileSync(
      join(dir, 'hypdriv.config.mjs'),
      "export default { site: { name: 'from-file' }, images: { loader: 'none' } };\n",
    );
    const fn = withHypDriv(
      {},
      { projectDir: dir, adapterPath: '/virtual/adapter.js', log: silentLogger, purser: false },
    );
    const out = await fn(PHASE.developmentServer, { defaultConfig: {} });
    expect(out.images?.loaderFile).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, '.hypdriv/adapter-config.json'), 'utf8')).site.name).toBe(
      'from-file',
    );
  });

  it('runs the Purser bridge in build and fails on errors', async () => {
    const calls: string[] = [];
    const fn = withHypDriv(
      {},
      {
        projectDir: dir,
        config: { purser: { tokens: 'lib/tokens.ts' } },
        adapterPath: '/virtual/adapter.js',
        log: silentLogger,
        purserBridge: async () => ({
          outFile: join(dir, 'app/purser.css'),
          async build() {
            calls.push('build');
            return {
              css: null,
              diagnostics: [
                { severity: 'error', message: 'raw colour "#fff"', file: 'app/page.tsx', line: 3, column: 4 },
              ],
              stats: null,
              written: false,
              outFile: null,
            };
          },
          async watch() {
            calls.push('watch');
            return { close() {} };
          },
        }),
      },
    );
    await expect(fn(PHASE.productionBuild, { defaultConfig: {} })).rejects.toThrow(/raw colour/);
    expect(calls).toEqual(['build']);
  });

  it('starts the Purser watcher once in development', async () => {
    let watches = 0;
    let devDiagnostics: boolean | undefined;
    const factory = async () => ({
      outFile: null,
      async build() {
        return { css: '', diagnostics: [], stats: null, written: true, outFile: null };
      },
      async watch(
        cb?: (r: {
          css: string | null;
          diagnostics: never[];
          stats: null;
          written: boolean;
          outFile: null;
        }) => void,
        options?: { devDiagnostics?: boolean },
      ) {
        watches++;
        devDiagnostics = options?.devDiagnostics;
        cb?.({ css: '', diagnostics: [], stats: null, written: true, outFile: null });
        return { close() {} };
      },
    });
    const fn = withHypDriv(
      {},
      {
        projectDir: dir,
        config: { purser: { enabled: true } },
        adapterPath: '/virtual/adapter.js',
        log: silentLogger,
        purserBridge: factory,
      },
    );
    await fn(PHASE.developmentServer, { defaultConfig: {} });
    await fn(PHASE.developmentServer, { defaultConfig: {} });
    expect(watches).toBe(1);
    expect(devDiagnostics).toBe(true);
  });

  const compile: PurserCompileLike = {
    loader: '@avonao/purser/webpack-loader',
    options: {
      projectDir: '/app',
      tokens: 'lib/tokens.ts',
      names: 'min',
      namesFile: 'node_modules/.cache/purser/names.json',
    },
    packageName: '@avonao/purser',
    customCss: false,
  };
  const compilingBridge = (calls: string[]) => async () => ({
    outFile: null,
    compile,
    async build() {
      calls.push('build');
      return { css: '', diagnostics: [], stats: null, written: true, outFile: null };
    },
    async watch() {
      calls.push('watch');
      return { close() {} };
    },
  });

  it('gives Turbopack and webpack the Purser loader when the bridge compiles modules', async () => {
    const calls: string[] = [];
    const appRule = { loaders: ['app-loader'] };
    const fn = withHypDriv(
      {
        turbopack: { resolveExtensions: ['.tsx'], rules: { '*.svg': appRule } },
        webpack(config) {
          config.plugins = ['app-plugin'];
          return config;
        },
      },
      {
        projectDir: dir,
        config: { purser: { enabled: true } },
        adapterPath: '/virtual/adapter.js',
        log: silentLogger,
        purserBridge: compilingBridge(calls),
      },
    );
    const out = await fn(PHASE.productionBuild, { defaultConfig: {} });
    expect(calls).toEqual(['build']);
    // Turbopack: the project's own modules that name the package; the application's rules and options stay
    expect(out.turbopack?.resolveExtensions).toEqual(['.tsx']);
    expect(out.turbopack?.rules?.['*.svg']).toBe(appRule);
    const rule = out.turbopack?.rules?.[PURSER_COMPILE_GLOB] as {
      condition: { all: [{ not: string }, { content: RegExp }] };
      loaders: unknown[];
    };
    expect(rule.loaders).toEqual([{ loader: compile.loader, options: compile.options }]);
    expect(rule.condition.all[0]).toEqual({ not: 'foreign' });
    expect(rule.condition.all[1].content.test("import { css } from '@avonao/purser';")).toBe(true);
    expect(rule.condition.all[1].content.test("import { css } from '@avonaoXpurser';")).toBe(false);
    // loader options cross a process boundary under Turbopack: plain values only
    expect(JSON.parse(JSON.stringify(compile.options))).toEqual(compile.options);
    // webpack: a pre rule in front of what is there, then the application's own function
    const built = out.webpack?.({ module: { rules: [{ test: /\.css$/ }] } }, {} as never) as {
      module: { rules: Array<{ test: RegExp; enforce?: string; exclude?: RegExp; use?: unknown[] }> };
      plugins: unknown[];
    };
    expect(built.plugins).toEqual(['app-plugin']);
    expect(built.module.rules).toHaveLength(2);
    expect(built.module.rules[0]).toMatchObject({ enforce: 'pre', use: [{ loader: compile.loader }] });
    expect(built.module.rules[0]?.test.test('components/button.tsx')).toBe(true);
    expect(built.module.rules[0]?.test.test('lib/util.mts')).toBe(true);
    expect(built.module.rules[0]?.test.test('app/page.css')).toBe(false);
    expect(built.module.rules[0]?.exclude?.test('/app/node_modules/x/index.js')).toBe(true);
  });

  it('keeps the loader for every evaluation of next.config in development, and adds none without compile', async () => {
    const calls: string[] = [];
    const options = {
      projectDir: dir,
      config: { purser: { enabled: true } },
      adapterPath: '/virtual/adapter.js',
      log: silentLogger,
    } as const;
    const fn = withHypDriv({}, { ...options, purserBridge: compilingBridge(calls) });
    const first = await fn(PHASE.developmentServer, { defaultConfig: {} });
    const second = await fn(PHASE.developmentServer, { defaultConfig: {} });
    expect(calls).toEqual(['watch']);
    expect(first.turbopack?.rules?.[PURSER_COMPILE_GLOB]).toBeDefined();
    expect(second.turbopack?.rules?.[PURSER_COMPILE_GLOB]).toEqual(
      first.turbopack?.rules?.[PURSER_COMPILE_GLOB],
    );
    // a bridge that does not compile (Purser's runtime stays in the modules): the bundler is left alone
    const plainDir = mkdtempSync(join(tmpdir(), 'hypdriv-config-plain-'));
    try {
      const plain = withHypDriv(
        {},
        {
          ...options,
          projectDir: plainDir,
          purserBridge: async () => ({
            outFile: null,
            compile: null,
            async build() {
              return { css: '', diagnostics: [], stats: null, written: true, outFile: null };
            },
            async watch() {
              return { close() {} };
            },
          }),
        },
      );
      const out = await plain(PHASE.productionBuild, { defaultConfig: {} });
      expect(out.turbopack).toBeUndefined();
      expect(out.webpack).toBeUndefined();
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('applyPurserCompiler: a custom css module drops the content condition; a rule on the same glob runs after', () => {
    const own = { loaders: ['own-loader'] };
    const out: Parameters<typeof applyPurserCompiler>[0] = {
      turbopack: { rules: { [PURSER_COMPILE_GLOB]: own } },
    };
    applyPurserCompiler(out, { ...compile, packageName: '@acme/styles', customCss: true });
    const rules = out.turbopack?.rules?.[PURSER_COMPILE_GLOB] as unknown[];
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      condition: { not: 'foreign' },
      loaders: [{ loader: compile.loader, options: compile.options }],
    });
    expect(rules[1]).toBe(own);
    // without a custom css module the package's name is matched literally
    const named: Parameters<typeof applyPurserCompiler>[0] = {};
    applyPurserCompiler(named, { ...compile, packageName: '@acme/styles.v2' });
    const rule = named.turbopack?.rules?.[PURSER_COMPILE_GLOB] as {
      condition: { all: [unknown, { content: RegExp }] };
    };
    expect(rule.condition.all[1].content.test('from "@acme/styles.v2"')).toBe(true);
    expect(rule.condition.all[1].content.test('from "@acme/stylesXv2"')).toBe(false);
  });

  it('uses HYPDRIV_DEPLOYMENT_ID verbatim (sanitised)', () => {
    process.env.HYPDRIV_DEPLOYMENT_ID = 'release 2026.10/30#1';
    expect(defaultDeploymentId(dir)).toBe('release-2026-10-30-1');
    delete process.env.HYPDRIV_DEPLOYMENT_ID;
  });

  it('derives a deployment id unique per build and stable across the processes of one build', () => {
    const saved = { sha: process.env.GITHUB_SHA, memo: process.env[BUILD_DEPLOYMENT_ID_ENV] };
    delete process.env[BUILD_DEPLOYMENT_ID_ENV];
    process.env.GITHUB_SHA = '5808b80d95c9a1b2c3d4e5f60718293a4b5c6d7e';
    try {
      const first = defaultDeploymentId(dir, { now: () => 1_793_396_400_000, random: () => 'a1b2' });
      expect(first).toBe(`5808b80d95-${Math.floor(1_793_396_400).toString(36)}a1b2`);
      expect(first).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      // A build worker evaluating next.config again gets the same id.
      expect(defaultDeploymentId(dir, { now: () => 0, random: () => 'zzzz' })).toBe(first);
      // Another app built from the same commit in the same process tree gets its own.
      const other = defaultDeploymentId(join(dir, 'other-app'), {
        now: () => 1_793_396_400_000,
        random: () => 'c3d4',
      });
      expect(other).not.toBe(first);
      expect(other.startsWith('5808b80d95-')).toBe(true);
      // A new build (fresh process environment) of the same commit gets a new id.
      delete process.env[BUILD_DEPLOYMENT_ID_ENV];
      expect(defaultDeploymentId(dir, { now: () => 1_793_396_460_000, random: () => 'e5f6' })).not.toBe(
        first,
      );
    } finally {
      if (saved.sha === undefined) delete process.env.GITHUB_SHA;
      else process.env.GITHUB_SHA = saved.sha;
      if (saved.memo === undefined) delete process.env[BUILD_DEPLOYMENT_ID_ENV];
      else process.env[BUILD_DEPLOYMENT_ID_ENV] = saved.memo;
    }
  });
});
