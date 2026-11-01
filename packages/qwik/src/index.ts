/**
 * `@hypdriv/qwik` — Hypdriv for Qwik (Qwik v2 and Qwik Router, on Vite). Three parts:
 *
 * - `hypdriv()`, the Vite plugin for `vite.config.ts`: the route manifest from Qwik Router's route table, the CSP
 *   hashes of the prerendered pages and the platform's static headers, written after the server build.
 * - `@hypdriv/qwik/adapters/{node,vercel,cloudflare}`: Qwik Router adapters for `adapters/<target>/vite.config.ts`
 *   (static generation as Qwik does it, plus the Vercel Build Output or the Cloudflare Worker file).
 * - `@hypdriv/qwik/middleware/{node,vercel,cloudflare}`: `createQwikRouter` for `src/entry.<target>.tsx`, which
 *   runs the Drivetrain around Qwik's request handler.
 *
 * Request helpers for route loaders, actions, middleware and endpoints are in `@hypdriv/qwik/server`.
 */
export { type FindDocumentsOptions, findDocuments } from './documents';
export { HOST_LABEL } from './entry';
export {
  basePathOf,
  buildInputs,
  type HypDrivQwikOptions,
  hypdriv,
  qwikVersion,
  stripBase,
  VIRTUAL_DURABLE_OBJECTS,
} from './plugin';
export {
  type DiscoverRoutesOptions,
  discoverRoutes,
  isPageExtension,
  mergeRoutes,
  type QwikBuiltRoute,
} from './routes';
export {
  ADAPTER_MODULES,
  ADAPTER_PLUGIN_PREFIX,
  detectTarget,
  ENTRY_NAMES,
  isAdapterPlugin,
  type QwikTarget,
  resolveTarget,
  targetOfAdapter,
} from './target';
