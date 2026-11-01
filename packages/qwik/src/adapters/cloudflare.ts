import type { Plugin } from 'vite';
import { findCloudflareEntry, writeCloudflareWorker } from '../output/cloudflare';
import { type HypDrivAdapterOptions, hypdrivAdapter } from './common';

export type { HypDrivAdapterOptions } from './common';

/**
 * The Hypdriv adapter for Cloudflare Workers: Qwik Router's server build as one Worker module
 * (`dist/_worker.js`, wrangler's `main`) with the static client build in `dist` (the assets directory) for an entry
 * that exports `createQwikRouter` from `@hypdriv/qwik/middleware/cloudflare` as its default export.
 *
 * ```ts
 * // adapters/cloudflare/vite.config.ts
 * import { cloudflareAdapter } from '@hypdriv/qwik/adapters/cloudflare';
 * import { extendConfig } from '@qwik.dev/router/vite';
 * import baseConfig from '../../vite.config';
 *
 * export default extendConfig(baseConfig, () => ({
 *   build: { ssr: true, rolldownOptions: { input: ['src/entry.cloudflare.tsx'] } },
 *   plugins: [cloudflareAdapter({ ssg: { include: ['/*'], exclude: ['/api/*'] } })],
 * }));
 * ```
 */
export function cloudflareAdapter(options: HypDrivAdapterOptions = {}): Plugin[] {
  return hypdrivAdapter({
    name: 'hypdriv-cloudflare',
    platformOrigin: process.env.CF_PAGES_URL,
    options,
    config: () => ({
      resolve: { conditions: ['webworker', 'worker'] },
      ssr: { target: 'webworker', noExternal: true, external: ['node:async_hooks'] },
      // `cloudflare:*` modules (Durable Objects, bindings) and `node:*` modules (`nodejs_compat`) are the runtime's.
      build: {
        ssr: true,
        rolldownOptions: { external: [/^cloudflare:/, /^node:/], output: { format: 'es' } },
      },
      publicDir: false,
    }),
    async generate({ outputEntries, clientPublicOutDir, serverOutDir, error }) {
      const entryFile = findCloudflareEntry(outputEntries);
      if (!entryFile) {
        error(
          `@hypdriv/qwik: the Cloudflare build has no entry.cloudflare module (entries: ${outputEntries.join(', ') || 'none'}); set build.rolldownOptions.input to ["src/entry.cloudflare.tsx"] in adapters/cloudflare/vite.config.ts`,
        );
        return;
      }
      writeCloudflareWorker({ clientDir: clientPublicOutDir, serverDir: serverOutDir, entryFile, error });
    },
  });
}
