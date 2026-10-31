import { VIRTUAL_CLOUDFLARE_EXPORTS } from '../runtime/options';

/** Source of the Worker entry for the `cloudflare-module` preset. */
export function cloudflareEntryCode(workerModule: string): string {
  return [
    "import '#nitro-internal-pollyfills';",
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
