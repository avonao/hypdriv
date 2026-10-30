import { createWorker } from '@hypdriv/cloudflare';
import config from './hypdriv.config';

// Keep OpenNext's Durable Objects available to existing bindings.
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
// HypDriv's Durable Objects (optional bindings; see wrangler.jsonc).
export { HypDrivChannel, HypDrivLimiter, HypDrivIndex } from '@hypdriv/cloudflare/durable-objects';

export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
});
