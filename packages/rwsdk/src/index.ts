/**
 * `@hypdriv/rwsdk` — Hypdriv for RedwoodSDK (React Server Components on Vite and Cloudflare Workers). Add the Vite
 * plugin next to `redwood()`, and wrap the app in the Worker entry:
 *
 * ```ts
 * // vite.config.mts
 * import { cloudflare } from '@cloudflare/vite-plugin';
 * import { hypdriv } from '@hypdriv/rwsdk';
 * import { redwood } from 'rwsdk/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({
 *   environments: { ssr: {} },
 *   plugins: [cloudflare({ viteEnvironment: { name: 'worker' } }), redwood(), hypdriv()],
 * });
 * ```
 *
 * ```tsx
 * // src/worker.tsx
 * import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';
 * import { render, route } from 'rwsdk/router';
 * import { defineApp } from 'rwsdk/worker';
 *
 * export default withHypDriv(defineApp([hypdrivMiddleware(), render(Document, [route('/', Home)])]));
 * ```
 *
 * The Worker-side API is in `@hypdriv/rwsdk/worker`; request helpers for route handlers, server components and
 * server functions are in `@hypdriv/rwsdk/server`.
 */
export { findWorkerEntry, rwsdkVersion, wranglerMain } from './entry';
export { type HypDrivRwsdkOptions, hypdriv, mergeRoutes, VIRTUAL_DURABLE_OBJECTS } from './plugin';
export {
  type AppManifestOptions,
  type AppRoute,
  appManifest,
  appRoutes,
  HOST_LABEL,
  handlerKind,
  manifestRoutes,
  rwsdkPattern,
} from './routes';
export { discoveredRoutes, parseJsonc, type ScannedRoute, type ScanResult, scanWorkerRoutes } from './scan';
