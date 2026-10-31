/// <reference types="@hypdriv/astro/virtual" />
// Cloudflare Worker entry (wrangler `main`): HypDriv's Worker shell around Astro's Cloudflare handler. The shell runs
// the Drivetrain for every request that reaches the Worker (prerendered pages through `env.ASSETS` included), adds
// `scheduled` / `queue` / `email` handlers for HypDriv jobs, and exports HypDriv's Durable Objects. The HypDriv
// middleware inside Astro passes through here: the shell already ran the stages.

import config from 'virtual:hypdriv/config';
import { handle } from '@astrojs/cloudflare/handler';
import { createWorker } from '@hypdriv/cloudflare';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

type AstroHandle = (request: Request, env: unknown, ctx: unknown) => Promise<Response>;

export default createWorker({
  config,
  manifest: () => import('virtual:hypdriv/manifest'),
  app: async () => ({
    fetch: (request, env, ctx) => (handle as AstroHandle)(request, env, ctx),
  }),
});
