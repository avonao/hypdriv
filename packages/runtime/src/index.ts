/**
 * `@hypdriv/runtime` — Hypdriv's framework-neutral runtime: the Drivetrain stages and platform assembly shared by
 * the Cloudflare Worker shell, Next.js `proxy.ts` and every framework hook, plus `createHandler()`, which runs
 * the pipeline around any Web `fetch` handler on Cloudflare Workers, Vercel and Node.
 */

export { INDEX_SHARDS } from './cloudflare/constants';
export {
  callDurableObject,
  createDoCounterStore,
  createDoLock,
  createDoTagIndex,
  type DoLock,
} from './cloudflare/stores';
export { ensureContextStore } from './context-store';
export {
  type CreateHandlerOptions,
  createHandler,
  type HandleInput,
  type HandlerRuntime,
  type HypHandler,
  isStaticRequest,
  type ManifestSource,
  platformFor,
  type StageList,
} from './handler';
export {
  type CreateProxyHandlerOptions,
  createProxyHandler,
  type ProxyEventLike,
  type ProxyRequestLike,
} from './proxy';
export {
  createJobHandler,
  defer,
  devtoolsMeta,
  flag,
  geo,
  type HypRequestContext,
  hyp,
  type JobHandlerHost,
  type JobHandlerOptions,
  type JobInput,
  jobHandler,
  nonce,
  requestContextFrom,
  requireHyp,
} from './server';
export { readManifestFile, resetManifestFileCache } from './shared/manifest-file';
export * from './stages/index';
