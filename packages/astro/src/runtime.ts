/// <reference path="../virtual.d.ts" />

import { development, target } from 'virtual:hypdriv/astro';
import config from 'virtual:hypdriv/config';
import { createAstroHandler } from './hook';

/**
 * The application's Hypdriv handler, shared by the middleware and `withHypDriv()` (`src/fetch.ts`) so one
 * platform (rate-limit stores, flag providers) serves both. Initialised on the first request.
 */
export const handler = createAstroHandler({
  config,
  manifest: () => import('virtual:hypdriv/manifest'),
  development,
  target,
});
