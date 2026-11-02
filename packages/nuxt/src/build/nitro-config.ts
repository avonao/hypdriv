import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { NitroConfig } from 'nitropack';

type RollupExternal = NonNullable<NonNullable<NitroConfig['rollupConfig']>['external']>;

/** Adds a pattern to Rollup's `external` option, whatever form the application gave it. */
export function withExternal(existing: RollupExternal | undefined, pattern: RegExp): RollupExternal {
  if (typeof existing === 'function') {
    const previous = existing;
    return ((id: string, importer: string | undefined, isResolved: boolean) =>
      pattern.test(id) || previous(id, importer, isResolved)) as RollupExternal;
  }
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  return [...list, pattern] as RollupExternal;
}

/** The entry files of the Hypdriv packages the server runtime imports, resolved from this module. */
export function runtimePackages(from: string = import.meta.url): Record<string, string> {
  const require = createRequire(from);
  const out: Record<string, string> = {};
  for (const specifier of ['@hypdriv/core', '@hypdriv/flags', '@hypdriv/runtime']) {
    try {
      out[specifier] = require.resolve(specifier);
    } catch {
      // not resolvable from here: Nitro resolves it itself
    }
  }
  return out;
}

/**
 * The build output of `@hypdriv/nitro` (`dist`), which holds the Nitro 2 engine the Nuxt runtime files re-export
 * (capture response, hook, request helpers), or `null` when it cannot be resolved from here.
 */
export function nitroEngineDir(from: string = import.meta.url): string | null {
  try {
    return join(dirname(createRequire(from).resolve('@hypdriv/nitro/package.json')), 'dist');
  } catch {
    return null;
  }
}

/** Escapes a string for use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
