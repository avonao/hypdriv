/**
 * Cloudflare image loader for `next/image` (`images.loaderFile`).
 *
 * This module must stay free of React and Node imports: Next.js bundles the loader file into every
 * client bundle that renders an image.
 *
 * OpenNext already serves `/_next/image` through the Images binding, so the loader is an optimisation
 * for applications on a Cloudflare zone: `/cdn-cgi/image/...` URLs are resized and cached by the zone
 * without a Worker invocation.
 */

export type ImageFormat = 'auto' | 'avif' | 'webp' | 'jpeg' | 'png' | 'baseline-jpeg' | 'json';
export type ImageFit = 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad' | 'squeeze';
export type ImageGravity =
  | 'auto'
  | 'face'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'center'
  | `${number}x${number}`;
export type ImageMetadata = 'keep' | 'copyright' | 'none';

/** Global loader configuration (`globalThis.__HYPDRIV_IMAGES__`), written by `configureImageLoader`. */
export interface ImageLoaderConfig {
  /**
   * Use `/cdn-cgi/image/...` URLs. `true` forces them, `false` falls back to `/_next/image`.
   * Undefined/`'auto'` means on in production builds and off in development (`next dev` has no zone).
   */
  cdnCgi?: boolean | 'auto';
  /** Default quality when `next/image` passes none (default 75). */
  quality?: number;
  /** Output format (default `auto`: AVIF/WebP negotiation by the zone). */
  format?: ImageFormat;
  /** Resize mode (default `scale-down`: never upscale). */
  fit?: ImageFit;
  /** Origin that serves `/cdn-cgi/image` when it differs from the page origin (e.g. an assets zone). */
  origin?: string;
  /** `basePath` of the Next.js app, prefixed to local `src` paths when building `/_next/image` URLs. */
  basePath?: string;
  /** Extra transformation options appended to every URL (`sharpen`, `metadata`, ...). */
  options?: Partial<Pick<CdnCgiOptions, 'sharpen' | 'blur' | 'gravity' | 'metadata' | 'dpr'>>;
}

export interface NextImageLoaderParams {
  src: string;
  width: number;
  quality?: number;
}

export interface CdnCgiOptions {
  src: string;
  width: number;
  quality?: number;
  format?: ImageFormat;
  fit?: ImageFit;
  dpr?: number;
  sharpen?: number;
  blur?: number;
  gravity?: ImageGravity;
  metadata?: ImageMetadata;
  height?: number;
  /** Origin prefix (default: none → path-relative URL). */
  origin?: string;
}

const GLOBAL_KEY = '__HYPDRIV_IMAGES__';
const LEGACY_FLAG_KEY = '__HYPDRIV_IMAGE_CDN_CGI__';
const DEFAULT_QUALITY = 75;

type ImageGlobals = {
  [GLOBAL_KEY]?: ImageLoaderConfig;
  [LEGACY_FLAG_KEY]?: boolean;
};

declare const process: { env: Record<string, string | undefined> };

/** Sets the global loader configuration (called by `withHypDriv` and by tests). */
export function configureImageLoader(config: ImageLoaderConfig | null): void {
  const g = globalThis as ImageGlobals;
  if (config === null) delete g[GLOBAL_KEY];
  else g[GLOBAL_KEY] = { ...(g[GLOBAL_KEY] ?? {}), ...config };
}

let inlined: ImageLoaderConfig | null | undefined;

/**
 * Build-time configuration: `withHypDriv` sets `env.HYPDRIV_IMAGES` in `next.config`, which Next.js
 * inlines into server and client bundles (the global below does not reach the browser).
 */
function inlinedConfig(): ImageLoaderConfig | null {
  if (inlined !== undefined) return inlined;
  try {
    // Written literally so the bundler replaces it with the JSON string at build time.
    const raw = process.env.HYPDRIV_IMAGES;
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    inlined = parsed && typeof parsed === 'object' ? (parsed as ImageLoaderConfig) : null;
  } catch {
    inlined = null;
  }
  return inlined;
}

/** Current loader configuration: build-time `HYPDRIV_IMAGES` overlaid with `configureImageLoader()` (empty when neither is set). */
export function getImageLoaderConfig(): ImageLoaderConfig {
  const fromGlobal = (globalThis as ImageGlobals)[GLOBAL_KEY];
  const fromBuild = inlinedConfig();
  if (!fromBuild) return fromGlobal ?? {};
  return fromGlobal ? { ...fromBuild, ...fromGlobal } : fromBuild;
}

/** Test seam: forget the cached build-time configuration. */
export function resetInlinedImageConfig(): void {
  inlined = undefined;
}

function isProductionBuild(): boolean {
  try {
    // Written literally so Next's bundlers inline it in client bundles; the guard keeps the file safe in
    // runtimes without `process` (treated as production: a zone is the common deployment target).
    const value = process.env.NODE_ENV;
    return value === undefined ? true : value === 'production';
  } catch {
    return true;
  }
}

/** Resolves whether `/cdn-cgi/image` URLs are enabled right now. */
export function isCdnCgiEnabled(config: ImageLoaderConfig = getImageLoaderConfig()): boolean {
  const legacy = (globalThis as ImageGlobals)[LEGACY_FLAG_KEY];
  if (legacy === false) return false;
  if (config.cdnCgi === true) return true;
  if (config.cdnCgi === false) return false;
  return isProductionBuild();
}

const PASSTHROUGH_RE = /^(data:|blob:)/i;
const SVG_RE = /\.svg(\?.*)?$/i;
const ABSOLUTE_RE = /^https?:\/\//i;

/** Sources Cloudflare cannot or should not transform are returned untouched. */
export function isPassthroughSource(src: string): boolean {
  return PASSTHROUGH_RE.test(src) || SVG_RE.test(src);
}

function clampQuality(quality: number | undefined, fallback: number): number {
  const q = quality === undefined || !Number.isFinite(quality) ? fallback : Math.round(quality);
  return Math.min(100, Math.max(1, q));
}

function encodeLocalPath(src: string): string {
  // Encode each segment, but keep already-encoded sequences and the query string intact.
  const [path, query] = src.split(/\?(.*)/s, 2);
  const encoded = (path ?? '')
    .split('/')
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join('/');
  return query ? `${encoded}?${query}` : encoded;
}

/**
 * Builds a `/cdn-cgi/image/<options>/<source>` URL. Absolute sources are kept as-is after the slash
 * (Cloudflare fetches them, subject to the zone's allowed origins); local sources are percent-encoded
 * per segment. Options always start with `width,quality,format,fit` so URLs are stable cache keys.
 */
export function buildCdnCgiUrl(options: CdnCgiOptions): string {
  const parts: string[] = [`width=${Math.max(1, Math.round(options.width))}`];
  if (options.height !== undefined) parts.push(`height=${Math.max(1, Math.round(options.height))}`);
  parts.push(`quality=${clampQuality(options.quality, DEFAULT_QUALITY)}`);
  parts.push(`format=${options.format ?? 'auto'}`);
  parts.push(`fit=${options.fit ?? 'scale-down'}`);
  if (options.dpr !== undefined && Number.isFinite(options.dpr))
    parts.push(`dpr=${Math.min(3, Math.max(1, options.dpr))}`);
  if (options.sharpen !== undefined && Number.isFinite(options.sharpen))
    parts.push(`sharpen=${Math.min(10, Math.max(0, options.sharpen))}`);
  if (options.blur !== undefined && Number.isFinite(options.blur))
    parts.push(`blur=${Math.min(250, Math.max(0, options.blur))}`);
  if (options.gravity) parts.push(`gravity=${options.gravity}`);
  if (options.metadata) parts.push(`metadata=${options.metadata}`);
  const source = ABSOLUTE_RE.test(options.src)
    ? options.src
    : encodeLocalPath(options.src.startsWith('/') ? options.src.slice(1) : options.src);
  const origin = options.origin ? options.origin.replace(/\/+$/, '') : '';
  return `${origin}/cdn-cgi/image/${parts.join(',')}/${source}`;
}

/** Builds the default Next.js optimiser URL: `/_next/image?url=<src>&w=<width>&q=<quality>`. */
export function buildNextImageUrl(params: NextImageLoaderParams & { basePath?: string }): string {
  const base = params.basePath ? params.basePath.replace(/\/+$/, '') : '';
  const q = clampQuality(params.quality, DEFAULT_QUALITY);
  return `${base}/_next/image?url=${encodeURIComponent(params.src)}&w=${Math.round(params.width)}&q=${q}`;
}

/**
 * The `next/image` loader (`images.loaderFile` default export). Uses `/cdn-cgi/image` when enabled
 * (production builds by default), otherwise `/_next/image`; `data:`, `blob:` and SVG sources pass through.
 */
export function cloudflareLoader({ src, width, quality }: NextImageLoaderParams): string {
  if (isPassthroughSource(src)) return src;
  const config = getImageLoaderConfig();
  const q = quality ?? config.quality ?? DEFAULT_QUALITY;
  if (!isCdnCgiEnabled(config))
    return buildNextImageUrl({ src, width, quality: q, basePath: config.basePath });
  return buildCdnCgiUrl({
    src,
    width,
    quality: q,
    format: config.format,
    fit: config.fit,
    origin: config.origin,
    ...(config.options ?? {}),
  });
}

export default cloudflareLoader;
