/**
 * `@hypdriv/next` — HypDriv for Next.js 16+.
 *
 * Entry points:
 * - `@hypdriv/next/config`          withHypDriv() for next.config.ts
 * - `@hypdriv/next/adapter`         the chained Next.js adapter (set automatically by withHypDriv)
 * - `@hypdriv/next/proxy`           createProxy() for proxy.ts
 * - `@hypdriv/next/stages`          stage factories, createPlatform(), buildDefaultStages()
 * - `@hypdriv/next/server`          hyp(), nonce(), geo(), flag(), defer(), jobHandler(), safeAction(), <Speculation/>
 * - `@hypdriv/next/client`          <VitalsReporter/>, <HypDrivDevTools/>, flags and live hooks
 * - `@hypdriv/next/cache`           revalidateTag(), revalidatePath(), purgeEdge()
 * - `@hypdriv/next/instrumentation` createInstrumentation()
 */
export { withHypDriv, PHASE, type WithHypDrivOptions } from './config/index';
export { createProxy, matcher } from './proxy/index';
export { buildDefaultStages, createPlatform, stages, type Platform } from './stages/index';
export { defineConfig } from '@hypdriv/core';
export type { HypDrivConfig, ResolvedConfig, HypManifest } from '@hypdriv/core';
