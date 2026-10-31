/**
 * `@hypdriv/build` — HypDriv's framework-neutral build engine (Node): turns the routes a framework integration
 * discovered into `.hypdriv/manifest.json` (classification, client assets, CSP hashes, Early Hints, speculation
 * graph, Purser verification, secrets scan, weights and budgets) and renders the build report. Used by the
 * Next.js adapter and every Vite integration.
 */
export {
  type AssembleManifestInput,
  assembleManifest,
  type BuildManifestResult,
  buildFingerprint,
  hashesFor,
  type ManifestRouteInput,
  type PurserVerifier,
  type PurserVerifierInput,
  type PurserVerifierResult,
  type SecretsScanner,
} from './assemble';
export { mergeWithHtml, type RouteAssetSources } from './assets';
export { type AdapterFs, createNodeFs, rerootPaths } from './fs';
export * from './html';
export { renderReport } from './report';
export {
  CLOUDFLARE_HEADERS_LIMITS,
  cloudflareHeaderNamesByPath,
  mergeVercelRoutes,
  renderCloudflareHeaders,
  type StaticDocument,
  type StaticHeaderRule,
  type StaticHeadersInput,
  staticCspHeaders,
  staticHeaderRules,
  VERCEL_ROUTE_MARKER,
  type VercelRoute,
  vercelSource,
} from './static-headers';
export { defaultPurserVerifier, defaultSecretsScanner } from './verifiers';
