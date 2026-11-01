import { createRequire } from 'node:module';

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
