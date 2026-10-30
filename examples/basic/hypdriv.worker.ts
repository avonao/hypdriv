import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';

// HypDriv's Durable Objects (optional bindings; see wrangler.jsonc).
export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from 'hypdriv/durable-objects';
// Keep OpenNext's Durable Objects available to existing bindings.
export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js';

export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),
});
