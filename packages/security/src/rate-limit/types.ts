import type { ResolvedRateLimitPolicy } from '@hypdriv/core';

/** Result of a counter increment for a fixed or sliding window. */
export interface CounterResult {
  /** Requests counted in the window after this increment (fractional for sliding windows). */
  count: number;
  /** Epoch milliseconds when the window resets. */
  resetAt: number;
}

/** Result of taking one token from a bucket. */
export interface TokenResult {
  allowed: boolean;
  /** Whole tokens left after this call. */
  remaining: number;
  /** Epoch milliseconds when the next token is available (denied) or the bucket is full again (allowed). */
  resetAt: number;
}

/**
 * Counter storage used by the rate limiter. `increment` (fixed window) is mandatory; the other two are
 * optional native implementations the limiter prefers over its generic emulations.
 * All timestamps are epoch milliseconds.
 */
export interface CounterStore {
  /** Human-readable store name for diagnostics. */
  readonly name?: string;
  /** Fixed window: increments the counter of the window containing `now`. */
  increment(key: string, windowSeconds: number, now: number): Promise<CounterResult>;
  /** Sliding window: increments the current window and returns the weighted two-window count. */
  slidingCount?(key: string, windowSeconds: number, now: number): Promise<CounterResult>;
  /** Token bucket: takes one token, refilling `refillPerSecond` up to `capacity`. */
  takeToken?(key: string, capacity: number, refillPerSecond: number, now: number): Promise<TokenResult>;
}

/** Outcome of a rate-limit check. */
export interface RateLimitResult {
  allowed: boolean;
  /** Policy limit (bucket capacity for token buckets). */
  limit: number;
  remaining: number;
  /** Epoch milliseconds when the quota resets (or the next token is available when denied). */
  resetAt: number;
  /** Seconds to wait before retrying; `0` when allowed. */
  retryAfter: number;
  /** Window length in seconds (quota policy `w=`). */
  window: number;
  /** `true` when the store failed and the limiter failed open. */
  degraded?: boolean;
}

/** Checks a policy for a key. */
export interface RateLimiter {
  check(policy: ResolvedRateLimitPolicy, key: string, now?: number): Promise<RateLimitResult>;
}

/** Window arithmetic shared by every store. */
export function windowBounds(
  now: number,
  windowSeconds: number,
): { index: number; start: number; resetAt: number } {
  const windowMs = Math.max(1, Math.round(windowSeconds * 1000));
  const index = Math.floor(now / windowMs);
  const start = index * windowMs;
  return { index, start, resetAt: start + windowMs };
}

/** Weighted two-window approximation: `prev * (1 - elapsed/window) + current`. */
export function slidingEstimate(
  prevCount: number,
  currentCount: number,
  now: number,
  windowSeconds: number,
): number {
  const windowMs = Math.max(1, Math.round(windowSeconds * 1000));
  const { start } = windowBounds(now, windowSeconds);
  const elapsed = Math.min(windowMs, Math.max(0, now - start));
  const weight = 1 - elapsed / windowMs;
  return prevCount * weight + currentCount;
}

/** Pure token-bucket step used by every store (and the Durable Object in `@hypdriv/cloudflare`). */
export function takeFromBucket(
  state: { tokens: number; updatedAt: number } | null,
  capacity: number,
  refillPerSecond: number,
  now: number,
): { state: { tokens: number; updatedAt: number }; result: TokenResult } {
  const cap = Math.max(1, capacity);
  const refill = Math.max(refillPerSecond, 1e-9);
  let tokens = state ? Math.min(cap, state.tokens + ((now - state.updatedAt) / 1000) * refill) : cap;
  if (tokens < 0 || !Number.isFinite(tokens)) tokens = cap;
  const allowed = tokens >= 1;
  if (allowed) tokens -= 1;
  const resetAt = allowed
    ? now + Math.ceil(((cap - tokens) / refill) * 1000)
    : now + Math.ceil(((1 - tokens) / refill) * 1000);
  return {
    state: { tokens, updatedAt: now },
    result: { allowed, remaining: Math.max(0, Math.floor(tokens)), resetAt },
  };
}
