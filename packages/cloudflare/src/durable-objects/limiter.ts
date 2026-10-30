import { DurableObject } from 'cloudflare:workers';

/**
 * `HypDrivLimiter` — exact counters and locks for one rate-limit key (one object per key).
 *
 * Methods are exposed over RPC (`stub.increment(...)`) and over `fetch` (JSON POST) so callers can use
 * whichever the runtime supports. State lives in memory and is persisted with `ctx.storage` so a
 * hibernated object resumes with correct counts; an alarm removes expired windows.
 */

interface WindowState {
  start: number;
  count: number;
  prevCount: number;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

interface LockState {
  holder: string;
  expiresAt: number;
}

export interface LimiterIncrementResult {
  count: number;
  resetAt: number;
}

export interface LimiterTokenResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface LimiterLockResult {
  acquired: boolean;
  holder: string | null;
  expiresAt: number | null;
}

const ALARM_INTERVAL_MS = 60_000;

export class HypDrivLimiter extends DurableObject {
  private windows = new Map<string, WindowState>();
  private buckets = new Map<string, BucketState>();
  private locks = new Map<string, LockState>();
  private loaded: Promise<void> | null = null;

  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      const [w, b, l] = await Promise.all([
        this.ctx.storage.get<Record<string, WindowState>>('windows'),
        this.ctx.storage.get<Record<string, BucketState>>('buckets'),
        this.ctx.storage.get<Record<string, LockState>>('locks'),
      ]);
      this.windows = new Map(Object.entries(w ?? {}));
      this.buckets = new Map(Object.entries(b ?? {}));
      this.locks = new Map(Object.entries(l ?? {}));
    })();
    await this.loaded;
  }

  private persist(): void {
    void this.ctx.storage.put({
      windows: Object.fromEntries(this.windows),
      buckets: Object.fromEntries(this.buckets),
      locks: Object.fromEntries(this.locks),
    });
    void this.ctx.storage.getAlarm().then((alarm) => {
      if (alarm === null) void this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    });
  }

  /** Fixed-window increment; the window is aligned to multiples of `windowSeconds`. */
  async increment(
    key: string,
    windowSeconds: number,
    now: number = Date.now(),
  ): Promise<LimiterIncrementResult> {
    await this.load();
    const windowMs = windowSeconds * 1000;
    const start = Math.floor(now / windowMs) * windowMs;
    const state = this.windows.get(key);
    let next: WindowState;
    if (!state || state.start !== start) {
      const prevCount = state && state.start === start - windowMs ? state.count : 0;
      next = { start, count: 1, prevCount };
    } else {
      next = { ...state, count: state.count + 1 };
    }
    this.windows.set(key, next);
    this.persist();
    return { count: next.count, resetAt: start + windowMs };
  }

  /** Sliding-window estimate: previous window weighted by the remaining fraction plus the current count. */
  async slidingCount(
    key: string,
    windowSeconds: number,
    now: number = Date.now(),
  ): Promise<LimiterIncrementResult> {
    const { count, resetAt } = await this.increment(key, windowSeconds, now);
    const state = this.windows.get(key)!;
    const windowMs = windowSeconds * 1000;
    const elapsed = (now - state.start) / windowMs;
    const weighted = Math.floor(state.prevCount * (1 - elapsed) + count);
    return { count: weighted, resetAt };
  }

  /** Token bucket with continuous refill. */
  async takeToken(
    key: string,
    capacity: number,
    refillPerSecond: number,
    now: number = Date.now(),
  ): Promise<LimiterTokenResult> {
    await this.load();
    const state = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, (now - state.updatedAt) / 1000);
    let tokens = Math.min(capacity, state.tokens + elapsedSeconds * refillPerSecond);
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    this.buckets.set(key, { tokens, updatedAt: now });
    this.persist();
    const deficit = Math.max(0, 1 - tokens);
    const resetAt = now + (refillPerSecond > 0 ? (deficit / refillPerSecond) * 1000 : 0);
    return { allowed, remaining: Math.floor(tokens), resetAt };
  }

  /** Acquires a lock for cross-isolate coalescing. Returns the current holder when taken. */
  async lock(
    key: string,
    holder: string,
    ttlMs: number,
    now: number = Date.now(),
  ): Promise<LimiterLockResult> {
    await this.load();
    const current = this.locks.get(key);
    if (current && current.expiresAt > now && current.holder !== holder) {
      return { acquired: false, holder: current.holder, expiresAt: current.expiresAt };
    }
    const expiresAt = now + ttlMs;
    this.locks.set(key, { holder, expiresAt });
    this.persist();
    return { acquired: true, holder, expiresAt };
  }

  async unlock(key: string, holder: string): Promise<boolean> {
    await this.load();
    const current = this.locks.get(key);
    if (!current || current.holder !== holder) return false;
    this.locks.delete(key);
    this.persist();
    return true;
  }

  /** Current state snapshot (debugging / tests). */
  async snapshot(): Promise<{ windows: number; buckets: number; locks: number }> {
    await this.load();
    return { windows: this.windows.size, buckets: this.buckets.size, locks: this.locks.size };
  }

  override async alarm(): Promise<void> {
    await this.load();
    const now = Date.now();
    for (const [k, w] of this.windows) if (now - w.start > 2 * 60 * 60 * 1000) this.windows.delete(k);
    for (const [k, b] of this.buckets) if (now - b.updatedAt > 24 * 60 * 60 * 1000) this.buckets.delete(k);
    for (const [k, l] of this.locks) if (l.expiresAt <= now) this.locks.delete(k);
    if (this.windows.size || this.buckets.size || this.locks.size) {
      await this.ctx.storage.put({
        windows: Object.fromEntries(this.windows),
        buckets: Object.fromEntries(this.buckets),
        locks: Object.fromEntries(this.locks),
      });
      await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
    } else {
      await this.ctx.storage.deleteAll();
    }
  }

  /** JSON transport: `POST /` with `{ op, args }`. */
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let body: { op?: string; args?: unknown[] };
    try {
      body = (await request.json()) as { op?: string; args?: unknown[] };
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    const ops: Record<string, (...args: never[]) => Promise<unknown>> = {
      increment: this.increment.bind(this) as never,
      slidingCount: this.slidingCount.bind(this) as never,
      takeToken: this.takeToken.bind(this) as never,
      lock: this.lock.bind(this) as never,
      unlock: this.unlock.bind(this) as never,
      snapshot: this.snapshot.bind(this) as never,
    };
    const fn = body.op ? ops[body.op] : undefined;
    if (!fn) return Response.json({ error: 'unknown_op' }, { status: 400 });
    const result = await fn(...((body.args ?? []) as never[]));
    return Response.json(result);
  }
}
