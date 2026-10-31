/// <reference types="@hypdriv/vite/virtual" />

import config from 'virtual:hypdriv/config';
import { assetsWorker } from '@hypdriv/vite/worker';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

export default assetsWorker({
  config,
  manifest: () => import('virtual:hypdriv/manifest'),
  // Your own API next to the static app; everything else is served from the assets.
  handle(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/time') return Response.json({ now: new Date().toISOString() });
    return null;
  },
});
