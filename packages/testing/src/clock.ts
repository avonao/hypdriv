/** A controllable clock shared by the fakes (KV expiry, cache TTLs, rate-limit windows). */
export interface FakeClock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Current time in epoch seconds (what KV `expiration` and `Expires` compare against). */
  nowSeconds(): number;
  /** Moves the clock forward by `ms` milliseconds. */
  advance(ms: number): void;
  /** Moves the clock forward by `seconds`. */
  tick(seconds: number): void;
  /** Sets the absolute time in epoch milliseconds. */
  set(ms: number): void;
}

/** Deterministic default start: 2026-01-01T00:00:00Z. */
export const DEFAULT_CLOCK_START = Date.UTC(2026, 0, 1);

/** Creates a clock that only moves when told to. */
export function createClock(startMs: number = DEFAULT_CLOCK_START): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    nowSeconds: () => Math.floor(current / 1000),
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0)
        throw new RangeError(`advance() expects a non-negative number, got ${ms}`);
      current += ms;
    },
    tick(seconds) {
      this.advance(seconds * 1000);
    },
    set(ms) {
      current = ms;
    },
  };
}
