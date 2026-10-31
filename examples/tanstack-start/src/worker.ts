/// <reference types="@hypdriv/vite/virtual" />

import config from 'virtual:hypdriv/config';
import { createStartWorker } from '@hypdriv/tanstack-start/cloudflare';

// Durable Objects for the rate limiter, the cache tag index and live channels.
export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

// The Worker entry (wrangler `main`): HypDriv's shell runs the pipeline with HTMLRewriter around TanStack Start and
// handles `scheduled`, `queue` and `email`; the request middleware in src/start.ts passes through inside it.
export default createStartWorker({ config, manifest: () => import('virtual:hypdriv/manifest') });
