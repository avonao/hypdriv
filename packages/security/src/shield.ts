import {
  defineStage,
  firstMatch,
  matchesAny,
  type ResolvedConfig,
  type ResolvedShield,
  safeDecodePath,
  type Stage,
  text,
} from '@hypdriv/core';

/** Why the shield rejected a request. */
export type ShieldRejection =
  | { status: 400; reason: 'missing-host' | 'traversal' }
  | { status: 404; reason: 'blocked-path' }
  | { status: 405; reason: 'method'; allow: string }
  | { status: 413; reason: 'body-too-large'; limit: number }
  | { status: 414; reason: 'url-too-long' }
  | { status: 421; reason: 'host' };

function hostAllowed(hostHeader: string, allowed: string[]): boolean {
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, '');
  if (!host) return false;
  for (const entry of allowed) {
    const pattern = entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (!pattern) continue;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
      if (host === pattern.slice(2)) return true;
    } else if (host === pattern) return true;
  }
  return false;
}

/** Pure evaluation of the shield rules; returns the first rejection or null. */
export function evaluateShield(
  shield: ResolvedShield,
  input: { request: Request; url: URL; siteOrigin: string | null },
): ShieldRejection | null {
  const { request, url } = input;
  const host = request.headers.get('host');
  if (!host) return { status: 400, reason: 'missing-host' };
  const method = request.method.toUpperCase();
  if (!shield.methods.includes(method)) return { status: 405, reason: 'method', allow: shield.methods.join(', ') };
  if (request.url.length > shield.maxUrlLength) return { status: 414, reason: 'url-too-long' };
  if (shield.blockTraversal && safeDecodePath(url.pathname) === null) return { status: 400, reason: 'traversal' };
  if (shield.blockedPaths.length && matchesAny(shield.blockedPaths, url)) return { status: 404, reason: 'blocked-path' };
  if (shield.enforceHost) {
    const allowed = shield.enforceHost.length ? shield.enforceHost : input.siteOrigin ? [input.siteOrigin] : [];
    if (allowed.length && !hostAllowed(host, allowed)) return { status: 421, reason: 'host' };
  }
  const length = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > 0) {
    const rule = firstMatch(shield.maxBody, url);
    if (rule && length > rule.limit) return { status: 413, reason: 'body-too-large', limit: rule.limit };
  }
  return null;
}

/** Converts a rejection into a plain-text response. */
export function shieldResponse(rejection: ShieldRejection): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (rejection.reason === 'method') headers.allow = rejection.allow;
  const message =
    rejection.status === 404
      ? 'Not Found'
      : rejection.status === 405
        ? 'Method Not Allowed'
        : rejection.status === 413
          ? 'Payload Too Large'
          : rejection.status === 414
            ? 'URI Too Long'
            : rejection.status === 421
              ? 'Misdirected Request'
              : 'Bad Request';
  return text(message, { status: rejection.status, headers });
}

/**
 * The `shield` stage (WAF-lite): method allow-list, URL length, encoded traversal / null bytes, hidden
 * and backup paths, optional host enforcement and declared body size limits. Runs on internal paths too.
 * Bodies without `Content-Length` (chunked uploads) cannot be sized here; enforce limits in handlers.
 */
export function shieldStage(config: ResolvedConfig): Stage {
  const shield = config.security.shield;
  return defineStage({
    name: 'shield',
    runOnInternal: true,
    pre(ctx) {
      if (!shield) return;
      const rejection = evaluateShield(shield, { request: ctx.request, url: ctx.url, siteOrigin: config.site.origin });
      if (!rejection) return;
      ctx.timings.mark('shield', rejection.reason);
      ctx.log.info('shield rejected request', { reason: rejection.reason, status: rejection.status, path: ctx.url.pathname });
      return shieldResponse(rejection);
    },
  });
}
