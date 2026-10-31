/** Headers that may legitimately appear multiple times and must be appended rather than replaced. */
const APPENDABLE = new Set(['set-cookie', 'link', 'vary', 'server-timing', 'reporting-endpoints', 'warning']);

/** Copies `source` headers into `target`. Appendable headers are appended; others replaced. */
export function mergeHeaders(
  target: Headers,
  source: HeadersInit | Headers | Record<string, string | string[] | undefined>,
): Headers {
  const entries: Array<[string, string]> = [];
  if (source instanceof Headers) {
    source.forEach((v, k) => entries.push([k, v]));
    const sc = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
    if (sc?.length) {
      // Headers.forEach joins set-cookie; replace with the split values.
      const filtered = entries.filter(([k]) => k.toLowerCase() !== 'set-cookie');
      entries.length = 0;
      entries.push(...filtered, ...sc.map((v): [string, string] => ['set-cookie', v]));
    }
  } else if (Array.isArray(source)) {
    for (const [k, v] of source) entries.push([k, v]);
  } else {
    for (const [k, v] of Object.entries(source)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) entries.push([k, item]);
      else entries.push([k, v]);
    }
  }
  const replaced = new Set<string>();
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (APPENDABLE.has(key)) target.append(key, v);
    else {
      if (!replaced.has(key)) {
        target.delete(key);
        replaced.add(key);
      }
      target.append(key, v);
    }
  }
  return target;
}

/** Returns a new Response with the same body/status and extra headers merged in. */
export function withHeaders(
  response: Response,
  extra: HeadersInit | Headers | Record<string, string | string[] | undefined>,
): Response {
  const headers = new Headers(response.headers);
  mergeHeaders(headers, extra);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Returns the response without the named headers (unchanged when none is present). */
export function withoutHeaders(response: Response, names: string[]): Response {
  if (!names.some((n) => response.headers.has(n))) return response;
  const headers = new Headers(response.headers);
  for (const n of names) headers.delete(n);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Adds values to a comma-separated list header (`Vary`, `Cache-Tag`) without duplicates. */
export function appendListHeader(headers: Headers, name: string, values: string | string[]): void {
  const incoming = (Array.isArray(values) ? values : [values])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  const existing = (headers.get(name) ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const seen = new Set(existing.map((v) => v.toLowerCase()));
  const out = [...existing];
  for (const v of incoming) {
    if (seen.has(v.toLowerCase())) continue;
    if (v === '*') {
      headers.set(name, '*');
      return;
    }
    seen.add(v.toLowerCase());
    out.push(v);
  }
  if (out.length) headers.set(name, out.join(', '));
}

export interface LinkEntry {
  href: string;
  rel: string;
  as?: string;
  type?: string;
  crossorigin?: '' | 'anonymous' | 'use-credentials';
  fetchpriority?: 'high' | 'low' | 'auto';
  media?: string;
  nopush?: boolean;
  [param: string]: string | boolean | undefined;
}

/** Serialises Link entries into one header value, de-duplicating by href+rel. */
export function serializeLink(entries: LinkEntry[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const e of entries) {
    const key = `${e.rel}|${e.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const params = Object.entries(e)
      .filter(([k, v]) => k !== 'href' && v !== undefined && v !== false)
      .map(([k, v]) =>
        v === true || v === '' ? k : `${k}=${needsQuote(String(v)) ? JSON.stringify(String(v)) : v}`,
      );
    parts.push(`<${e.href}>; ${params.join('; ')}`);
  }
  return parts.join(', ');
}

function needsQuote(v: string): boolean {
  return /[\s,;"()<>@:\\/[\]?={}]/.test(v);
}

/** Parses a Link header value into entries. Tolerant of quoting and whitespace. */
export function parseLink(header: string | null | undefined): LinkEntry[] {
  if (!header) return [];
  const out: LinkEntry[] = [];
  const re = /<([^>]*)>\s*((?:;\s*[^,;=]+(?:=(?:"[^"]*"|[^,;]*))?\s*)*)/g;
  for (const m of header.matchAll(re)) {
    const entry: LinkEntry = { href: m[1] ?? '', rel: '' };
    const paramsRe = /;\s*([^,;=\s]+)(?:=(?:"([^"]*)"|([^,;\s]*)))?/g;
    for (const p of (m[2] ?? '').matchAll(paramsRe)) {
      const name = (p[1] ?? '').toLowerCase();
      const value = p[2] ?? p[3];
      entry[name] = value === undefined ? true : value;
    }
    if (!entry.rel) entry.rel = '';
    out.push(entry);
  }
  return out;
}

/** Appends Link entries to a response's existing Link header, de-duplicating. */
export function appendLinkHeader(
  headers: Headers,
  entries: LinkEntry[],
  maxEntries = Number.POSITIVE_INFINITY,
): void {
  if (!entries.length) return;
  const existing = parseLink(headers.get('link'));
  const merged = [...existing];
  const seen = new Set(existing.map((e) => `${e.rel}|${e.href}`));
  for (const e of entries) {
    if (merged.length >= maxEntries) break;
    const key = `${e.rel}|${e.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  headers.set('link', serializeLink(merged));
}

/** Parses `Cache-Control` into a map of lowercase directives. */
export function parseCacheControl(value: string | null | undefined): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  if (!value) return out;
  for (const part of value.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (!k) continue;
    out[k.toLowerCase()] = v === undefined ? true : v.replace(/^"|"$/g, '');
  }
  return out;
}

export function serializeCacheControl(
  directives: Record<string, string | number | boolean | undefined>,
): string {
  return Object.entries(directives)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}=${v}`))
    .join(', ');
}

/** Lowercases header names of a plain record (useful for deterministic cache keys). */
export function normalizeHeaderRecord(record: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) if (v !== undefined) out[k.toLowerCase()] = v;
  return out;
}

/** Client IP: Cloudflare's `cf-connecting-ip`, else the right-most trusted hop of `x-forwarded-for`. */
export function clientIp(headers: Headers, trustedProxies = 0): string {
  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const real = headers.get('x-real-ip');
  if (real && trustedProxies === 0) return real.trim();
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const idx = Math.max(0, hops.length - 1 - trustedProxies);
    return hops[idx] ?? hops[hops.length - 1] ?? '0.0.0.0';
  }
  return real?.trim() ?? '0.0.0.0';
}

/** Negotiates the best language from `Accept-Language` against supported locales. */
export function negotiateLanguage(
  acceptLanguage: string | null | undefined,
  supported: string[],
  fallback: string,
): string {
  if (!acceptLanguage) return fallback;
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: (tag ?? '').toLowerCase(), q: q ? Number(q.slice(2)) || 0 : 1, index };
    })
    .filter((r) => r.tag && r.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  const lower = supported.map((s) => s.toLowerCase());
  for (const r of ranked) {
    const exact = lower.indexOf(r.tag);
    if (exact !== -1) return supported[exact]!;
    const base = r.tag.split('-')[0]!;
    const prefix = lower.findIndex((s) => s === base || s.startsWith(`${base}-`));
    if (prefix !== -1) return supported[prefix]!;
    if (r.tag === '*') return fallback;
  }
  return fallback;
}

/** `true` for requests Next.js treats as RSC/flight payload fetches. */
export function isRscRequest(headers: Headers): boolean {
  return headers.get('rsc') === '1' || headers.has('next-router-state-tree');
}

export function isPrefetchRequest(headers: Headers): boolean {
  return (
    headers.get('next-router-prefetch') === '1' ||
    headers.get('purpose') === 'prefetch' ||
    headers.get('sec-purpose')?.includes('prefetch') === true
  );
}

export function isHtmlResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

export function acceptsHtml(headers: Headers): boolean {
  const accept = headers.get('accept') ?? '';
  return accept.includes('text/html') || accept.includes('*/*') || accept === '';
}

/**
 * Inbound `x-hypdriv-*` headers HypDriv accepts from clients. Everything else under that prefix is set by
 * the stages and forwarded to the application, so a client-supplied copy must never reach it. The
 * internal-request headers are claims that `jobHandler()` verifies against the HMAC signature, and the
 * audit token is verified by `verifiedAudit()` before the bot shield or rate limiter trust it.
 */
export const TRUSTED_INBOUND_HYPDRIV_HEADERS: ReadonlySet<string> = new Set([
  'x-hypdriv-request-id',
  'x-hypdriv-timestamp',
  'x-hypdriv-signature',
  'x-hypdriv-internal',
  'x-hypdriv-job',
  'x-hypdriv-warm',
  'x-hypdriv-challenge',
  'x-hypdriv-audit',
]);

/**
 * Removes request headers a client could use to impersonate HypDriv's stages: every `x-hypdriv-*` header
 * outside {@link TRUSTED_INBOUND_HYPDRIV_HEADERS}, the CSP nonce header (`x-nonce` or the configured name)
 * and Next.js' internal `x-middleware-*` headers (in front of Next.js only; pass `middlewareHeaders: false`
 * inside `proxy.ts`, where Next.js already sanitised them). Returns the same `Request` when nothing was removed.
 */
export function sanitizeInboundRequest(
  request: Request,
  options: { nonceHeader?: string; middlewareHeaders?: boolean } = {},
): Request {
  const nonceHeader = (options.nonceHeader ?? 'x-nonce').toLowerCase();
  const stripMiddleware = options.middlewareHeaders !== false;
  const remove: string[] = [];
  for (const name of request.headers.keys()) {
    const lower = name.toLowerCase();
    if (
      lower === nonceHeader ||
      (stripMiddleware && lower.startsWith('x-middleware-')) ||
      (lower.startsWith('x-hypdriv-') && !TRUSTED_INBOUND_HYPDRIV_HEADERS.has(lower))
    )
      remove.push(name);
  }
  if (!remove.length) return request;
  const headers = new Headers(request.headers);
  for (const name of remove) headers.delete(name);
  return new Request(request, { headers });
}
