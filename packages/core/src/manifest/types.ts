/**
 * The build manifest written by the HypDriv adapter (`.hypdriv/manifest.json`) and read by the
 * Worker shell, the proxy composables and the CLI. See docs/architecture.md §4.
 */

export const MANIFEST_VERSION = 1 as const;

export type RouteKind = 'app-page' | 'app-route' | 'page' | 'page-api' | 'static-file';
/**
 * - `static`: prerendered, never revalidates (immutable until the next deploy)
 * - `isr`: prerendered, revalidates in the background (content may change between deploys)
 * - `shell`: partially prerendered shell that resumes at request time (Cache Components / PPR)
 * - `dynamic`: rendered per request
 * - `route`: Route Handler / API route
 * - `asset`: static file
 */
export type RouteClassification = 'static' | 'isr' | 'shell' | 'dynamic' | 'route' | 'asset';

export interface HypRoutePrerender {
  routeType?: 'route' | 'fallback' | 'shell' | 'page';
  response?: 'empty' | 'initial' | 'complete';
  compute?: 'blocking' | 'resuming' | 'static';
  revalidate?: number | false;
  expire?: number;
  htmlSize?: number;
  /** Serves a partial fallback shell upgraded in the background (16.3+ ISR). */
  partialFallback?: boolean;
  renderingMode?: 'STATIC' | 'PARTIALLY_STATIC';
  /** Prerendered concrete paths for dynamic routes (first 200). */
  paths?: string[];
  pathCount?: number;
}

export interface HypRouteAssets {
  js: string[];
  css: string[];
  fonts: string[];
}

export interface HypRoute {
  id: string;
  pathname: string;
  regex: string;
  kind: RouteKind;
  classification: RouteClassification;
  runtime: 'nodejs' | 'edge';
  dynamic: boolean;
  prerender?: HypRoutePrerender;
  assets: HypRouteAssets;
  /** Resolved edge cache policy id (explicit or inferred). */
  cachePolicyId?: string;
  ensureStatic?: 'navigation' | 'prefetch' | 'shell';
  /** Source file relative to the project (e.g. `app/blog/[slug]/page.tsx`). */
  sourcePage?: string;
  /** Route segment config picked up from the build (`revalidate`, `dynamic`, `maxDuration`). */
  segment?: { maxDuration?: number; preferredRegion?: string | string[] };
}

export interface ProxyMatcher {
  source: string;
  sourceRegex: string;
  has?: Array<{ type: string; key?: string; value?: string }>;
  missing?: Array<{ type: string; key?: string; value?: string }>;
}

export interface PurserManifest {
  /** Project-relative path of the stylesheet Purser writes (e.g. `app/purser.css`). */
  stylesheet: string;
  /** Public URL of the CSS chunk Next.js emitted for it (e.g. `/_next/static/css/abc.css`), when found. */
  asset?: string;
  stylesheetHash: string;
  atoms: number;
  prefix: string;
  layers: { tokens: string; globals: string; atoms: string };
  /** Atoms referenced per route id (from prerendered HTML). */
  atomsByRoute: Record<string, string[]>;
  /** Atoms present in the stylesheet but referenced by no prerendered route. */
  unusedAtoms: string[];
  /** Classes referenced by HTML but missing from the stylesheet (should be empty). */
  missingAtoms: Record<string, string[]>;
  /** Hash of the theme fallback script, for CSP. */
  themeScriptHash?: string;
  themeScript?: string;
}

export interface WorkerWeight {
  file: string;
  raw: number;
  gzip: number;
  /** Approximate startup cost indicators. */
  topLevelAwaits: number;
  largestModules: Array<{ source: string; bytes: number; share: number }>;
  byPackage: Array<{ name: string; bytes: number; share: number }>;
  duplicates: Array<{ name: string; versions: string[] }>;
  sourceMap: boolean;
}

export interface BudgetResult {
  id: string;
  scope: 'route' | 'worker' | 'total';
  metric: string;
  limit: number;
  actual: number;
  status: 'ok' | 'warn' | 'error';
  target?: string;
}

export interface HypManifest {
  version: typeof MANIFEST_VERSION;
  buildId: string;
  deploymentId?: string;
  nextVersion: string;
  hypdrivVersion: string;
  generatedAt: string;
  basePath: string;
  trailingSlash: boolean;
  /** `true` when Cache Components were enabled for the build. */
  cacheComponents: boolean;
  routes: HypRoute[];
  proxy?: { matchers: ProxyMatcher[] };
  staticFiles: { count: number; immutablePrefixes: string[] };
  earlyHints: Record<string, string[]>;
  csp: Record<string, { scriptHashes: string[]; styleHashes: string[] }>;
  speculation: { graph: Record<string, string[]>; excluded: string[] };
  purser?: PurserManifest;
  weights: { client: Record<string, { js: number; css: number }>; worker?: WorkerWeight };
  budgets?: BudgetResult[];
  warnings: string[];
}

export interface RouteMatch {
  route: HypRoute;
  params: Record<string, string>;
}

/** The minimal manifest used when none is available (dev). */
export function emptyManifest(partial: Partial<HypManifest> = {}): HypManifest {
  return {
    version: MANIFEST_VERSION,
    buildId: 'development',
    nextVersion: 'unknown',
    hypdrivVersion: 'unknown',
    generatedAt: new Date(0).toISOString(),
    basePath: '',
    trailingSlash: false,
    cacheComponents: false,
    routes: [],
    staticFiles: { count: 0, immutablePrefixes: ['/_next/static/'] },
    earlyHints: {},
    csp: {},
    speculation: { graph: {}, excluded: [] },
    weights: { client: {} },
    warnings: [],
    ...partial,
  };
}

/** Structural validation of a manifest object (cheap, for runtime startup). */
export function assertManifest(value: unknown): asserts value is HypManifest {
  if (!value || typeof value !== 'object') throw new TypeError('manifest must be an object');
  const m = value as Partial<HypManifest>;
  if (m.version !== MANIFEST_VERSION)
    throw new TypeError(
      `unsupported manifest version ${String(m.version)} (expected ${MANIFEST_VERSION}); rebuild with the current @hypdriv/next`,
    );
  if (!Array.isArray(m.routes)) throw new TypeError('manifest.routes must be an array');
  if (typeof m.buildId !== 'string') throw new TypeError('manifest.buildId must be a string');
}
