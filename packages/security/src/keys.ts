import { type StateKey, stateKey } from '@hypdriv/core';

/** Per-request CSP nonce (set by the `csp` stage in nonce mode). */
export const NONCE_KEY: StateKey<string> = stateKey<string>('security.nonce');

/**
 * Effective CSP mode decided by the `csp` stage. `unsafe-inline-fallback` marks cached HTML
 * (`isr`/`shell` routes) served by a runtime without `HTMLRewriter`, where no nonce can be injected.
 */
export type CspMode = 'nonce' | 'hash' | 'report-only' | 'off' | 'unsafe-inline-fallback';

/** CSP mode chosen for the request (`report-only` wins over the underlying nonce/hash mode). */
export const CSP_MODE_KEY: StateKey<CspMode> = stateKey<CspMode>('security.csp-mode');

/**
 * Extra `'sha256-…'` script source expressions contributed by stages that inject deterministic inline
 * scripts at the edge (Speculation Rules, Purser theme fallback). Merged into `script-src` in hash mode;
 * ignored in nonce mode where edge nonce injection covers those scripts.
 */
export const CSP_EXTRA_HASHES_KEY: StateKey<string[]> = stateKey<string[]>('security.csp-extra-hashes');

/** One entry per rate-limit policy evaluated for the request. `reset` is the epoch-millisecond window reset. */
export interface RateLimitStateEntry {
  policy: string;
  remaining: number;
  limit: number;
  reset: number;
}

/** Rate-limit outcomes collected by the `rate-limit` stage. */
export const RATE_LIMIT_KEY: StateKey<RateLimitStateEntry[]> = stateKey<RateLimitStateEntry[]>(
  'security.rate-limit',
);

/** Bot classification verdicts. */
export type BotVerdict = 'human' | 'verified' | 'likely' | 'definite';

/** Result of `classifyRequest`, stored by the `bots` stage. */
export interface BotClassification {
  verdict: BotVerdict;
  /** Cloudflare Bot Management score (1–99) when available. */
  score?: number;
  /** Short machine-readable reason, e.g. `cf:verified-bot`, `ua:HeadlessChrome`, `honeypot`. */
  reason: string;
}

/** Bot verdict for the request. */
export const BOT_KEY: StateKey<BotClassification> = stateKey<BotClassification>('security.bot');
