/// <reference path="../../virtual.d.ts" />
import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { type HypDrivQwikVercelHandler, type QwikRouterVercelOptions, wrapVercel } from '../vercel';

export type { HypDrivQwikVercelHandler, QwikRouterVercelOptions, VercelRequestContext } from '../vercel';

/**
 * Qwik Router's Vercel entry behind the Drivetrain. The default export of `src/entry.vercel.tsx` is the Node.js
 * function the Hypdriv Vercel adapter writes into the Build Output (`.vercel/output/functions/_qwik-router.func`).
 *
 * ```tsx
 * // src/entry.vercel.tsx
 * import { createQwikRouter } from '@hypdriv/qwik/middleware/vercel';
 * import render from './entry.ssr';
 *
 * export default createQwikRouter({ render });
 * ```
 */
export function createQwikRouter(options: QwikRouterVercelOptions): HypDrivQwikVercelHandler {
  const { hypdriv, ...qwik } = options;
  return wrapVercel(qwik, { config, manifest, ...hypdriv });
}
