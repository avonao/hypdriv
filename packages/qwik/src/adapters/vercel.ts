import { join } from 'node:path';
import { getParentDir } from '@qwik.dev/router/adapters/shared/vite';
import type { Plugin } from 'vite';
import {
  copyStaticOutput,
  FUNCTION_NAME,
  findVercelEntry,
  writeFunctionConfig,
  writeOutputConfig,
} from '../output/vercel';
import { type HypDrivAdapterOptions, hypdrivAdapter } from './common';

export type { HypDrivAdapterOptions } from './common';

/**
 * The Hypdriv adapter for Vercel: Qwik Router's server build as a Node.js Build Output function
 * (`.vercel/output/functions/_qwik-router.func`, Web API handler with response streaming) and the client build as
 * `.vercel/output/static`, for an entry that exports `createQwikRouter` from `@hypdriv/qwik/middleware/vercel` as
 * its default export. `vercel deploy --prebuilt` deploys the output as is; on Vercel `VERCEL=1` selects it.
 *
 * ```ts
 * // adapters/vercel/vite.config.ts
 * import { vercelAdapter } from '@hypdriv/qwik/adapters/vercel';
 * import { extendConfig } from '@qwik.dev/router/vite';
 * import baseConfig from '../../vite.config';
 *
 * export default extendConfig(baseConfig, () => ({
 *   build: {
 *     ssr: true,
 *     rolldownOptions: { input: ['src/entry.vercel.tsx'] },
 *     outDir: '.vercel/output/functions/_qwik-router.func',
 *   },
 *   plugins: [vercelAdapter({ ssg: { include: ['/*'], exclude: ['/api/*'] } })],
 * }));
 * ```
 */
export function vercelAdapter(options: HypDrivAdapterOptions = {}): Plugin[] {
  return hypdrivAdapter({
    name: 'hypdriv-vercel',
    platformOrigin: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL,
    options,
    config: (config) => {
      const conditions = ['node', 'import', 'module', 'browser', 'default'];
      return {
        resolve: { conditions },
        ssr: { resolve: { conditions }, target: 'node', noExternal: true },
        build: {
          ssr: true,
          outDir: config.build?.outDir || join('.vercel', 'output', 'functions', `${FUNCTION_NAME}.func`),
          rolldownOptions: { output: { format: 'es' } },
        },
        publicDir: false,
      };
    },
    async generate({
      outputEntries,
      clientPublicOutDir,
      serverOutDir,
      basePathname,
      noTrailingSlash,
      error,
    }) {
      const handler = findVercelEntry(outputEntries);
      if (!handler) {
        error(
          '@hypdriv/qwik: the Vercel build has no entry.vercel module; set build.rolldownOptions.input to ["src/entry.vercel.tsx"] in adapters/vercel/vite.config.ts',
        );
        return;
      }
      let outputDir: string;
      try {
        outputDir = getParentDir(serverOutDir, 'output');
      } catch {
        error(
          `@hypdriv/qwik: the server build went to ${serverOutDir}, outside a Vercel Build Output; set build.outDir to '.vercel/output/functions/${FUNCTION_NAME}.func' in adapters/vercel/vite.config.ts`,
        );
        return;
      }
      writeFunctionConfig({ functionDir: serverOutDir, handler });
      copyStaticOutput({ clientDir: clientPublicOutDir, outputDir, basePathname });
      writeOutputConfig({ outputDir, basePathname, noTrailingSlash });
    },
  });
}
