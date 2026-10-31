/// <reference types="@hypdriv/vite/virtual" />

import config from 'virtual:hypdriv/config';
import { reactRouterWorker } from '@hypdriv/react-router/cloudflare';

// HypDriv's Durable Objects: rate-limit counters, the cache tag index and live channels.
export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

// The HypDriv Worker shell around React Router: every request the Worker receives runs the pipeline; prerendered
// pages and public files come from the assets binding, the rest from React Router. `scheduled`, `queue` and
// `email` dispatch HypDriv's jobs.
export default reactRouterWorker({ config });
