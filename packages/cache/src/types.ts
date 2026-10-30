import type {
  FlagValue,
  GeoProperties,
  HypContext,
  HypManifest,
  Logger,
  ResolvedConfig,
  ResolvedEdgeCachePolicy,
  Stage,
} from '@hypdriv/core';

/** Metadata stored next to every cached response (architecture §6). Durations are seconds, `storedAt` is epoch ms. */
export interface CacheMeta {
  key: string;
  storedAt: number;
  ttl: number;
  swr: number;
  staleIfError: number;
  tags: string[];
  buildId: string;
  policyId: string;
  /** Request header names the key depends on (emitted as `Vary`). */
  vary: string[];
  status: number;
}

/** A cached response plus its metadata. `set()` consumes the response body; `get()` returns a fresh one. */
export interface CacheEntry {
  response: Response;
  meta: CacheMeta;
}

/** Storage backend for the edge cache. Implementations must never throw synchronously; rejected promises are handled by the stage. */
export interface CacheStore {
  name: string;
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Tag → keys index used by `purgeTags`. */
export interface TagIndex {
  add(key: string, tags: string[], ttl: number): Promise<void>;
  keysFor(tags: string[]): Promise<string[]>;
  remove(keys: string[]): Promise<void>;
  /** Drops whole tag lists after a purge (implementations without a reverse index need this). */
  removeTags?(tags: string[]): Promise<void>;
}

export type CacheStatus =
  /** Cached by the hosting platform's CDN (Vercel) from headers HypDriv wrote, not by HypDriv's store. */
  'CDN' | 'HIT' | 'MISS' | 'STALE' | 'BYPASS' | 'REVALIDATED' | 'ERROR-STALE' | 'DYNAMIC' | 'NEGATIVE';

/** The outcome of the edge-cache stage for one request (`ctx.state.get(CACHE_DECISION_KEY)`). */
export interface CacheDecision {
  status: CacheStatus;
  /** Machine-readable detail, e.g. `fresh`, `coalesced`, `swr:revalidating`, `cookie:session`, `uncacheable:set-cookie`. */
  reason: string;
  policy?: ResolvedEdgeCachePolicy;
  key?: string;
  /** Age of the served entry in seconds (HIT/STALE/NEGATIVE/ERROR-STALE). */
  age?: number;
  tags?: string[];
}

/** Zone-level purge backend (Cloudflare API or a custom implementation). Must never throw. */
export interface Purger {
  purgeTags(tags: string[]): Promise<void>;
  purgeUrls(urls: string[]): Promise<void>;
}

/** Input of `buildCacheKey`. */
export interface CacheKeyInput {
  request: Request;
  url: URL;
  policy: ResolvedEdgeCachePolicy;
  buildId: string;
  geo?: GeoProperties;
  flags?: Record<string, FlagValue>;
  locale?: string;
  device?: string;
  trailingSlash: boolean | null;
  ignoredQuery: string[];
}

/** Resolvers for vary dimensions that other packages own (flags, locale, device class). */
export interface CacheDimensionResolvers {
  flags?(ctx: HypContext): Record<string, FlagValue> | undefined;
  locale?(ctx: HypContext): string | undefined;
  device?(ctx: HypContext): string | undefined;
}

export interface EdgeCacheOptions {
  store: CacheStore;
  tagIndex?: TagIndex;
  purger?: Purger;
  /** Clock in epoch milliseconds (tests). */
  now?: () => number;
  /** Known configuration; otherwise learned from the first request. Needed by `purgeUrls` outside a request. */
  config?: ResolvedConfig;
  manifest?: HypManifest;
  log?: Logger;
  /** How long coalesced followers wait for the leader before rendering themselves (ms, default 10000). */
  coalesceTimeoutMs?: number;
  resolvers?: CacheDimensionResolvers;
}

export interface EdgeCache {
  /** The `edge-cache` Drivetrain stage. */
  stage(): Stage;
  /** Deletes every entry indexed under the tags and asks the purger to purge them. Returns the number of keys deleted locally. */
  purgeTags(tags: string[]): Promise<number>;
  /** Deletes the base variant of each URL (GET, no vary dimensions) and asks the purger to purge the files. */
  purgeUrls(urls: string[]): Promise<number>;
  /** Serves a stale-if-error entry after the upstream threw, for runners that call `next` directly (see `UPSTREAM_KEY`). */
  recover(ctx: HypContext): Response | undefined;
  readonly store: CacheStore;
}
