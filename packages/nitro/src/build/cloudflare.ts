import { createRequire } from 'node:module';
import { VIRTUAL_CLOUDFLARE_EXPORTS } from '../runtime/options';

/** The Nitro major a Worker entry is generated for. */
export type NitroMajor = 2 | 3;

/**
 * Source of the Worker entry for the `cloudflare-module` preset. Nitro 2 evaluates its polyfills in the entry
 * module (they must come first); Nitro 3 injects them through its `polyfills` option.
 */
export function cloudflareEntryCode(workerModule: string, major: NitroMajor): string {
  return [
    ...(major === 2 ? ["import '#nitro-internal-pollyfills';"] : []),
    `export { default } from ${JSON.stringify(workerModule)};`,
    `export * from ${JSON.stringify(VIRTUAL_CLOUDFLARE_EXPORTS)};`,
    '',
  ].join('\n');
}

const DURABLE_OBJECTS_SPECIFIER = '@hypdriv/cloudflare/durable-objects';

/**
 * The Durable Object classes' module as a file this package resolves. The re-export module is virtual, so a bare
 * specifier in it resolves from the application, which need not depend on `@hypdriv/cloudflare` itself (pnpm does
 * not hoist it, and Rolldown, unlike Rollup, has no other place to look).
 */
export function durableObjectsEntry(from: string = import.meta.url): string {
  try {
    return createRequire(from).resolve(DURABLE_OBJECTS_SPECIFIER);
  } catch {
    return DURABLE_OBJECTS_SPECIFIER;
  }
}

/** Source of the Worker entry's re-exports: Hypdriv's Durable Objects and the application's own exports. */
export function cloudflareExportsCode(
  exportsModule: string | null,
  durableObjects: string = DURABLE_OBJECTS_SPECIFIER,
): string {
  const lines = [
    `export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from ${durableObjects === DURABLE_OBJECTS_SPECIFIER ? `'${durableObjects}'` : JSON.stringify(durableObjects)};`,
  ];
  if (exportsModule) lines.push(`export * from ${JSON.stringify(exportsModule)};`);
  return `${lines.join('\n')}\n`;
}
