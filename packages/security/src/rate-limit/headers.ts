import type { RateLimitResult } from './types';

function quote(id: string): string {
  return `"${id.replace(/[\\"]/g, '').replace(/[^\x20-\x7e]/g, '')}"`;
}

/**
 * Rate-limit response headers: IETF `RateLimit` / `RateLimit-Policy` (draft-ietf-httpapi-ratelimit-headers,
 * structured-field style: `"api";r=42;t=17`), the legacy `X-RateLimit-*` trio (`X-RateLimit-Reset` is an
 * epoch in seconds) and `Retry-After` when the request was limited.
 */
export function rateLimitHeaders(result: RateLimitResult, policyId: string, now: number = Date.now()): Record<string, string> {
  const secondsToReset = Math.max(0, Math.ceil((result.resetAt - now) / 1000));
  const headers: Record<string, string> = {
    RateLimit: `${quote(policyId)};r=${Math.max(0, Math.floor(result.remaining))};t=${secondsToReset}`,
    'RateLimit-Policy': `${quote(policyId)};q=${result.limit};w=${Math.max(1, Math.round(result.window))}`,
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(Math.max(0, Math.floor(result.remaining))),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
  if (!result.allowed) headers['Retry-After'] = String(Math.max(1, result.retryAfter || secondsToReset));
  return headers;
}
