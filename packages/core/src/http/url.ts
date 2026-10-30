import { DEFAULT_TRACKING_PARAMS } from '../config/defaults';

export interface NormalizeUrlOptions {
  /** Query parameters to drop (default: tracking parameters). */
  ignoredQuery?: readonly string[];
  /** Keep only these query parameters; `'all'` keeps everything not ignored; `'none'` drops the query. */
  keepQuery?: readonly string[] | 'all' | 'none';
  /** Next.js `trailingSlash` setting; `null` normalises to no trailing slash. */
  trailingSlash?: boolean | null;
  /** Lowercase the pathname (default false: Next routes are case-sensitive). */
  lowercasePath?: boolean;
  /** Remove the fragment (default true; fragments never reach servers anyway). */
  stripHash?: boolean;
}

const trackingSet = new Set(DEFAULT_TRACKING_PARAMS);

export function isTrackingParam(name: string): boolean {
  return (
    trackingSet.has(name) ||
    name.startsWith('utm_') ||
    name.startsWith('hsa_') ||
    name.startsWith('_hs') ||
    name.startsWith('mc_')
  );
}

/** Normalises a URL for cache keys and comparisons. Returns a new URL. */
export function normalizeUrl(input: URL | string, options: NormalizeUrlOptions = {}): URL {
  const url = new URL(typeof input === 'string' ? input : input.href);
  url.hostname = url.hostname.toLowerCase();
  if (options.stripHash !== false) url.hash = '';
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))
    url.port = '';

  // Collapse duplicate slashes and resolve dot segments defensively.
  let pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (options.lowercasePath) pathname = pathname.toLowerCase();
  pathname = normalizeTrailingSlash(pathname, options.trailingSlash ?? null);
  url.pathname = pathname;

  const ignored = new Set(options.ignoredQuery ?? DEFAULT_TRACKING_PARAMS);
  const keep = options.keepQuery ?? 'all';
  const params = [...url.searchParams.entries()].filter(([k]) => {
    if (keep === 'none') return false;
    if (Array.isArray(keep)) return keep.includes(k);
    return !ignored.has(k) && !(options.ignoredQuery === undefined && isTrackingParam(k));
  });
  params.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  url.search = '';
  for (const [k, v] of params) url.searchParams.append(k, v);
  return url;
}

/** Applies Next.js trailing-slash semantics to a pathname. Files with extensions are never slashed. */
export function normalizeTrailingSlash(pathname: string, trailingSlash: boolean | null): string {
  if (pathname === '/' || pathname === '') return '/';
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(pathname);
  const stripped = pathname.replace(/\/+$/, '') || '/';
  if (trailingSlash && !hasExt && stripped !== '/') return `${stripped}/`;
  return stripped;
}

/** Removes tracking parameters only (keeps order of the remaining ones). */
export function stripTrackingParams(url: URL): URL {
  const out = new URL(url.href);
  for (const key of [...out.searchParams.keys()]) if (isTrackingParam(key)) out.searchParams.delete(key);
  return out;
}

/** Same-origin check that tolerates default ports. */
export function isSameOrigin(a: URL | string, b: URL | string): boolean {
  const x = new URL(typeof a === 'string' ? a : a.href);
  const y = new URL(typeof b === 'string' ? b : b.href);
  return x.origin === y.origin;
}

/** `true` for paths that are Next.js internal assets or HypDriv internals. */
export function isInternalPath(pathname: string, internalPrefix = '/_hypdriv'): boolean {
  return (
    pathname.startsWith('/_next/') || pathname.startsWith(`${internalPrefix}/`) || pathname === internalPrefix
  );
}

/** `true` when a path points to a static asset by extension. */
export function looksLikeStaticAsset(pathname: string): boolean {
  return /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|txt|xml|json|webmanifest|pdf|mp4|webm|mp3|wasm)$/i.test(
    pathname,
  );
}

/** Decodes a pathname once, rejecting over-encoded traversal attempts; returns null when unsafe. */
export function safeDecodePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    decoded.includes('\0') ||
    /(^|\/)\.\.(\/|$)/.test(decoded) ||
    /%2e%2e|%2f|%5c/i.test(pathname) ||
    decoded.includes('\\')
  )
    return null;
  return decoded;
}

/** Joins a base path and a pathname without duplicate slashes. */
export function joinPath(base: string | null | undefined, pathname: string): string {
  const b = (base ?? '').replace(/\/+$/, '');
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${b}${p}` || '/';
}

/** Removes a base path prefix, when present. */
export function stripBasePath(pathname: string, basePath: string | null | undefined): string {
  if (!basePath || basePath === '/') return pathname;
  if (pathname === basePath) return '/';
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}
