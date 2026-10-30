import {
  defineStage,
  getCookie,
  type HypContext,
  json,
  matchesAny,
  mergeHeaders,
  type ResolvedConfig,
  type ResolvedRateLimitPolicy,
  type Stage,
  shortHash,
  stateKey,
  text,
} from '@hypdriv/core';
import { RATE_LIMIT_KEY, type RateLimitStateEntry } from '../keys';
import { rateLimitHeaders } from './headers';
import type { RateLimiter, RateLimitResult } from './types';

function clean(value: string | null | undefined, max = 128): string {
  if (!value) return '-';
  let v = '';
  for (let i = 0; i < value.length && v.length < max; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0x7c /* | */) continue;
    v += value[i];
  }
  return v || '-';
}

/**
 * Builds the counter key for a policy and request: the policy id joined with each key dimension
 * (`ip`, `session` (hashed cookie), `user` (header), `api-key` (hashed header), `path`, `global`).
 */
export function resolveRateLimitKey(policy: ResolvedRateLimitPolicy, ctx: HypContext): string {
  const headers = ctx.request.headers;
  const parts = policy.keys.map((dim) => {
    switch (dim) {
      case 'ip':
        return `ip=${clean(ctx.ip)}`;
      case 'session': {
        const cookie = getCookie(headers, policy.sessionCookie);
        return `session=${cookie ? shortHash(cookie) : '-'}`;
      }
      case 'user':
        return `user=${clean(headers.get(policy.userHeader))}`;
      case 'api-key': {
        const raw = headers.get(policy.apiKeyHeader);
        const token = raw ? raw.replace(/^\s*(?:Bearer|Basic|Token|ApiKey)\s+/i, '').trim() : '';
        return `api-key=${token ? shortHash(token) : '-'}`;
      }
      case 'path':
        return `path=${ctx.url.pathname}`;
      default:
        return 'global';
    }
  });
  return `${policy.id}|${parts.join('|')}`;
}

/** `true` when a policy applies to the request (pattern, methods and `skip` predicate). */
export function policyApplies(policy: ResolvedRateLimitPolicy, ctx: HypContext): boolean {
  if (!matchesAny(policy.match, ctx.url)) return false;
  if (
    policy.methods.length &&
    !policy.methods.map((m) => m.toUpperCase()).includes(ctx.request.method.toUpperCase())
  )
    return false;
  if (policy.skip?.({ ip: ctx.ip, url: ctx.url, headers: ctx.request.headers })) return false;
  return true;
}

/** Builds the configured "limited" response (JSON by default) with rate-limit headers. */
export function rateLimitedResponse(
  policy: ResolvedRateLimitPolicy,
  result: RateLimitResult,
  now: number,
): Response {
  const headers = new Headers(policy.response.headers);
  if (policy.headers) mergeHeaders(headers, rateLimitHeaders(result, policy.id, now));
  if (!headers.has('retry-after')) headers.set('retry-after', String(Math.max(1, result.retryAfter)));
  const { status, body } = policy.response;
  return typeof body === 'string' ? text(body, { status, headers }) : json(body, { status, headers });
}

interface Pending {
  policy: ResolvedRateLimitPolicy;
  result: RateLimitResult;
  now: number;
}

/** Internal: the policy whose headers `post` applies. */
const PENDING_KEY = stateKey<Pending>('security.rate-limit-pending');

function toState(policy: ResolvedRateLimitPolicy, r: RateLimitResult): RateLimitStateEntry {
  return { policy: policy.id, remaining: r.remaining, limit: r.limit, reset: r.resetAt };
}

/**
 * The `rate-limit` stage: evaluates every matching policy in order and short-circuits on the first
 * denial. Allowed requests get the headers of the most constrained policy in `post`.
 */
export function rateLimitStage(config: ResolvedConfig, limiter: RateLimiter): Stage {
  const policies = config.security.rateLimit;

  return defineStage({
    name: 'rate-limit',
    async pre(ctx) {
      if (!policies.length) return;
      const now = Date.now();
      const entries: RateLimitStateEntry[] = [];
      let tightest: Pending | null = null;
      for (const policy of policies) {
        if (!policyApplies(policy, ctx)) continue;
        const key = resolveRateLimitKey(policy, ctx);
        const result = await limiter.check(policy, key, now);
        entries.push(toState(policy, result));
        if (!result.allowed) {
          ctx.state.set(RATE_LIMIT_KEY, entries);
          ctx.timings.mark('limit', policy.id);
          ctx.log.warn('rate limit exceeded', { policy: policy.id, key, retryAfter: result.retryAfter });
          return rateLimitedResponse(policy, result, now);
        }
        const ratio = result.limit > 0 ? result.remaining / result.limit : 1;
        if (
          policy.headers &&
          (!tightest || ratio < tightest.result.remaining / Math.max(1, tightest.result.limit))
        )
          tightest = { policy, result, now };
      }
      if (entries.length) ctx.state.set(RATE_LIMIT_KEY, entries);
      if (tightest) ctx.state.set(PENDING_KEY, tightest);
    },
    post(ctx, response) {
      const pending = ctx.state.get(PENDING_KEY);
      if (!pending) return response;
      ctx.state.delete(PENDING_KEY);
      const headers = new Headers(response.headers);
      const built = rateLimitHeaders(pending.result, pending.policy.id, pending.now);
      for (const [name, value] of Object.entries(built)) if (!headers.has(name)) headers.set(name, value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });
}
