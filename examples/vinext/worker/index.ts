/// <reference types="@hypdriv/vinext/virtual" />
// The Worker entry (wrangler `main`): Hypdriv's Worker shell around vinext's fetch handler, with the
// `scheduled` / `queue` / `email` handlers and Hypdriv's Durable Objects.

import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { createVinextWorker } from '@hypdriv/vinext/worker';
import handler from 'vinext/server/fetch-handler';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';
// vinext's named entrypoints (multi-stage cache adapters) stay top-level exports of the Worker.
export * from 'vinext/server/fetch-handler';

export default createVinextWorker({ config, manifest, app: handler });
