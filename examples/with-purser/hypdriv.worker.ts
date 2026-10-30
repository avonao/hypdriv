import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';

// OpenNext's Durable Objects (queue, tag cache, purge) and HypDriv's.
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
export { HypDrivChannel, HypDrivLimiter, HypDrivIndex } from 'hypdriv/durable-objects';

export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),
});
