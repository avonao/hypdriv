import type { AuditLevel } from './csp';
import type { FetchedPage } from './http';

/**
 * `hypdriv audit https`: nothing of an https deployment may be served over plain HTTP. The audit requests
 * pages, an internal route and a content-hashed asset over `http://` — anonymously, so no gateway header or
 * audit token crosses the network in clear text — and expects a redirect to the same URL over https.
 *
 * Static assets are the usual gap: Cloudflare serves Workers Static Assets before the Worker (and so before
 * `redirects.forceHttps`), so the zone needs Always Use HTTPS or a Redirect Rule for the hostname.
 */

export type HttpsProbeKind = 'page' | 'internal' | 'asset';

export interface HttpsProbe {
  kind: HttpsProbeKind;
  path: string;
}

export interface HttpsAuditEntry {
  kind: HttpsProbeKind;
  path: string;
  status: number;
  location: string | null;
  level: AuditLevel;
  finding: string;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i;

/** Whether the base URL can be audited: https and not a local host (local previews run plain HTTP). */
export function httpsAuditable(base: string): boolean {
  try {
    const url = new URL(base);
    return url.protocol === 'https:' && !LOCAL_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The first same-origin script, module preload or stylesheet a page references (relative or on the audited
 * host), as a path.
 */
export function firstAssetPath(body: string, base: string): string | null {
  const host = new URL(base).host;
  const candidates: string[] = [];
  for (const m of body.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) candidates.push(m[1]!);
  for (const m of body.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\b(stylesheet|modulepreload|preload)\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (href) candidates.push(href);
  }
  for (const raw of candidates) {
    const src = raw.replace(/&amp;/g, '&');
    if (src.startsWith('data:') || src.startsWith('blob:')) continue;
    try {
      const url = new URL(src, `${base}/`);
      if (url.host === host && url.protocol === 'https:') return `${url.pathname}${url.search}`;
    } catch {
      // not a URL: ignore
    }
  }
  return null;
}

/** The probes for a base URL: up to three audited pages, the health route and one referenced asset. */
export function httpsProbes(
  pages: Array<{ path: string; page: FetchedPage }>,
  base: string,
  internalPrefix: string,
): HttpsProbe[] {
  const probes: HttpsProbe[] = pages.slice(0, 3).map((p) => ({ kind: 'page', path: p.path }));
  if (!probes.length) probes.push({ kind: 'page', path: '/' });
  probes.push({ kind: 'internal', path: `${internalPrefix.replace(/\/+$/, '')}/health` });
  for (const { page } of pages) {
    if (page.error || !page.body) continue;
    const asset = firstAssetPath(page.body, base);
    if (asset) {
      probes.push({ kind: 'asset', path: asset });
      break;
    }
  }
  return probes;
}

/** `http://host/path` for a path under an https base. */
export function plainHttpUrl(base: string, path: string): string {
  const url = new URL(path, `${base}/`);
  url.protocol = 'http:';
  return url.href;
}

const FIX: Record<HttpsProbeKind, string> = {
  page: 'set site.origin to your https origin (redirects.forceHttps auto) or redirects.forceHttps: true',
  internal:
    'the runner answers internal routes before the redirects stage; update Hypdriv (httpsUpgrade runs first)',
  asset:
    'static assets are served before your code: on Cloudflare turn on Always Use HTTPS for the zone (SSL/TLS → Edge Certificates) or add a Redirect Rule for the hostname',
};

/** Judges one plain-HTTP response (pure; used by tests). */
export function judgeHttpsProbe(probe: HttpsProbe, base: string, page: FetchedPage): HttpsAuditEntry {
  const entry = { kind: probe.kind, path: probe.path, status: page.status, location: page.redirected };
  if (page.error) return { ...entry, level: 'fail', finding: page.error };
  if (page.status >= 300 && page.status < 400) {
    const expected = new URL(probe.path, `${base}/`);
    let target: URL | null = null;
    try {
      target = page.redirected ? new URL(page.redirected, plainHttpUrl(base, probe.path)) : null;
    } catch {
      target = null;
    }
    if (!target) return { ...entry, level: 'fail', finding: `${page.status} without a usable Location` };
    if (target.protocol !== 'https:')
      return { ...entry, level: 'fail', finding: `redirects to ${target.href}, not https` };
    if (target.host !== expected.host || target.pathname !== expected.pathname)
      return {
        ...entry,
        level: 'warn',
        finding: `redirects to ${target.href} instead of the same URL over https`,
      };
    const permanent = page.status === 301 || page.status === 308;
    return {
      ...entry,
      level: permanent ? 'pass' : 'warn',
      finding: permanent
        ? `${page.status} → https`
        : `${page.status} is temporary; browsers keep asking over HTTP (use 301/308)`,
    };
  }
  if (page.status >= 200 && page.status < 300)
    return {
      ...entry,
      level: 'fail',
      finding: `served over plain HTTP (${page.status}); ${FIX[probe.kind]}`,
    };
  return {
    ...entry,
    level: 'warn',
    finding: `HTTP ${page.status} over plain HTTP: not served, but visitors following an http:// link get an error instead of the https page`,
  };
}
