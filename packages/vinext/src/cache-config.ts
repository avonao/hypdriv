/** Virtual module that implements the CDN cache adapter `withHypDrivCache()` configures. */
export const VIRTUAL_CDN_ADAPTER = 'virtual:hypdriv/vinext-cdn';

/** A vinext cache adapter descriptor (`{ adapter, options, output, capabilities }`). */
export interface CacheAdapterDescriptorLike {
  adapter: string;
  options?: Record<string, unknown>;
  output?: unknown;
  capabilities?: {
    buildIdentity?: 'response-header';
    warmup?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** vinext's `cache` option (`vinext({ cache: { data, cdn } })`). */
export interface VinextCacheConfigLike {
  data?: CacheAdapterDescriptorLike;
  cdn?: CacheAdapterDescriptorLike;
}

/** What the generated adapter module needs to know about the wrapped adapter. */
export interface CdnAdapterSpec {
  /** Module of the application's CDN adapter (absent: vinext's default origin-managed adapter). */
  adapter: string | null;
  /** The default adapter stamps the build identity header (a data adapter declared it). */
  buildIdentity: boolean;
}

/** The virtual module id that carries `spec`. */
export function cdnAdapterId(spec: CdnAdapterSpec): string {
  const params = new URLSearchParams();
  if (spec.adapter) params.set('adapter', spec.adapter);
  if (spec.buildIdentity) params.set('buildIdentity', '1');
  const query = params.toString();
  return query ? `${VIRTUAL_CDN_ADAPTER}?${query}` : VIRTUAL_CDN_ADAPTER;
}

/** Parses a `virtual:hypdriv/vinext-cdn?…` id (null for other ids). */
export function parseCdnAdapterId(id: string): CdnAdapterSpec | null {
  const clean = id.startsWith('\0') ? id.slice(1) : id;
  if (clean !== VIRTUAL_CDN_ADAPTER && !clean.startsWith(`${VIRTUAL_CDN_ADAPTER}?`)) return null;
  const params = new URLSearchParams(clean.slice(VIRTUAL_CDN_ADAPTER.length + 1));
  return { adapter: params.get('adapter'), buildIdentity: params.get('buildIdentity') === '1' };
}

/** Source of the generated CDN adapter module. */
export function cdnAdapterModuleCode(spec: CdnAdapterSpec): string {
  const lines = [
    `import { withHypDrivPurge } from '@hypdriv/vinext/cache';`,
    spec.adapter
      ? `import { instantiateCacheAdapter } from 'vinext/shims/cache-adapter-instantiate';\nimport inner from ${JSON.stringify(spec.adapter)};`
      : `import { DefaultCdnCacheAdapter } from 'vinext/shims/cdn-cache';`,
    '',
    'export default function hypdrivCdnCacheAdapter(args) {',
    spec.adapter
      ? `  const adapter = instantiateCacheAdapter(inner, { env: args?.env, options: args?.options?.inner ?? undefined }, 'cdn');`
      : spec.buildIdentity
        ? '  const adapter = new DefaultCdnCacheAdapter(process.env.__VINEXT_RSC_BUILD_IDENTITY || process.env.__VINEXT_BUILD_ID);'
        : '  const adapter = new DefaultCdnCacheAdapter();',
    '  return withHypDrivPurge(adapter);',
    '}',
    '',
  ];
  return lines.join('\n');
}

/**
 * Wraps vinext's `cache` option so `revalidateTag()` / `revalidatePath()` also purge HypDriv's edge cache (and
 * the platform purger HypDriv registers, such as Vercel's CDN). The application's CDN adapter — or vinext's
 * default when none is configured — still does its own work; its build output hooks and capabilities are kept.
 *
 * ```ts
 * import vinext from 'vinext';
 * import { hypdriv, withHypDrivCache } from '@hypdriv/vinext';
 * import { workersCacheCdnAdapter } from '@vinext/cloudflare/cache/workers-cache-cdn-adapter';
 *
 * export default defineConfig({
 *   plugins: [vinext({ cache: withHypDrivCache({ cdn: workersCacheCdnAdapter() }) }), hypdriv()],
 * });
 * ```
 */
export function withHypDrivCache<C extends VinextCacheConfigLike>(
  cache?: C,
): C & { cdn: CacheAdapterDescriptorLike } {
  const config = (cache ?? {}) as C;
  const cdn = config.cdn;
  if (cdn && parseCdnAdapterId(cdn.adapter)) return config as C & { cdn: CacheAdapterDescriptorLike };
  const dataCapabilities = config.data?.capabilities;
  const buildIdentity = !cdn && dataCapabilities?.buildIdentity === 'response-header';
  // Without a CDN adapter of its own, vinext derives these from the data adapter; keep that behaviour.
  const inherited = cdn
    ? {}
    : {
        ...(buildIdentity ? { buildIdentity: 'response-header' as const } : {}),
        ...(dataCapabilities?.warmup === 'data-cache' ? { warmup: 'data-cache' } : {}),
      };
  const capabilities = { ...inherited, ...(cdn?.capabilities ?? {}) };
  return {
    ...config,
    cdn: {
      ...(cdn ?? {}),
      adapter: cdnAdapterId({ adapter: cdn?.adapter ?? null, buildIdentity }),
      options: { inner: cdn?.options ?? null },
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
    },
  };
}
