import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@hypdriv/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDeploymentId, PHASE, withHypDriv } from './index';
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
    const fn = withHypDriv({}, { projectDir: dir, config: { performance: { skewProtection: true } }, adapterPath: '/virtual/adapter.js', log: silentLogger, purser: false, target: 'vercel', deploymentId: () => 'from-git' });
    const out = await fn(PHASE.productionBuild, { defaultConfig: {} });
    expect(out.deploymentId).toBeUndefined();
    expect(out.images?.loaderFile).toBeUndefined();
    const node = await withHypDriv({}, { projectDir: dir, adapterPath: '/virtual/adapter.js', log: silentLogger, purser: false, target: 'node', deploymentId: () => 'from-git' })(PHASE.productionBuild, { defaultConfig: {} });
    expect(node.deploymentId).toBe('from-git');
    expect(node.images?.loaderFile).toBeUndefined();
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

  it('derives a deployment id from the environment', () => {
    process.env.HYPDRIV_DEPLOYMENT_ID = 'deploy-1234567890abc';
    expect(defaultDeploymentId(dir)).toBe('deploy-12345');
    delete process.env.HYPDRIV_DEPLOYMENT_ID;
  });
});
