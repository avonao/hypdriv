/**
 * The build manifest written by the HypDriv adapter (`.hypdriv/manifest.json`) and read by the
 * Worker shell, the proxy composables and the CLI. See docs/architecture.md §4.
 */

export const MANIFEST_VERSION = 1 as const;

/**
 * - `app-page` / `app-route`: Next.js App Router page / Route Handler
 * - `page` / `page-api`: a Next.js Pages Router page / API route, or a page of any other framework
 * - `endpoint`: a server route of a non-Next framework (Astro endpoint, SvelteKit `+server`, React Router
 *   resource route, TanStack Start server route, Nuxt server handler)
 * - `static-file`: a file served as is
 */
export type RouteKind = 'app-page' | 'app-route' | 'page' | 'page-api' | 'endpoint' | 'static-file';

/** Frameworks HypDriv builds manifests for. */
export type FrameworkName =
  | 'next'
  | 'vite'
  | 'react-router'
  | 'tanstack-start'
  | 'astro'
  | 'sveltekit'
  | 'nuxt'
  | 'vinext';

/** The framework (and bundler) that produced a build. */
export interface ManifestFramework {
  name: FrameworkName;
  version: string;
  /** `turbopack` / `webpack` (Next.js) or `vite`. */
  bundler?: string;
  bundlerVersion?: string;
  /** Deployment adapter or preset the framework built for (`cloudflare`, `vercel`, `node`…), when known. */
  adapter?: string;
}
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
  /**
   * Data cache tags of the prerender besides Next's implicit path tags (`fetch`/`unstable_cache` tags):
   * `revalidateTag()` regenerates the page, so its HTML can change between deploys (classified `isr`).
   */
  tags?: string[];
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
  /**
   * The route answers every otherwise unmatched path with one shared document (a single-page app's shell). It is
   * never edge-cached by inference: other handlers may answer under the same pattern.
   */
  fallback?: boolean;
  /**
   * The route's prerendered document is a file the platform's static layer serves (Workers Static Assets, the
   * Vercel CDN, `hypdriv serve`), which caches it: no edge-cache policy is inferred for it.
   */
  servedStatically?: boolean;
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
  /**
   * Content fingerprint of the build output: Next's build id plus every route's client assets
   * (content-hashed file names), CSP hashes of prerendered HTML and HypDriv's inline-script hashes. Next.js
   * derives deterministic build ids from the deployment id, so two different outputs of the same commit can
   * share a `buildId`; edge-cache keys use this fingerprint (`cacheVersion()`) so a rebuild never serves
   * HTML that references another build's chunks or hashes.
   */
  fingerprint?: string;
  /**
   * Identifies Next.js's own ISR revalidation requests. OpenNext's revalidation queue re-requests stale
   * pages through the Worker with `x-prerender-revalidate: <previewModeId>`; the Worker shell recognises
   * them by this SHA-256 (hex) of the build's preview-mode id and sends them straight to Next.js — no edge
   * cache, bot shield or rate limit in between — then drops the stale edge-cache copies of the page. Only
   * the hash is stored; the id itself never leaves the build output. Not part of `fingerprint` (it changes
   * on every build even when the output does not).
   */
  revalidation?: { tokenHash: string };
  deploymentId?: string;
  /** The Next.js version (Next.js builds only). */
  nextVersion?: string;
  /** The framework that produced the build. Manifests without it come from Next.js builds. */
  framework?: ManifestFramework;
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
  /**
   * CSP hashes of HypDriv-owned inline scripts that render identically on every route (the `<Speculation/>`
   * document rules, the Purser theme fallback script). The CSP stage allows them in hash and nonce mode,
   * so these components never need a request nonce and layouts stay prerenderable.
   */
  inlineScriptHashes?: string[];
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

const FRAMEWORK_LABELS: Record<FrameworkName, string> = {
  next: 'Next.js',
  vite: 'Vite',
  'react-router': 'React Router',
  'tanstack-start': 'TanStack Start',
  astro: 'Astro',
  sveltekit: 'SvelteKit',
  nuxt: 'Nuxt',
  vinext: 'vinext',
};

/** The framework of a manifest (`{ name: 'next' }` for manifests written by the Next.js adapter). */
export function manifestFramework(
  manifest: Pick<HypManifest, 'framework' | 'nextVersion'>,
): ManifestFramework | null {
  if (manifest.framework) return manifest.framework;
  if (manifest.nextVersion && manifest.nextVersion !== 'unknown')
    return { name: 'next', version: manifest.nextVersion };
  return null;
}

/** Human-readable framework label: `Next.js 16.4.3`, `Astro 7.4.4 (Vite 8.3.5)`, or `unknown framework`. */
export function frameworkLabel(manifest: Pick<HypManifest, 'framework' | 'nextVersion'>): string {
  const f = manifestFramework(manifest);
  if (!f) return 'unknown framework';
  const name = FRAMEWORK_LABELS[f.name] ?? f.name;
  const bundler =
    f.bundler === 'vite' && f.name !== 'vite'
      ? ` (Vite${f.bundlerVersion ? ` ${f.bundlerVersion}` : ''})`
      : '';
  return `${name} ${f.version}${bundler}`;
}

/** The build identity edge-cache keys are scoped to: the content fingerprint, else the build id. */
export function cacheVersion(manifest: Pick<HypManifest, 'buildId' | 'fingerprint'>): string {
  return manifest.fingerprint ?? manifest.buildId;
}
