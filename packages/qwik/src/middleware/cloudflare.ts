/// <reference path="../../virtual.d.ts" />
import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { type HypDrivQwikWorker, type QwikRouterCloudflareOptions, wrapCloudflare } from '../cloudflare';

export type {
  HypDrivCloudflareOptions,
  HypDrivQwikWorker,
  HypDrivWorkerHandlers,
  QwikRouterCloudflareOptions,
} from '../cloudflare';

/**
 * Qwik Router's Cloudflare entry behind Hypdriv's Worker shell. The default export of `src/entry.cloudflare.tsx` is
 * the Worker: `createWorker()` runs the Drivetrain (with `HTMLRewriter`), `/_hypdriv/*`, the Durable Object stores
 * and the `scheduled` / `queue` / `email` job handlers in front of Qwik's request handler, which answers static
 * paths from the assets binding first.
 *
 * ```tsx
 * // src/entry.cloudflare.tsx
 * import { createQwikRouter } from '@hypdriv/qwik/middleware/cloudflare';
 * import render from './entry.ssr';
 *
 * export default createQwikRouter({ render });
 * ```
 */
export function createQwikRouter(options: QwikRouterCloudflareOptions): HypDrivQwikWorker {
  const { hypdriv, cache = true, ...qwik } = options;
  const { assets, handlers, ...runtime } = hypdriv ?? {};
  return wrapCloudflare(qwik, cache, {
    config,
    manifest,
    ...runtime,
    ...(assets !== undefined ? { assets } : {}),
    ...(handlers ? { handlers } : {}),
  });
}
