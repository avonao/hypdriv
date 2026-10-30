/** HTTP helpers shared by audit, warm and bench: realistic browser headers, timeouts, no redirects. */

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 HypDriv-CLI';

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchOptions {
  fetch: typeof fetch;
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  /** Follow redirects (default false: redirects are reported). */
  follow?: boolean;
  body?: string;
}

export interface FetchedPage {
  url: string;
  status: number;
  ok: boolean;
  headers: Headers;
  /** Response body text (empty for HEAD or when `readBody` was false). */
  body: string;
  /** Milliseconds until the headers arrived. */
  ttfbMs: number;
  /** Milliseconds until the body was fully read. */
  totalMs: number;
  redirected: string | null;
  error: string | null;
}

/** Browser-like request headers for HTML navigations. */
export function navigationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': DESKTOP_UA,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    ...extra,
  };
}

/** Joins a base URL and a path, normalising slashes. */
export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** Validates a `--url` value. */
export function normalizeBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const u = new URL(candidate);
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  } catch {
    return null;
  }
}

/** Fetches a page with timing; never throws (errors are reported in the result). */
export async function fetchPage(url: string, options: FetchOptions, now: () => number = () => performance.now()): Promise<FetchedPage> {
  const started = now();
  const base: FetchedPage = { url, status: 0, ok: false, headers: new Headers(), body: '', ttfbMs: 0, totalMs: 0, redirected: null, error: null };
  try {
    const res = await options.fetch(url, {
      method: options.method ?? 'GET',
      headers: navigationHeaders(options.headers),
      redirect: options.follow ? 'follow' : 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    const ttfbMs = now() - started;
    let body = '';
    if (options.method !== 'HEAD') {
      try {
        body = await res.text();
      } catch (err) {
        return { ...base, status: res.status, ok: res.ok, headers: res.headers, ttfbMs, totalMs: now() - started, error: `body: ${(err as Error).message}` };
      }
    }
    const location = res.headers.get('location');
    return {
      url,
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      body,
      ttfbMs,
      totalMs: now() - started,
      redirected: res.status >= 300 && res.status < 400 && location ? location : null,
      error: null,
    };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const reason = e.name === 'TimeoutError' ? `timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` : e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
    return { ...base, ttfbMs: now() - started, totalMs: now() - started, error: reason };
  }
}

/** Measures time to first byte: headers plus the first body chunk. */
export async function fetchTtfb(url: string, options: FetchOptions, now: () => number = () => performance.now()): Promise<{ status: number; headers: Headers; ttfbMs: number; totalMs: number; bytes: number; error: string | null }> {
  const started = now();
  try {
    const res = await options.fetch(url, {
      method: 'GET',
      headers: navigationHeaders(options.headers),
      redirect: options.follow ? 'follow' : 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    let ttfbMs = now() - started;
    let bytes = 0;
    if (res.body) {
      const reader = res.body.getReader();
      let first = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (first) {
          ttfbMs = now() - started;
          first = false;
        }
        if (done) break;
        bytes += value?.byteLength ?? 0;
      }
    }
    return { status: res.status, headers: res.headers, ttfbMs, totalMs: now() - started, bytes, error: null };
  } catch (err) {
    const e = err as Error;
    return { status: 0, headers: new Headers(), ttfbMs: now() - started, totalMs: now() - started, bytes: 0, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

/** Runs tasks with bounded concurrency, preserving order. */
export async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
  return out;
}

/** p-th percentile (nearest rank) of a numeric list. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}
