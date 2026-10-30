import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from 'hypdriv/durable-objects';
export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js';

export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),
});
