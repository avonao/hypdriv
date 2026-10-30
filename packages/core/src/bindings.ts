/**
 * Structural types for Cloudflare bindings. Runtime packages depend on these instead of
 * `@cloudflare/workers-types`, so they stay portable and testable with in-memory fakes.
 */

export interface KVNamespaceLike {
  get(key: string, options?: { type?: 'text'; cacheTtl?: number } | 'text'): Promise<string | null>;
  get(key: string, options: { type: 'json'; cacheTtl?: number } | 'json'): Promise<unknown>;
  get(
    key: string,
    options: { type: 'arrayBuffer'; cacheTtl?: number } | 'arrayBuffer',
  ): Promise<ArrayBuffer | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  [rpc: string]: unknown;
}

export interface DurableObjectIdLike {
  toString(): string;
  name?: string;
}

export interface DurableObjectNamespaceLike<Stub extends DurableObjectStubLike = DurableObjectStubLike> {
  idFromName(name: string): DurableObjectIdLike;
  idFromString?(id: string): DurableObjectIdLike;
  newUniqueId?(): DurableObjectIdLike;
  get(id: DurableObjectIdLike, options?: { locationHint?: string }): Stub;
}

export interface AnalyticsEngineLike {
  writeDataPoint(event: { indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }): void;
}

export interface RateLimitBindingLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface QueueLike<Body = unknown> {
  send(
    body: Body,
    options?: { contentType?: 'json' | 'text' | 'bytes' | 'v8'; delaySeconds?: number },
  ): Promise<void>;
  sendBatch?(
    messages: Iterable<{ body: Body; contentType?: 'json' | 'text' | 'bytes' | 'v8'; delaySeconds?: number }>,
  ): Promise<void>;
  /**
   * Producers backed by a lazily registered SDK (Vercel Queues) report whether they can send right now;
   * `enqueue()` falls back to invoking the consumer route when this returns `false`.
   */
  ready?(): boolean;
}

export interface FetcherLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
  props?: Record<string, unknown>;
}

export interface CacheStorageLike {
  default?: CacheLike;
  open?(name: string): Promise<CacheLike>;
}

export interface CacheLike {
  match(request: RequestInfo | URL, options?: { ignoreMethod?: boolean }): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL, options?: { ignoreMethod?: boolean }): Promise<boolean>;
}

export interface ImagesBindingLike {
  input(stream: ReadableStream<Uint8Array>): unknown;
  info?(stream: ReadableStream<Uint8Array>): Promise<unknown>;
}

export interface AiBindingLike {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** A Worker `env` with the bindings HypDriv knows how to use, all optional. */
export interface HypDrivEnv {
  HYPDRIV_KV?: KVNamespaceLike;
  HYPDRIV_INDEX?: DurableObjectNamespaceLike;
  HYPDRIV_LIMITER?: DurableObjectNamespaceLike;
  HYPDRIV_CHANNEL?: DurableObjectNamespaceLike;
  HYPDRIV_RATE_LIMIT?: RateLimitBindingLike;
  HYPDRIV_ANALYTICS?: AnalyticsEngineLike;
  ASSETS?: FetcherLike;
  IMAGES?: ImagesBindingLike;
  AI?: AiBindingLike;
  HYPDRIV_SESSION_SECRET?: string;
  HYPDRIV_INTERNAL_SECRET?: string;
  HYPDRIV_MAINTENANCE?: string;
  HYPDRIV_FLAGS?: string;
  TURNSTILE_SECRET_KEY?: string;
  CACHE_PURGE_ZONE_ID?: string;
  CACHE_PURGE_API_TOKEN?: string;
  NEXTJS_ENV?: string;
  [binding: string]: unknown;
}

/** Returns the Cloudflare `cf` object from a Request when present. */
export function getCf(request: Request): Record<string, unknown> | undefined {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
  return cf && typeof cf === 'object' ? cf : undefined;
}
