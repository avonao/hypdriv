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
export interface TagIndexAddOptions {
  /** When the response was requested from upstream (epoch ms): compared with purge tombstones. */
  fetchedAt?: number;
}

export interface TagIndex {
  /**
   * Associates a key with tags. Indexes that keep purge tombstones answer `{ stale: true }` when one of
   * the tags was purged at or after `fetchedAt`: the entry holds content generated before the purge and
   * must be dropped instead of indexed.
   */
  add(
    key: string,
    tags: string[],
    ttl: number,
    options?: TagIndexAddOptions,
  ): Promise<void | { stale?: boolean }>;
  keysFor(tags: string[]): Promise<string[]>;
  remove(keys: string[]): Promise<void>;
  /** Drops whole tag lists after a purge (implementations without a reverse index need this). */
  removeTags?(tags: string[]): Promise<void>;
  /**
   * Records purge tombstones: entries for these tags fetched up to `until` (epoch ms) are stale when they
   * are indexed later. Closes the race between a purge and a request already in flight (or one that reads
   * an upstream that has not applied the revalidation yet).
   */
  markPurged?(tags: string[], until: number): Promise<void>;
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
  /** Kept for callers; the key preserves the trailing slash as requested whatever this says. */
  trailingSlash?: boolean | null;
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
  /**
   * After a purge, responses fetched within this window are not kept (default 5000 ms): upstreams such as
   * Next.js apply `revalidateTag()` after the purge returns, so a request in between still receives old
   * content. Needs a tag index with tombstones (Durable Object or memory).
   */
  purgeGraceMs?: number;
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
