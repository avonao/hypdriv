/**
 * Stand-ins for the modules Nitro provides when it bundles the plugin (`#hypdriv/options`, `virtual:hypdriv/*`,
 * `nitropack/runtime`), aliased in `vitest.config.ts` for the plugin's tests.
 */
import { emptyManifest, type HypDrivConfig, type HypManifest } from '@hypdriv/core';

export const options = { target: 'node' as const, buildAssetsPath: '/_nuxt/', nonce: true, socketIp: true };

export const config: HypDrivConfig = { site: { name: 'nuxt-plugin-test' } };

export const manifest: HypManifest = emptyManifest({
  buildId: 'plugin-test',
  framework: { name: 'nuxt', version: '4.6.3' },
});

/** Route rules by path, as `getRouteRules(event)` returns them. */
export const routeRules: Record<string, { cache?: unknown }> = {};

export function getRouteRules(event: { path?: string; node: { req: { url?: string } } }): {
  cache?: unknown;
} {
  const path = (event.path ?? event.node.req.url ?? '/').split('?')[0]!;
  return routeRules[path] ?? {};
}
