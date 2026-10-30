import {
  isHypDrivError,
  type KVNamespaceLike,
  parseDuration,
  type ResolvedRateLimitPolicy,
  sha256Hex,
  stableStringify,
} from '@hypdriv/core';
import { createRateLimiter } from './rate-limit/limiter';
import { createMemoryCounterStore } from './rate-limit/stores';
import type { RateLimiter, RateLimitResult } from './rate-limit/types';
import { type FieldErrors, type StandardSchemaV1, validateWithSchema } from './standard-schema';
import { TURNSTILE_TOKEN_FIELD, type TurnstileResult, verifyTurnstile } from './turnstile';

/** Stable error codes returned to clients. */
export type ActionErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CHALLENGE_FAILED'
  | 'CONFLICT'
  | 'INTERNAL';

const STATUS: Record<ActionErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  CHALLENGE_FAILED: 403,
  CONFLICT: 409,
  INTERNAL: 500,
};

/** Serialisable failure returned by `safeAction` and rendered as problem+json by `defineRoute`. */
export interface ActionFailure {
  code: ActionErrorCode;
  message: string;
  fieldErrors?: FieldErrors;
  /** Seconds to wait (rate limits). */
  retryAfter?: number;
}

export type ActionResult<Output> = { ok: true; data: Output } | { ok: false; error: ActionFailure };

/** Structured error for actions and route handlers. Thrown by guards/handlers, mapped to results/responses. */
export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly status: number;
  readonly fieldErrors?: FieldErrors;
  readonly retryAfter?: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ActionErrorCode,
    message?: string,
    options: {
      status?: number;
      fieldErrors?: FieldErrors;
      retryAfter?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(
      message ?? defaultMessage(code),
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'ActionError';
    this.code = code;
    this.status = options.status ?? STATUS[code];
    if (options.fieldErrors) this.fieldErrors = options.fieldErrors;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    this.details = options.details ?? {};
  }

  toFailure(): ActionFailure {
    const f: ActionFailure = { code: this.code, message: this.message };
    if (this.fieldErrors) f.fieldErrors = this.fieldErrors;
    if (this.retryAfter !== undefined) f.retryAfter = this.retryAfter;
    return f;
  }

  /** Normalises any thrown value: `ActionError` as-is, `HypDrivError` by code, everything else `INTERNAL`. */
  static from(error: unknown): ActionError {
    if (error instanceof ActionError) return error;
    if (isHypDrivError(error)) {
      const code: ActionErrorCode =
        error.code === 'E_VALIDATION'
          ? 'VALIDATION'
          : error.code === 'E_UNAUTHORIZED'
            ? 'UNAUTHORIZED'
            : error.code === 'E_FORBIDDEN'
              ? 'FORBIDDEN'
              : error.code === 'E_NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'E_RATE_LIMIT'
                  ? 'RATE_LIMITED'
                  : 'INTERNAL';
      return new ActionError(code, code === 'INTERNAL' ? undefined : error.message, {
        cause: error,
        details: error.details,
      });
    }
    return new ActionError('INTERNAL', undefined, { cause: error });
  }
}

function defaultMessage(code: ActionErrorCode): string {
  switch (code) {
    case 'VALIDATION':
      return 'Invalid input';
    case 'UNAUTHORIZED':
      return 'Authentication required';
    case 'FORBIDDEN':
      return 'Not allowed';
    case 'NOT_FOUND':
      return 'Not found';
    case 'RATE_LIMITED':
      return 'Too many requests';
    case 'CHALLENGE_FAILED':
      return 'Challenge verification failed';
    case 'CONFLICT':
      return 'Conflict';
    default:
      return 'Something went wrong';
  }
}

/**
 * `true` for Next.js control-flow errors (`redirect()`, `notFound()`, `forbidden()`, `unauthorized()`)
 * which must propagate to the framework instead of being turned into results.
 */
export function isNextNavigationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const digest = (error as { digest?: unknown }).digest;
  return (
    typeof digest === 'string' && /^(?:NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK)/.test(digest)
  );
}

/** Per-call context handed to `auth`, guards, rate-limit keys and the handler. */
export interface ActionContext<Auth = unknown, Input = unknown> {
  /** Action name (definition `name`, else `action`). */
  name: string;
  requestId?: string;
  ip?: string;
  headers?: Headers;
  auth: Auth;
  input: Input;
  /** Epoch milliseconds. */
  startedAt: number;
  idempotencyKey?: string;
  /** Turnstile verification outcome when configured. */
  turnstile?: TurnstileResult;
}

/** Emitted to `audit` after every call. */
export interface ActionAuditEvent {
  action: string;
  ok: boolean;
  code?: ActionErrorCode;
  durationMs: number;
  requestId?: string;
  ip?: string;
  auth?: unknown;
  /** The result came from the idempotency store. */
  replayed?: boolean;
  /** The handler ended with a Next.js navigation (`redirect`, `notFound`); counted as success. */
  navigation?: boolean;
}

/** Stored idempotency record. */
export interface IdempotencyRecord {
  status: 'pending' | 'done';
  /** sha256 of the validated input; a reused key with a different payload is a `CONFLICT`. */
  fingerprint?: string;
  result?: ActionResult<unknown>;
  createdAt: number;
}

/** Storage for idempotency keys. */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory idempotency store (per isolate; use KV or a Durable Object for fleet-wide guarantees). */
export function createMemoryIdempotencyStore(options: { now?: () => number } = {}): IdempotencyStore {
  const now = options.now ?? (() => Date.now());
  const map = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();
  return {
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= now()) {
        map.delete(key);
        return null;
      }
      return hit.record;
    },
    async set(key, record, ttlSeconds) {
      if (map.size > 10_000) for (const [k, v] of map) if (v.expiresAt <= now()) map.delete(k);
      map.set(key, { record, expiresAt: now() + ttlSeconds * 1000 });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

/** KV-backed idempotency store (`expirationTtl` ≥ 60 s; eventually consistent across regions). */
export function createKvIdempotencyStore(
  kv: KVNamespaceLike,
  options: { prefix?: string } = {},
): IdempotencyStore {
  const prefix = options.prefix ?? 'hypdriv:idem';
  return {
    async get(key) {
      const raw = await kv.get(`${prefix}:${key}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as IdempotencyRecord;
      } catch {
        return null;
      }
    },
    async set(key, record, ttlSeconds) {
      await kv.put(`${prefix}:${key}`, JSON.stringify(record), {
        expirationTtl: Math.max(60, Math.ceil(ttlSeconds)),
      });
    },
    async delete(key) {
      await kv.delete(`${prefix}:${key}`);
    },
  };
}

/** Converts `FormData` into a plain object; repeated keys become arrays, `File`s are kept as-is. */
export function formDataToObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith('$ACTION')) continue; // Next.js internal fields
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** Rate-limit settings for actions and routes. */
export interface InlineRateLimit<Ctx> {
  /** Counter key (e.g. the user id or IP). */
  key: (ctx: Ctx) => string;
  limit: number;
  /** Window in seconds or a duration string (`'1m'`). */
  window: number | string;
  algorithm?: ResolvedRateLimitPolicy['algorithm'];
  burst?: number;
}

/** Definition passed to `safeAction`. */
export interface SafeActionDefinition<Input, Output, Auth = unknown> {
  /** Used in audit events and idempotency keys (default `action`). */
  name?: string;
  input?: StandardSchemaV1<unknown, Input>;
  /** Returns the authenticated principal or `null` (→ `UNAUTHORIZED`). */
  auth?: (ctx: ActionContext<null, Input>) => Promise<Auth | null> | Auth | null;
  /** Each guard passes by returning `undefined`/`true`; `false` → `FORBIDDEN`; an `ActionError` is returned as-is. */
  guards?: Array<
    (ctx: ActionContext<Auth, Input>) => Promise<void | boolean | ActionError> | void | boolean | ActionError
  >;
  rateLimit?: InlineRateLimit<ActionContext<Auth, Input>>;
  /** Limiter for `rateLimit` (default: a per-isolate memory limiter). */
  limiter?: RateLimiter;
  /** Require a valid Turnstile token (`cf-turnstile-response` field/header by default). */
  turnstile?: { secret: string; field?: string; verify?: typeof verifyTurnstile };
  idempotency?: {
    store: IdempotencyStore;
    /** Default 86400 (24 h). */
    ttlSeconds?: number;
    /** Derives the key from the context (default: call option, then the `Idempotency-Key` header). */
    key?: (ctx: ActionContext<Auth, Input>) => string | undefined;
  };
  handler: (input: Input, ctx: ActionContext<Auth, Input>) => Promise<Output> | Output;
  onError?: (error: unknown, ctx: ActionContext<Auth | null, Input | undefined>) => void | Promise<void>;
  audit?: (event: ActionAuditEvent) => void | Promise<void>;
  /** Provides request context (`@hypdriv/next` wires `next/headers`). Default: the global action context. */
  getContext?: () => Promise<Partial<ActionContext>> | Partial<ActionContext>;
}

/** Per-call options of a safe action. */
export interface SafeActionCallOptions {
  idempotencyKey?: string;
  turnstileToken?: string;
  context?: Partial<ActionContext>;
}

export type SafeActionHandler<Input, Output> = ((
  rawInput: unknown,
  options?: SafeActionCallOptions | FormData,
) => Promise<ActionResult<Output>>) & {
  readonly actionName: string;
  /** Phantom marker carrying the validated input type (see `InferActionInput`). */
  readonly '~input'?: Input;
};

/** Validated input type of a safe action. */
export type InferActionInput<H> = H extends SafeActionHandler<infer I, unknown> ? I : never;
/** Output type of a safe action. */
export type InferActionOutput<H> = H extends SafeActionHandler<unknown, infer O> ? O : never;

/** Global slot `@hypdriv/next` fills so actions see request ids, IPs and headers without wiring. */
export const ACTION_CONTEXT_GLOBAL = '__hypdriv_action_context__';

type ContextProvider =
  | Partial<ActionContext>
  | (() => Partial<ActionContext> | Promise<Partial<ActionContext>>);

async function defaultGetContext(): Promise<Partial<ActionContext>> {
  const provider = (globalThis as Record<string, unknown>)[ACTION_CONTEXT_GLOBAL] as
    | ContextProvider
    | undefined;
  if (!provider) return {};
  try {
    return typeof provider === 'function' ? await provider() : provider;
  } catch {
    return {};
  }
}

let defaultLimiter: RateLimiter | undefined;
function getDefaultLimiter(): RateLimiter {
  defaultLimiter ??= createRateLimiter({ store: createMemoryCounterStore() });
  return defaultLimiter;
}

/** Builds a synthetic policy for inline rate limits (actions/routes). */
export function inlinePolicy(
  id: string,
  rl: {
    limit: number;
    window: number | string;
    algorithm?: ResolvedRateLimitPolicy['algorithm'];
    burst?: number;
  },
): ResolvedRateLimitPolicy {
  return {
    id,
    match: '/**',
    methods: [],
    limit: rl.limit,
    windowSeconds: parseDuration(rl.window, 60),
    burst: rl.burst ?? 0,
    algorithm: rl.algorithm ?? 'sliding-window',
    keys: [],
    store: 'auto',
    apiKeyHeader: 'authorization',
    sessionCookie: 'hyp_session',
    userHeader: 'x-user-id',
    response: { status: 429, body: { error: 'rate_limited', policy: id }, headers: {} },
    headers: true,
    skip: null,
  };
}

/** Applies an inline rate limit, throwing `RATE_LIMITED` when exceeded. */
export async function enforceInlineRateLimit(
  limiter: RateLimiter,
  policy: ResolvedRateLimitPolicy,
  key: string,
): Promise<RateLimitResult> {
  const result = await limiter.check(policy, `${policy.id}|${key}`);
  if (!result.allowed)
    throw new ActionError('RATE_LIMITED', undefined, {
      retryAfter: result.retryAfter,
      details: { limit: result.limit, resetAt: result.resetAt },
    });
  return result;
}

async function fingerprintOf(value: unknown): Promise<string | undefined> {
  try {
    const replacer = (v: unknown): unknown =>
      typeof File !== 'undefined' && v instanceof File ? { name: v.name, size: v.size, type: v.type } : v;
    const walk = (v: unknown): unknown => {
      const r = replacer(v);
      if (Array.isArray(r)) return r.map(walk);
      if (r && typeof r === 'object' && Object.getPrototypeOf(r) === Object.prototype)
        return Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
      return r;
    };
    return await sha256Hex(stableStringify(walk(value)));
  } catch {
    return undefined;
  }
}

function readField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[field];
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Wraps a Server Action with Standard Schema validation, Turnstile, auth, guards, rate limiting,
 * idempotency and audit hooks. The returned function never throws for expected failures: it resolves
 * to `{ ok: false, error }`. Next.js navigation errors (`redirect`, `notFound`) are rethrown.
 * Call it as `action(input)`, `action(formData)` or, from `useActionState`, `action(prevState, formData)`.
 */
export function safeAction<Input, Output, Auth = unknown>(
  definition: SafeActionDefinition<Input, Output, Auth>,
): SafeActionHandler<Input, Output> {
  const name = definition.name ?? 'action';
  const getContext = definition.getContext ?? defaultGetContext;
  const policy = definition.rateLimit ? inlinePolicy(`action:${name}`, definition.rateLimit) : null;

  const run = async (
    rawInput: unknown,
    callOptions?: SafeActionCallOptions | FormData,
  ): Promise<ActionResult<Output>> => {
    let options: SafeActionCallOptions = {};
    // useActionState passes (prevState, formData).
    if (callOptions instanceof FormData) rawInput = callOptions;
    else if (callOptions) options = callOptions;

    const startedAt = Date.now();
    const base = await getContext();
    const ctx = {
      ...base,
      ...options.context,
      name,
      auth: null,
      input: undefined,
      startedAt,
    } as ActionContext<Auth | null, Input | undefined>;
    let replayed = false;
    let navigation = false;
    let failure: ActionError | null = null;
    let idemKey: string | undefined;
    let idemStore: IdempotencyStore | undefined;
    let idemTtl = 86400;

    try {
      const raw = rawInput instanceof FormData ? formDataToObject(rawInput) : rawInput;

      if (definition.turnstile) {
        const field = definition.turnstile.field ?? TURNSTILE_TOKEN_FIELD;
        const token = options.turnstileToken ?? readField(raw, field) ?? ctx.headers?.get(field) ?? undefined;
        if (!token) throw new ActionError('CHALLENGE_FAILED', 'Missing challenge token');
        const verifyFn = definition.turnstile.verify ?? verifyTurnstile;
        const result = await verifyFn(definition.turnstile.secret, token, ctx.ip);
        ctx.turnstile = result;
        if (!result.success)
          throw new ActionError('CHALLENGE_FAILED', undefined, {
            details: { errorCodes: result.errorCodes },
          });
        if (raw && typeof raw === 'object' && field in (raw as object))
          delete (raw as Record<string, unknown>)[field];
      }

      let input: Input;
      if (definition.input) {
        const validated = await validateWithSchema(definition.input, raw);
        if (!validated.ok)
          throw new ActionError('VALIDATION', validated.message, { fieldErrors: validated.fieldErrors });
        input = validated.value;
      } else input = raw as Input;
      ctx.input = input;

      if (definition.auth) {
        const principal = await definition.auth(ctx as ActionContext<null, Input>);
        if (principal === null || principal === undefined) throw new ActionError('UNAUTHORIZED');
        ctx.auth = principal;
      }
      const authed = ctx as ActionContext<Auth, Input>;

      if (policy && definition.rateLimit) {
        await enforceInlineRateLimit(
          definition.limiter ?? getDefaultLimiter(),
          policy,
          definition.rateLimit.key(authed),
        );
      }

      for (const guard of definition.guards ?? []) {
        const verdict = await guard(authed);
        if (verdict instanceof ActionError) throw verdict;
        if (verdict === false) throw new ActionError('FORBIDDEN');
      }

      if (definition.idempotency) {
        idemStore = definition.idempotency.store;
        idemTtl = definition.idempotency.ttlSeconds ?? 86400;
        idemKey =
          options.idempotencyKey ??
          definition.idempotency.key?.(authed) ??
          ctx.headers?.get('idempotency-key') ??
          undefined;
        if (idemKey) {
          idemKey = `${name}:${idemKey}`;
          authed.idempotencyKey = idemKey;
          const fingerprint = await fingerprintOf(input);
          const existing = await idemStore.get(idemKey);
          if (existing) {
            if (existing.fingerprint && fingerprint && existing.fingerprint !== fingerprint)
              throw new ActionError('CONFLICT', 'Idempotency key reused with a different payload');
            if (existing.status === 'pending')
              throw new ActionError('CONFLICT', 'A request with this idempotency key is in progress');
            if (existing.result) {
              replayed = true;
              return existing.result as ActionResult<Output>;
            }
          }
          await idemStore.set(
            idemKey,
            { status: 'pending', fingerprint, createdAt: startedAt },
            Math.min(idemTtl, 300),
          );
        }
      }

      const data = await definition.handler(input, authed);
      const result: ActionResult<Output> = { ok: true, data };
      if (idemStore && idemKey)
        await idemStore.set(
          idemKey,
          { status: 'done', fingerprint: await fingerprintOf(input), result, createdAt: startedAt },
          idemTtl,
        );
      return result;
    } catch (error) {
      if (isNextNavigationError(error)) {
        navigation = true;
        if (idemStore && idemKey) await idemStore.delete(idemKey).catch(() => undefined);
        throw error;
      }
      failure = ActionError.from(error);
      if (failure.code === 'INTERNAL' || !(error instanceof ActionError)) {
        try {
          await definition.onError?.(error, ctx);
        } catch {
          // never let an error hook break the response
        }
      }
      if (idemStore && idemKey) {
        // Release the pending marker so the client can retry; completed failures are not replayed.
        await idemStore.delete(idemKey).catch(() => undefined);
      }
      return { ok: false, error: failure.toFailure() };
    } finally {
      if (definition.audit) {
        const event: ActionAuditEvent = {
          action: name,
          ok: failure === null,
          durationMs: Date.now() - startedAt,
          requestId: ctx.requestId,
          ip: ctx.ip,
          auth: ctx.auth ?? undefined,
          replayed,
        };
        if (navigation) event.navigation = true;
        if (failure) event.code = failure.code;
        try {
          await definition.audit(event);
        } catch {
          // audit sinks must not affect the action result
        }
      }
    }
  };
  return Object.assign(run, { actionName: name }) as SafeActionHandler<Input, Output>;
}
