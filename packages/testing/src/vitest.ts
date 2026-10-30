/**
 * Vitest presets for HypDriv packages and applications.
 *
 * - `hypdrivNodeProject(name)` → a Node project config (source-condition resolution, `*.test.ts(x)`).
 * - `hypdrivWorkersProject(name, options)` → the same for workerd, returning the plugin options for
 *   `cloudflareTest()` without importing `@cloudflare/vitest-plugin` (Node-only consumers never load it).
 * - `defineHypDrivWorkersConfig(name, options)` → loads the plugin lazily and returns a complete config.
 */
import type { ViteUserConfig } from 'vitest/config';

export interface HypDrivNodeProjectOptions {
  /** Test globs (default `src/** /*.test.ts` and `.tsx`). */
  include?: string[];
  /** Extra excludes on top of `*.workers.test.ts`. */
  exclude?: string[];
  setupFiles?: string[];
  /** Extra resolve conditions after `source`. */
  conditions?: string[];
  /** Merged last over `test`. */
  test?: NonNullable<ViteUserConfig['test']>;
}

const DEFAULT_INCLUDE = ['src/**/*.test.ts', 'src/**/*.test.tsx'];
const WORKERS_INCLUDE = ['src/**/*.workers.test.ts'];

/** Node project: pure logic tests; Workers-only files (`*.workers.test.ts`) are excluded. */
export function hypdrivNodeProject(name: string, options: HypDrivNodeProjectOptions = {}): ViteUserConfig {
  return {
    resolve: { conditions: ['source', ...(options.conditions ?? [])] },
    test: {
      name,
      environment: 'node',
      include: options.include ?? DEFAULT_INCLUDE,
      exclude: [...WORKERS_INCLUDE, '**/node_modules/**', '**/dist/**', ...(options.exclude ?? [])],
      ...(options.setupFiles ? { setupFiles: options.setupFiles } : {}),
      ...(options.test ?? {}),
    },
  };
}

export type DurableObjectDesignator =
  | string
  | { className: string; scriptName?: string; useSQLite?: boolean };

export interface HypDrivWorkersProjectOptions {
  /** Worker entry that exports Durable Object classes / the default handler under test. */
  main?: string;
  durableObjects?: Record<string, DurableObjectDesignator>;
  /** Binding names (or `binding → id`) for in-memory KV namespaces. */
  kvNamespaces?: string[] | Record<string, string>;
  r2Buckets?: string[] | Record<string, string>;
  queueProducers?: string[] | Record<string, string>;
  /** Plain `env` values (strings, JSON). */
  bindings?: Record<string, unknown>;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  /** Test globs (default `src/** /*.workers.test.ts`). */
  include?: string[];
  /** Path to a wrangler config to derive bindings from instead of (or in addition to) the options above. */
  wranglerConfigPath?: string;
  /** Extra Miniflare options merged last. */
  miniflare?: Record<string, unknown>;
  /** Merged last over `test`. */
  test?: NonNullable<ViteUserConfig['test']>;
}

/** The subset of `cloudflareTest()` options this preset produces (structural: no plugin import needed). */
export interface WorkersPoolOptionsLike {
  main?: string;
  wrangler?: { configPath?: string };
  miniflare?: Record<string, unknown> & {
    compatibilityDate?: string;
    compatibilityFlags?: string[];
    durableObjects?: Record<string, DurableObjectDesignator>;
    kvNamespaces?: string[] | Record<string, string>;
    r2Buckets?: string[] | Record<string, string>;
    queueProducers?: string[] | Record<string, string>;
    bindings?: Record<string, unknown>;
  };
}

export interface HypDrivWorkersProject {
  /** Vitest config without plugins (add `cloudflareTest(workersOptions)` yourself or use `defineHypDrivWorkersConfig`). */
  config: ViteUserConfig;
  /** Options to pass to `cloudflareTest()` from `@cloudflare/vitest-plugin`. */
  workersOptions: WorkersPoolOptionsLike;
}

export const DEFAULT_COMPATIBILITY_DATE = '2026-10-01';

/** Workers project pieces: config + the `cloudflareTest` options, without loading the plugin. */
export function hypdrivWorkersProject(
  name: string,
  options: HypDrivWorkersProjectOptions = {},
): HypDrivWorkersProject {
  const durableObjects = options.durableObjects
    ? Object.fromEntries(
        Object.entries(options.durableObjects).map(([binding, designator]) => [
          binding,
          typeof designator === 'string'
            ? { className: designator, useSQLite: true }
            : { useSQLite: true, ...designator },
        ]),
      )
    : undefined;
  const miniflare: NonNullable<WorkersPoolOptionsLike['miniflare']> = {
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: options.compatibilityFlags ?? ['nodejs_compat'],
    ...(durableObjects ? { durableObjects } : {}),
    ...(options.kvNamespaces ? { kvNamespaces: options.kvNamespaces } : {}),
    ...(options.r2Buckets ? { r2Buckets: options.r2Buckets } : {}),
    ...(options.queueProducers ? { queueProducers: options.queueProducers } : {}),
    ...(options.bindings ? { bindings: options.bindings } : {}),
    ...(options.miniflare ?? {}),
  };
  const workersOptions: WorkersPoolOptionsLike = {
    ...(options.main ? { main: options.main } : {}),
    ...(options.wranglerConfigPath ? { wrangler: { configPath: options.wranglerConfigPath } } : {}),
    miniflare,
  };
  return {
    config: {
      resolve: { conditions: ['source'] },
      test: {
        name,
        include: options.include ?? WORKERS_INCLUDE,
        ...(options.test ?? {}),
      },
    },
    workersOptions,
  };
}

type CloudflareTestFactory = (options: WorkersPoolOptionsLike) => unknown;

/**
 * Complete Workers config: imports `@cloudflare/vitest-plugin` lazily (so it is only needed where
 * Workers tests run) and wires `cloudflareTest(workersOptions)` as a plugin.
 *
 * ```ts
 * // vitest.workers.config.ts
 * import { defineHypDrivWorkersConfig } from '@hypdriv/testing/vitest';
 * export default defineHypDrivWorkersConfig('my-app-workers', { main: './src/worker.ts' });
 * ```
 */
export async function defineHypDrivWorkersConfig(
  name: string,
  options: HypDrivWorkersProjectOptions = {},
): Promise<ViteUserConfig> {
  const { config, workersOptions } = hypdrivWorkersProject(name, options);
  const specifier = '@cloudflare/vitest-plugin';
  let mod: { cloudflareTest?: CloudflareTestFactory };
  try {
    mod = (await import(/* @vite-ignore */ specifier)) as { cloudflareTest?: CloudflareTestFactory };
  } catch (err) {
    throw new Error(
      `defineHypDrivWorkersConfig("${name}") needs @cloudflare/vitest-plugin (pnpm add -D @cloudflare/vitest-plugin wrangler): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof mod.cloudflareTest !== 'function')
    throw new Error('@cloudflare/vitest-plugin does not export cloudflareTest()');
  const plugin = mod.cloudflareTest(workersOptions);
  return { ...config, plugins: [plugin as NonNullable<ViteUserConfig['plugins']>[number]] };
}

/** Node config ready to default-export from `vitest.config.ts`. */
export function defineHypDrivNodeConfig(
  name: string,
  options: HypDrivNodeProjectOptions = {},
): ViteUserConfig {
  return hypdrivNodeProject(name, options);
}
