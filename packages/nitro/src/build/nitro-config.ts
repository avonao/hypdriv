import { createRequire } from 'node:module';
import { basename, dirname } from 'node:path';

/** Rollup's `external` option in the forms Nitro accepts. */
export type RollupExternal =
  | string
  | RegExp
  | Array<string | RegExp>
  | ((id: string, importer: string | undefined, isResolved: boolean) => boolean | null | undefined | void);

/** Adds a pattern to Rollup's `external` option, whatever form the application gave it. */
export function withExternal(existing: RollupExternal | undefined, pattern: RegExp): RollupExternal {
  if (typeof existing === 'function') {
    const previous = existing;
    return (id: string, importer: string | undefined, isResolved: boolean) =>
      pattern.test(id) || previous(id, importer, isResolved);
  }
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  return [...list, pattern];
}

/**
 * The module patterns Nitro must bundle for Hypdriv: this package's runtime directory, every `@hypdriv/*` package
 * (matched by name in an installed `node_modules`) and the directory that holds them. The last matters in a
 * workspace, where pnpm links packages and Nitro resolves them to real paths without `node_modules` in them (the
 * name no longer matches) — the prerender build would then leave `@hypdriv/runtime` external and unresolvable from
 * the application.
 */
export function bundledModules(runtimeDir: string): string[] {
  const root = dirname(runtimeDir);
  const scope = dirname(root);
  const name = basename(scope);
  const patterns = [runtimeDir, '@hypdriv/'];
  if (name === 'packages' || name === '@hypdriv') patterns.push(`${scope}/`);
  return patterns;
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

/** Escapes a string for use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Adds `values` to an array option without duplicating entries. */
export function pushUnique<T>(list: T[], ...values: T[]): T[] {
  for (const value of values) if (!list.includes(value)) list.push(value);
  return list;
}
