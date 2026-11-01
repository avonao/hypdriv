/**
 * `@hypdriv/waku` — Hypdriv for Waku. `withHypDriv()` wraps `waku.config.ts`:
 *
 * ```ts
 * // waku.config.ts
 * import { withHypDriv } from '@hypdriv/waku';
 * import { defineConfig } from 'waku/config';
 * export default defineConfig(withHypDriv({}));
 * ```
 *
 * It selects the Hypdriv adapter of the build's target (`@hypdriv/waku/adapters/node|vercel|cloudflare`, which
 * run the Drivetrain around Waku's server) and adds the Vite plugin that writes the route manifest, CSP hashes and
 * static headers. Request helpers for server components, server functions and API routes are in
 * `@hypdriv/waku/server`.
 */
export { type WithHypDrivOptions, withHypDriv } from './config';
export { type FindDocumentsOptions, findDocuments } from './documents';
export { HOST_LABEL, type HypDrivAdapterOptions, platformInput } from './entry';
export {
  type HypDrivWakuOptions,
  hypdriv,
  mergeRoutes,
  VIRTUAL_DURABLE_OBJECTS,
  wakuVersion,
} from './plugin';
export {
  discoverFileRoutes,
  discoverRoutes,
  type PageConfig,
  pagePattern,
  readPageConfig,
  scanCreatePages,
} from './routes';
export { ADAPTER_MODULES, detectTarget, resolveTarget, type WakuTarget } from './target';
export { type StaticDocumentFile, writeVercelOverrides } from './vercel';
