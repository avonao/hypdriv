import type { AuditFinding, AuditLevel } from './csp';

export interface CacheAuditInput {
  path: string;
  /** Whether the manifest resolved an edge cache policy for the route. */
  hasPolicy: boolean;
  /** The route's prerendered document is served (and cached) by the platform's static layer. */
  servedStatically?: boolean;
  /**
   * Whether cached HTML must vary on `rsc` (Next.js: HTML and RSC payloads share URLs). Default true; false for
   * hosts without RSC payloads (Vite frameworks).
   */
  rscVary?: boolean;
  first: { status: number; headers: Headers };
  /** The repeat visit (sent with the cookies the first response set, as a browser would). */
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

function token(value: string | null): string | null {
  return value ? value.split(';')[0]!.trim().toUpperCase() : null;
}

/**
 * Cache status of a response: HypDriv's `x-hypdriv-cache`, else Vercel's CDN header `x-vercel-cache`
 * (`HIT`, `MISS`, `STALE`, `PRERENDER`, `REVALIDATED`, `BYPASS`). On Vercel HypDriv only plans the CDN's
 * caching (`x-hypdriv-cache: CDN`), so Vercel's own status wins there.
 */
export function cacheStatus(headers: Headers): string | null {
  const hyp = token(headers.get('x-hypdriv-cache'));
  const vercel = token(headers.get('x-vercel-cache'));
  if (hyp === 'CDN') return vercel ?? 'CDN';
  return hyp ?? vercel;
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
  // `x-hypdriv-cache-reason: route-header:<why>`: a configuration limit, not a broken cache.
  const reason =
    input.second.headers.get('x-hypdriv-cache-reason') ?? input.first.headers.get('x-hypdriv-cache-reason');
  const platformLimit =
    second === 'BYPASS' && reason?.startsWith('route-header:') ? reason.slice('route-header:'.length) : null;

  if (!first && !second && input.servedStatically) {
    // Prerendered files the platform serves before HypDriv runs (Workers Static Assets without
    // run_worker_first, a CDN): they carry HypDriv's static header rules but no request stages.
    findings.push({
      level: 'info',
      message:
        "prerendered document served by the platform's static layer before HypDriv (static header rules only; on Cloudflare set assets.run_worker_first to run the request stages)",
    });
  } else if (!first && !second) {
    findings.push({
      level: 'fail',
      message:
        'no x-hypdriv-cache (or x-vercel-cache) header: HypDriv is not running in front of this server (or cache.edge.debugHeader is off)',
    });
  } else if (second === 'CDN') {
    // Vercel CDN headers planned by HypDriv, served without Vercel's CDN in front (next start, vercel dev).
    const cdn =
      input.second.headers.get('vercel-cdn-cache-control') ?? input.second.headers.get('cdn-cache-control');
    if (!cdn)
      findings.push({
        level: 'fail',
        message: 'x-hypdriv-cache is CDN but no Vercel-CDN-Cache-Control header was sent',
      });
    else
      findings.push({
        level: 'info',
        message: `Vercel CDN headers present (${cdn}); hits show as x-vercel-cache on a deployment`,
      });
  } else if (input.hasPolicy && platformLimit) {
    // The policy cannot apply to this response on the platform (Vercel pages need a static route-header form).
    findings.push({
      level: 'warn',
      message: `policy not applicable on this platform (${platformLimit}): the page is not CDN-cached; Route Handlers can apply it with withVercelCdn()`,
    });
  } else if (input.hasPolicy) {
    const firstSetCookie = input.first.headers.has('set-cookie');
    if (first && !['MISS', 'HIT', 'STALE', 'REVALIDATED', 'PRERENDER', 'CDN'].includes(first))
      findings.push(
        first === 'BYPASS' && firstSetCookie
          ? {
              level: 'info',
              message:
                'the first visit sets a cookie (flags bucketing, session) and is not cached; repeat visits are',
            }
          : { level: 'warn', message: `first request returned ${first} although the route has a policy` },
      );
    if (!second || !SERVED_FROM_CACHE.has(second))
      findings.push({
        level: 'fail',
        message: `second request returned ${second ?? 'no status'}; expected HIT or STALE`,
      });
    if (second && SERVED_FROM_CACHE.has(second) && !age)
      findings.push({ level: 'warn', message: 'cached response without an Age header' });
  } else if (second && SERVED_FROM_CACHE.has(second)) {
    findings.push(
      input.servedStatically
        ? {
            level: 'info',
            message: `prerendered document served from the platform's static layer cache (${second})`,
          }
        : { level: 'warn', message: `route without a policy was served from the cache (${second})` },
    );
  } else if (input.servedStatically) {
    findings.push({
      level: 'info',
      message: "prerendered document served and cached by the platform's static layer (no edge-cache policy)",
    });
  }
  if (isHtml && input.hasPolicy && input.rscVary !== false) {
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
