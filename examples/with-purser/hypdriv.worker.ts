import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from 'hypdriv/durable-objects';
// OpenNext's Durable Objects (queue, tag cache, purge) and HypDriv's.
export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js';

export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),
});
