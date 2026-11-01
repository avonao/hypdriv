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

/** Source of the Worker entry's re-exports: Hypdriv's Durable Objects and the application's own exports. */
export function cloudflareExportsCode(exportsModule: string | null): string {
  const lines = [
    "export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';",
  ];
  if (exportsModule) lines.push(`export * from ${JSON.stringify(exportsModule)};`);
  return `${lines.join('\n')}\n`;
}
