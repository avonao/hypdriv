/// <reference types="@hypdriv/solid-start/virtual" />

import config from 'virtual:hypdriv/config';
import { createSolidStartWorker } from '@hypdriv/solid-start/cloudflare';

// Durable Objects for the rate limiter, the cache tag index and live channels.
export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

// The Worker entry (wrangler `main`): Hypdriv's shell runs the pipeline with HTMLRewriter around SolidStart and
// handles `scheduled`, `queue` and `email`. It is used with `@cloudflare/vite-plugin`; on Node and Vercel the Nitro
// plugin Hypdriv registers does the same job and this file is not part of the build.
export default createSolidStartWorker({
  config,
  manifest: () => import('virtual:hypdriv/manifest'),
  entry: () => import('./entry-server'),
});
