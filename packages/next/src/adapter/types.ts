/**
 * Structural types for the Next.js Adapter API (16.2+). They mirror
 * `next/dist/build/adapter/build-complete` without importing it, so the adapter and its tests do not
 * depend on Next's internal paths.
 */

export interface RouteHas {
  type: 'header' | 'cookie' | 'query' | 'host';
  key?: string;
  value?: string;
}

export interface SharedRouteFields {
  id: string;
  filePath: string;
  pathname: string;
  sourcePage: string;
  runtime: 'nodejs' | 'edge';
  assets: Record<string, string>;
  assetsHashes: Record<string, string>;
  wasmAssets?: Record<string, string>;
  edgeRuntime?: { modulePath: string; entryKey: string; handlerExport: string };
  config: { maxDuration?: number; preferredRegion?: string | string[]; env?: Record<string, string> };
}

export interface PrerenderOutput {
  id: string;
  pathname: string;
  type: 'PRERENDER';
  parentOutputId: string;
  groupId: number;
  route: string;
  routeType?: 'route' | 'fallback' | 'shell' | 'page';
  response?: 'empty' | 'initial' | 'complete';
  compute?: 'blocking' | 'resuming' | 'static';
  htmlSize?: number;
  pprChain?: { headers: Record<string, string> };
  parentFallbackMode?: false | null | string;
  fallback?: {
    filePath: string | undefined;
    initialStatus?: number;
    initialHeaders?: Record<string, string | string[]>;
    initialExpiration?: number;
    initialRevalidate?: number | false;
    postponedState?: string | undefined;
  };
  config: {
    allowQuery?: string[];
    allowHeader?: string[];
    bypassFor?: RouteHas[];
    renderingMode?: 'STATIC' | 'PARTIALLY_STATIC';
    partialFallback?: boolean;
    bypassToken?: string;
  };
}

export interface StaticFileOutput {
  id: string;
  filePath: string;
  pathname: string;
  type: 'STATIC_FILE';
  immutableHash: string | undefined;
}

export interface MiddlewareOutput extends SharedRouteFields {
  type: 'MIDDLEWARE';
  config: SharedRouteFields['config'] & {
    matchers?: Array<{ source: string; sourceRegex: string; has?: RouteHas[]; missing?: RouteHas[] }>;
  };
}

export interface AdapterOutputs {
  pages: Array<SharedRouteFields & { type: 'PAGES' }>;
  pagesApi: Array<SharedRouteFields & { type: 'PAGES_API' }>;
  appPages: Array<SharedRouteFields & { type: 'APP_PAGE' }>;
  appRoutes: Array<SharedRouteFields & { type: 'APP_ROUTE' }>;
  prerenders: PrerenderOutput[];
  staticFiles: StaticFileOutput[];
  middleware?: MiddlewareOutput;
}

export interface RoutingRoute {
  source?: string;
  sourceRegex: string;
  destination?: string;
  headers?: Record<string, string>;
  has?: RouteHas[];
  missing?: RouteHas[];
  status?: number;
  priority?: boolean;
}

export interface AdapterRouting {
  beforeMiddleware: RoutingRoute[];
  middlewareMatchers: RoutingRoute[];
  beforeFiles: RoutingRoute[];
  afterFiles: RoutingRoute[];
  dynamicRoutes: RoutingRoute[];
  onMatch: RoutingRoute[];
  fallback: RoutingRoute[];
  shouldNormalizeNextData: boolean;
  rsc: {
    header: string;
    varyHeader: string;
    prefetchHeader: string;
    didPostponeHeader: string;
    contentTypeHeader: string;
    suffix: string;
    prefetchSegmentHeader?: string;
    prefetchSegmentSuffix?: string;
    prefetchSegmentDirSuffix?: string;
    [key: string]: unknown;
  };
}

/** The subset of `NextConfigComplete` the adapter reads. */
export interface AdapterNextConfig {
  basePath?: string;
  trailingSlash?: boolean;
  cacheComponents?: boolean;
  deploymentId?: string;
  distDir?: string;
  output?: 'standalone' | 'export' | undefined;
  images?: { loader?: string; loaderFile?: string; remotePatterns?: unknown[] };
  experimental?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OnBuildCompleteContext {
  routing: AdapterRouting;
  outputs: AdapterOutputs;
  projectDir: string;
  repoRoot: string;
  distDir: string;
  config: AdapterNextConfig;
  nextVersion: string;
  buildId: string;
}

export interface ModifyConfigContext {
  phase: string;
  nextVersion: string;
  projectDir: string;
}

/** Shape of an adapter module (default export or named exports). */
export interface NextAdapterLike {
  name: string;
  modifyConfig?: (
    config: AdapterNextConfig,
    ctx: ModifyConfigContext,
  ) => Promise<AdapterNextConfig> | AdapterNextConfig;
  onBuildComplete?: (ctx: OnBuildCompleteContext) => Promise<void> | void;
}
