import {
  defineStage,
  type HypContext,
  isInternalPath,
  type KVNamespaceLike,
  matchPattern,
  memoizeAsync,
  type ResolvedConfig,
  type ResolvedRedirects,
  redirect,
  type Stage,
} from '@hypdriv/core';

export interface RedirectRuleResolved {
  from: string;
  to: string;
  status: 301 | 302 | 307 | 308;
  preserveQuery: boolean;
  host: string | null;
}

/** Substitutes `:name` / `:name*` params and `$1`-style groups into a destination. */
export function expandDestination(to: string, params: Record<string, string>): string {
  return to.replace(/:([A-Za-z_][A-Za-z0-9_]*)\*?/g, (m, name: string) =>
    name in params ? params[name]! : m,
  );
}

/** Finds the first matching redirect rule for a URL. */
export function matchRedirect(
  rules: readonly RedirectRuleResolved[],
  url: URL,
): { rule: RedirectRuleResolved; location: URL } | null {
  for (const rule of rules) {
    if (rule.host && rule.host.toLowerCase() !== url.hostname.toLowerCase()) continue;
    const m = matchPattern(rule.from, url);
    if (!m.matched) continue;
    const target = expandDestination(rule.to, m.params);
    const location = new URL(target, url);
    if (rule.preserveQuery && url.search) {
      for (const [k, v] of url.searchParams)
        if (!location.searchParams.has(k)) location.searchParams.append(k, v);
    }
    if (location.href === url.href) continue; // avoid loops
    return { rule, location };
  }
  return null;
}

function normalizeRules(input: unknown): RedirectRuleResolved[] {
  if (!Array.isArray(input)) return [];
  const out: RedirectRuleResolved[] = [];
  for (const r of input) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.from !== 'string' || typeof o.to !== 'string' || !o.from.startsWith('/')) continue;
    const status = [301, 302, 307, 308].includes(Number(o.status))
      ? (Number(o.status) as 301 | 302 | 307 | 308)
      : 308;
    out.push({
      from: o.from,
      to: o.to,
      status,
      preserveQuery: o.preserveQuery !== false,
      host: typeof o.host === 'string' ? o.host : null,
    });
  }
  return out;
}

export interface RedirectsStageOptions {
  kv?: KVNamespaceLike;
  now?: () => number;
}

/** Whether `redirects.forceHttps` is on (`auto`: when `site.origin` is https). */
export function forcesHttps(config: ResolvedConfig): boolean {
  const r = config.redirects;
  return r.forceHttps === 'auto' ? config.site.origin?.startsWith('https://') === true : r.forceHttps;
}

/**
 * The https upgrade for a plain-HTTP request (`308`, any method, query kept), or `null`. Runners call it
 * before anything else answers — internal routes (`/_hypdriv/health`, vitals, CSP reports, live channels)
 * and static assets included — so nothing is served over plain HTTP when `forceHttps` is on. Local hosts
 * and development are exempt.
 */
export function httpsUpgrade(
  config: ResolvedConfig,
  request: Request,
  options: { development?: boolean } = {},
): Response | null {
  if (options.development || !forcesHttps(config)) return null;
  const url = new URL(request.url);
  const proto = (
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '')
  ).toLowerCase();
  if (proto !== 'http') return null;
  const host = url.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost'))
    return null;
  const target = new URL(url.href);
  target.protocol = 'https:';
  return redirect(target, 308, { 'cache-control': 'public, max-age=300' });
}

/** Edge redirects: config rules, optional KV-managed rules, canonical host and https enforcement. */
export function redirectsStage(config: ResolvedConfig, options: RedirectsStageOptions = {}): Stage | null {
  const r: ResolvedRedirects = config.redirects;
  const hasWork =
    r.rules.length > 0 || r.kvBinding !== null || r.canonicalHost !== null || r.forceHttps !== false;
  if (!hasWork) return null;
  const kvRules = options.kv
    ? memoizeAsync(
        async () => normalizeRules(await options.kv!.get(r.kvKey, 'json').catch(() => null)),
        r.cacheTtlSeconds * 1000,
        options.now,
      )
    : null;
  const forceHttps = forcesHttps(config);

  return defineStage({
    name: 'redirects',
    async pre(ctx: HypContext) {
      const url = ctx.url;
      if (isInternalPath(url.pathname, config.cloudflare.internalPathPrefix)) return;
      if (ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD') return;
      const proto = ctx.request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
      const isLocal =
        url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.localhost');
      if (forceHttps && proto === 'http' && !isLocal && !ctx.development) {
        const target = new URL(url.href);
        target.protocol = 'https:';
        return redirect(target, 308, { 'cache-control': 'public, max-age=300' });
      }
      if (r.canonicalHost && url.hostname.toLowerCase() !== r.canonicalHost.toLowerCase() && !isLocal) {
        const target = new URL(url.href);
        target.hostname = r.canonicalHost;
        return redirect(target, 308, { 'cache-control': 'public, max-age=300' });
      }
      const rules = kvRules ? [...r.rules, ...(await kvRules.get('rules'))] : r.rules;
      const hit = matchRedirect(rules, url);
      if (!hit) return;
      ctx.timings.mark('redirect', hit.rule.from);
      return redirect(hit.location, hit.rule.status, {
        'cache-control':
          hit.rule.status === 301 || hit.rule.status === 308 ? 'public, max-age=3600' : 'private, no-store',
      });
    },
  });
}
