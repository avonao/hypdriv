import type { RateLimitBindingLike, RateLimitStore, ResolvedRateLimitPolicy } from '@hypdriv/core';
import type { CounterStore, RateLimiter, RateLimitResult } from './types';

/** Options of `createRateLimiter`. */
export interface RateLimiterOptions {
  /** Default counter store. */
  store: CounterStore;
  /** Cloudflare Rate Limiting binding, used by policies with `store: 'binding'`. */
  binding?: RateLimitBindingLike;
  /** Per-kind stores for policies that pin a `store`; falls back to `store`. */
  stores?: Partial<Record<RateLimitStore, CounterStore>>;
  /** Allow requests when the store throws (default true: availability over strictness). */
  failOpen?: boolean;
  onError?: (error: unknown, policy: ResolvedRateLimitPolicy, key: string) => void;
}

function secondsUntil(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

/**
 * Creates a limiter that evaluates policies against counter stores (fixed window, sliding window,
 * token bucket) or Cloudflare's Rate Limiting binding. Stores without native sliding/bucket support
 * are emulated on top of `increment`.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const failOpen = options.failOpen ?? true;

  const storeFor = (policy: ResolvedRateLimitPolicy): CounterStore =>
    (policy.store !== 'auto' && policy.store !== 'binding' && options.stores?.[policy.store]) || options.store;

  async function evaluate(policy: ResolvedRateLimitPolicy, key: string, now: number): Promise<RateLimitResult> {
    const windowSeconds = policy.windowSeconds;
    if (policy.store === 'binding' && options.binding) {
      // The binding only reports success; remaining is unknown (1 while allowed, 0 once limited).
      const { success } = await options.binding.limit({ key });
      return {
        allowed: success,
        limit: policy.limit,
        remaining: success ? 1 : 0,
        resetAt: now + windowSeconds * 1000,
        retryAfter: success ? 0 : Math.max(1, Math.ceil(windowSeconds)),
        window: windowSeconds,
      };
    }
    const store = storeFor(policy);

    if (policy.algorithm === 'token-bucket') {
      const capacity = policy.limit + policy.burst;
      const refillPerSecond = policy.limit / Math.max(windowSeconds, 1e-9);
      if (store.takeToken) {
        const r = await store.takeToken(key, capacity, refillPerSecond, now);
        return {
          allowed: r.allowed,
          limit: capacity,
          remaining: r.remaining,
          resetAt: r.resetAt,
          retryAfter: r.allowed ? 0 : secondsUntil(r.resetAt, now),
          window: windowSeconds,
        };
      }
      // Emulation: a fixed window as long as a full refill, with the bucket capacity as its limit.
      const refillWindow = Math.max(1, Math.ceil(capacity / refillPerSecond));
      const r = await store.increment(key, refillWindow, now);
      const allowed = r.count <= capacity;
      return {
        allowed,
        limit: capacity,
        remaining: Math.max(0, capacity - r.count),
        resetAt: r.resetAt,
        retryAfter: allowed ? 0 : secondsUntil(r.resetAt, now),
        window: windowSeconds,
      };
    }

    const useSliding = policy.algorithm === 'sliding-window' && typeof store.slidingCount === 'function';
    const r = useSliding
      ? await store.slidingCount!(key, windowSeconds, now)
      : await store.increment(key, windowSeconds, now);
    const allowed = r.count <= policy.limit;
    return {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, Math.floor(policy.limit - r.count)),
      resetAt: r.resetAt,
      retryAfter: allowed ? 0 : secondsUntil(r.resetAt, now),
      window: windowSeconds,
    };
  }

  return {
    async check(policy, key, now = Date.now()) {
      try {
        return await evaluate(policy, key, now);
      } catch (error) {
        options.onError?.(error, policy, key);
        if (!failOpen) throw error;
        return {
          allowed: true,
          limit: policy.limit,
          remaining: policy.limit,
          resetAt: now + policy.windowSeconds * 1000,
          retryAfter: 0,
          window: policy.windowSeconds,
          degraded: true,
        };
      }
    },
  };
}
