import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPATIBILITY_DATE,
  defineHypDrivNodeConfig,
  defineHypDrivWorkersConfig,
  hypdrivNodeProject,
  hypdrivWorkersProject,
} from './vitest';

describe('hypdrivNodeProject', () => {
  it('produces a Node project with source resolution and workers files excluded', () => {
    const config = hypdrivNodeProject('core');
    expect(config.resolve?.conditions).toEqual(['source']);
    expect(config.test).toMatchObject({
      name: 'core',
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    });
    expect(config.test?.exclude).toContain('src/**/*.workers.test.ts');
    const custom = hypdrivNodeProject('x', {
      include: ['tests/**/*.spec.ts'],
      setupFiles: ['./setup.ts'],
      conditions: ['dev'],
      test: { testTimeout: 1 },
    });
    expect(custom.test).toMatchObject({
      include: ['tests/**/*.spec.ts'],
      setupFiles: ['./setup.ts'],
      testTimeout: 1,
    });
    expect(custom.resolve?.conditions).toEqual(['source', 'dev']);
    expect(defineHypDrivNodeConfig('y').test?.name).toBe('y');
  });
});

describe('hypdrivWorkersProject', () => {
  it('builds cloudflareTest options with SQLite Durable Objects by default', () => {
    const { config, workersOptions } = hypdrivWorkersProject('live-workers', {
      main: './src/test-worker.ts',
      durableObjects: { HYPDRIV_CHANNEL: 'HypDrivChannel', OTHER: { className: 'Other', useSQLite: false } },
      kvNamespaces: ['HYPDRIV_KV'],
      bindings: { NODE_ENV: 'test' },
      compatibilityFlags: ['nodejs_compat', 'experimental'],
    });
    expect(config.test).toMatchObject({ name: 'live-workers', include: ['src/**/*.workers.test.ts'] });
    expect(workersOptions).toEqual({
      main: './src/test-worker.ts',
      miniflare: {
        compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
        compatibilityFlags: ['nodejs_compat', 'experimental'],
        durableObjects: {
          HYPDRIV_CHANNEL: { className: 'HypDrivChannel', useSQLite: true },
          OTHER: { className: 'Other', useSQLite: false },
        },
        kvNamespaces: ['HYPDRIV_KV'],
        bindings: { NODE_ENV: 'test' },
      },
    });
    const withWrangler = hypdrivWorkersProject('w', {
      wranglerConfigPath: './wrangler.jsonc',
      miniflare: { cacheAPI: false },
    });
    expect(withWrangler.workersOptions.wrangler).toEqual({ configPath: './wrangler.jsonc' });
    expect(withWrangler.workersOptions.miniflare?.cacheAPI).toBe(false);
    expect(withWrangler.workersOptions.main).toBeUndefined();
  });

  it('defineHypDrivWorkersConfig loads the plugin lazily and attaches it', async () => {
    const config = await defineHypDrivWorkersConfig('workers', { main: './src/harness.workers.test.ts' });
    expect(config.test?.name).toBe('workers');
    expect(Array.isArray(config.plugins)).toBe(true);
    expect(config.plugins).toHaveLength(1);
    const plugin = config.plugins?.[0] as { name?: string } | undefined;
    expect(typeof plugin?.name).toBe('string');
  });
});
