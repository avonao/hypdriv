import type { Plugin } from 'vite';
import { type HypDrivAdapterOptions, hypdrivAdapter } from './common';

export type { HypDrivAdapterOptions } from './common';

/**
 * The Hypdriv adapter for Node: Qwik Router's `node-server` build (an ESM server entry plus the client build in
 * `dist`) for an entry that uses `createQwikRouter` from `@hypdriv/qwik/middleware/node`.
 *
 * ```ts
 * // adapters/node/vite.config.ts
 * import { nodeAdapter } from '@hypdriv/qwik/adapters/node';
 * import { extendConfig } from '@qwik.dev/router/vite';
 * import baseConfig from '../../vite.config';
 *
 * export default extendConfig(baseConfig, () => ({
 *   build: { ssr: true, rolldownOptions: { input: ['src/entry.node.tsx'] } },
 *   plugins: [nodeAdapter({ ssg: { include: ['/*'], exclude: ['/api/*'] } })],
 * }));
 * ```
 */
export function nodeAdapter(options: HypDrivAdapterOptions = {}): Plugin[] {
  return hypdrivAdapter({
    name: 'hypdriv-node',
    options,
    config: () => ({
      ssr: { target: 'node' },
      build: { ssr: true },
      publicDir: false,
    }),
  });
}
