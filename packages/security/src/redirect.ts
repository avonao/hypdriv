/** Options of `safeRedirect`. */
export interface SafeRedirectOptions {
  /** The application's origin (`https://www.example.com`); same-origin absolute URLs are allowed. */
  origin: string;
  /** Extra hosts allowed as absolute targets; `*.example.com` matches subdomains. */
  allowHosts?: string[];
  /** Returned when the target is unsafe (default `/`). */
  fallback?: string;
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function hostMatches(hostname: string, pattern: string): boolean {
  const p = pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '');
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    return hostname === p.slice(2) || (hostname.endsWith(suffix) && hostname.length > suffix.length);
  }
  return hostname === p;
}

/**
 * Open-redirect guard for `redirect()` targets. Allows relative paths that start with a single `/`
 * (rejecting `//host`, `/\host`, backslashes and control characters) and absolute `http(s)` URLs on the
 * same origin or an allow-listed host. Everything else (`javascript:`, `data:`, foreign hosts, garbage)
 * yields `fallback`.
 */
export function safeRedirect(target: string | URL, options: SafeRedirectOptions): string {
  const fallback = options.fallback ?? '/';
  const raw = (target instanceof URL ? target.href : String(target ?? '')).trim();
  if (!raw || hasControlChars(raw) || raw.includes('\\')) return fallback;

  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return fallback;
    // A path must stay a path: `/%2f%2fevil.com` is harmless, but `/@evil.com` style tricks need a scheme to work.
    return raw;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fallback;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
  if (url.username || url.password) return fallback;
  let origin: URL;
  try {
    origin = new URL(options.origin);
  } catch {
    return fallback;
  }
  if (url.origin === origin.origin) return url.href;
  const hostname = url.hostname.toLowerCase();
  for (const allowed of options.allowHosts ?? []) if (hostMatches(hostname, allowed)) return url.href;
  return fallback;
}

/** `true` when `safeRedirect` would return the target unchanged. */
export function isSafeRedirect(target: string | URL, options: SafeRedirectOptions): boolean {
  const sentinel = '/__hypdriv_unsafe__';
  return safeRedirect(target, { ...options, fallback: sentinel }) !== sentinel;
}
