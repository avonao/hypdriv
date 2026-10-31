/**
 * Registration of Vercel SDK functions that only exist as npm packages (`@vercel/firewall`, `botid`,
 * `@vercel/queue`). Hypdriv never imports them: a literal `import()` of an uninstalled package breaks the
 * application's build, so the application imports them itself and hands the functions over once, in
 * `instrumentation.ts` or `proxy.ts`:
 *
 * ```ts
 * import { checkRateLimit } from '@vercel/firewall';
 * import { checkBotId } from 'botid/server';
 * import { handleCallback, send, sendBatch } from '@vercel/queue';
 * import { registerVercelSdk } from '@hypdriv/vercel';
 *
 * registerVercelSdk({ checkRateLimit, checkBotId, queue: { send, sendBatch, handleCallback } });
 * ```
 *
 * The signatures below mirror `@vercel/firewall` 1.2, `botid` 1.5 and `@vercel/queue` 0.10.
 */

/** Options of `checkRateLimit` from `@vercel/firewall`. */
export interface CheckRateLimitOptions {
  /** The host name on which the rate limit rules are defined (development only). */
  firewallHostForDevelopment?: string;
  /** The entity being rate limited. Defaults to the client IP. */
  rateLimitKey?: string;
  /** The headers of the current request. */
  headers?: Headers | Record<string, string> | Record<string, string | string[]>;
  /** The current request. */
  request?: Request;
  /** Fetch timeout in milliseconds. */
  timeout?: number;
}

/** Result of `checkRateLimit` from `@vercel/firewall`. */
export interface CheckRateLimitResult {
  rateLimited: boolean;
  error?: 'not-found' | 'blocked';
}

/** `checkRateLimit` from `@vercel/firewall`. */
export type CheckRateLimitFn = (
  rateLimitId: string,
  options?: CheckRateLimitOptions,
) => Promise<CheckRateLimitResult>;

/** Incoming-message style headers accepted by `checkBotId`'s `advancedOptions.headers`. */
export type BotIdHeaders = Record<string, string | string[] | undefined>;

/** Options of `checkBotId` from `botid/server`. */
export interface CheckBotIdOptions {
  developmentOptions?: {
    bypass?: 'HUMAN' | 'BAD-BOT' | 'GOOD-BOT' | 'ALLOWED';
    isDevelopment?: boolean;
  };
  advancedOptions?: {
    checkLevel?: 'deepAnalysis' | 'basic';
    extraAllowedHosts?: string[];
    headers?: BotIdHeaders;
    returnResponseHeaders?: boolean;
    vercelOidcToken?: string;
  };
}

/** Result of `checkBotId` from `botid/server`. */
export interface CheckBotIdResult {
  isHuman: boolean;
  isBot: boolean;
  isVerifiedBot: boolean;
  bypassed: boolean;
  verifiedBotName?: string | undefined;
  verifiedBotCategory?: string | undefined;
  classificationReason?: string | undefined;
}

/** `checkBotId` from `botid/server`. */
export type CheckBotIdFn = (options?: CheckBotIdOptions) => Promise<CheckBotIdResult>;

/** Per-message options of `send` from `@vercel/queue`. */
export interface QueueSendOptions {
  idempotencyKey?: string;
  retentionSeconds?: number;
  delaySeconds?: number;
  headers?: Record<string, string>;
}

/** `send` from `@vercel/queue`. */
export type QueueSendFn = (
  topicName: string,
  payload: unknown,
  options?: QueueSendOptions,
) => Promise<{ messageId: string | null }>;

/** One per-message result of `sendBatch` from `@vercel/queue`. */
export type QueueBatchSendResult =
  | { status: 'sent'; messageId: string }
  | { status: 'deferred'; messageId: null }
  | { status: 'failed'; statusCode: number; error: string; retryable: boolean };

/** `sendBatch` from `@vercel/queue` (up to 100 messages per call). */
export type QueueSendBatchFn = (
  topicName: string,
  messages: ReadonlyArray<{ payload: unknown } & QueueSendOptions>,
) => Promise<QueueBatchSendResult[]>;

/** Metadata `@vercel/queue` hands to a message handler. */
export interface QueueMessageMetadata {
  messageId: string;
  deliveryCount: number;
  createdAt: Date;
  expiresAt: Date;
  topicName: string;
  consumerGroup: string;
  region: string;
}

/** What a retry handler may return: redeliver after N seconds, or acknowledge (drop) the message. */
export type QueueRetryDirective = { afterSeconds: number } | { acknowledge: true };

/** Options of `handleCallback` from `@vercel/queue`. */
export interface QueueCallbackOptions {
  visibilityTimeoutSeconds?: number;
  retry?: (error: unknown, metadata: QueueMessageMetadata) => QueueRetryDirective | undefined;
}

/** A `@vercel/queue` message handler. */
export type QueueMessageHandler = (message: unknown, metadata: QueueMessageMetadata) => Promise<void> | void;

/** `handleCallback` from `@vercel/queue`. */
export type QueueHandleCallbackFn = (
  handler: QueueMessageHandler,
  options?: QueueCallbackOptions,
) => (request: Request) => Promise<Response>;

/** The SDK functions Hypdriv can use. Every entry is optional. */
export interface VercelSdk {
  /** `checkRateLimit` (or `unstable_checkRateLimit`) from `@vercel/firewall`. */
  checkRateLimit?: CheckRateLimitFn;
  /** `checkBotId` from `botid/server`. */
  checkBotId?: CheckBotIdFn;
  /** `send`, `handleCallback` and optionally `sendBatch` from `@vercel/queue`. */
  queue?: {
    send: QueueSendFn;
    handleCallback: QueueHandleCallbackFn;
    sendBatch?: QueueSendBatchFn;
  };
}

const SDK_KEY = Symbol.for('hypdriv.vercel.sdk');

/**
 * Registers Vercel SDK functions for Hypdriv (merged with earlier registrations, so packages can be
 * registered from different modules). Call it once per process, before the first request needs them.
 */
export function registerVercelSdk(sdk: VercelSdk): void {
  const store = globalThis as Record<symbol, unknown>;
  const current = (store[SDK_KEY] as VercelSdk | undefined) ?? {};
  store[SDK_KEY] = { ...current, ...sdk };
}

/** The registered SDK functions (an empty object when nothing was registered). */
export function getVercelSdk(): Readonly<VercelSdk> {
  return ((globalThis as Record<symbol, unknown>)[SDK_KEY] as VercelSdk | undefined) ?? {};
}

/** Test helper: removes every registration. */
export function __resetVercelSdk(): void {
  delete (globalThis as Record<symbol, unknown>)[SDK_KEY];
}
