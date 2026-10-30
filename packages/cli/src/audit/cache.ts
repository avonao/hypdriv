import type { AuditFinding, AuditLevel } from './csp';

export interface CacheAuditInput {
  path: string;
  /** Whether the manifest resolved an edge cache policy for the route. */
  hasPolicy: boolean;
  first: { status: number; headers: Headers };
  second: { status: number; headers: Headers };
}

export interface CacheAuditResult {
  path: string;
  status: AuditLevel;
  hasPolicy: boolean;
  first: string | null;
  second: string | null;
  age: string | null;
  vary: string | null;
  cacheControl: string | null;
  findings: AuditFinding[];
}

const SERVED_FROM_CACHE = new Set(['HIT', 'STALE', 'REVALIDATED', 'ERROR-STALE', 'NEGATIVE', 'PRERENDER']);

/**
 * Cache status of a response: HypDriv's `x-hypdriv-cache`, else Vercel's CDN header `x-vercel-cache`
 * (`HIT`, `MISS`, `STALE`, `PRERENDER`, `REVALIDATED`, `BYPASS`).
 */
export function cacheStatus(headers: Headers): string | null {
  const raw = headers.get('x-hypdriv-cache') ?? headers.get('x-vercel-cache');
  if (!raw) return null;
  return raw.split(';')[0]!.trim().toUpperCase();
}

/** Checks two consecutive responses for the expected edge-cache behaviour. */
export function auditCache(input: CacheAuditInput): CacheAuditResult {
  const findings: AuditFinding[] = [];
  const first = cacheStatus(input.first.headers);
  const second = cacheStatus(input.second.headers);
  const age = input.second.headers.get('age');
  const vary = input.second.headers.get('vary');
  const cacheControl = input.second.headers.get('cache-control');
  const contentType = input.second.headers.get('content-type') ?? '';
  const isHtml = /text\/html/i.test(contentType);

  if (!first && !second) {
    findings.push({
      level: 'fail',
      message:
        'no x-hypdriv-cache (or x-vercel-cache) header: HypDriv is not running in front of this server (or cache.edge.debugHeader is off)',
    });
  } else if (input.hasPolicy) {
    if (first && !['MISS', 'HIT', 'STALE', 'REVALIDATED', 'PRERENDER'].includes(first))
      findings.push({
        level: 'warn',
        message: `first request returned ${first} although the route has a policy`,
      });
    if (!second || !SERVED_FROM_CACHE.has(second))
      findings.push({
        level: 'fail',
        message: `second request returned ${second ?? 'no status'}; expected HIT or STALE`,
      });
    if (second && SERVED_FROM_CACHE.has(second) && !age)
      findings.push({ level: 'warn', message: 'cached response without an Age header' });
  } else if (second && SERVED_FROM_CACHE.has(second)) {
    findings.push({ level: 'warn', message: `route without a policy was served from the cache (${second})` });
  }
  if (isHtml && input.hasPolicy) {
    const varyList = (vary ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    if (!varyList.includes('rsc') && !varyList.includes('*'))
      findings.push({
        level: 'warn',
        message: 'Vary does not include rsc; cached HTML and RSC payloads can collide in shared caches',
      });
  }
  if (!cacheControl) findings.push({ level: 'warn', message: 'no Cache-Control header' });
  else if (input.hasPolicy && /no-store/i.test(cacheControl))
    findings.push({
      level: 'warn',
      message: `Cache-Control "${cacheControl}" on a route with an edge policy (the origin opted out; respectOrigin honours it)`,
    });
  else if (input.hasPolicy && /private/i.test(cacheControl) && second && SERVED_FROM_CACHE.has(second))
    findings.push({ level: 'fail', message: 'private response served from the shared edge cache' });
  if (input.first.status >= 500 || input.second.status >= 500)
    findings.push({ level: 'fail', message: `server error (${input.first.status}/${input.second.status})` });

  const status: AuditLevel = findings.some((f) => f.level === 'fail')
    ? 'fail'
    : findings.some((f) => f.level === 'warn')
      ? 'warn'
      : 'pass';
  return {
    path: input.path,
    status,
    hasPolicy: input.hasPolicy,
    first,
    second,
    age,
    vary,
    cacheControl,
    findings,
  };
}
