import { base64UrlEncode, HEADER, hmacSign, sha256Hex, timingSafeEqual } from '@hypdriv/core';
import { signAuditToken, verifyAuditToken } from './audit-token';

async function mac(secret: string, data: string): Promise<string> {
  return base64UrlEncode(await hmacSign(secret, data));
}

/** Canonical form of a URL for signing: pathname + sorted query (without the signature parameter). */
export function canonicalUrl(url: URL, param: string): string {
  const entries = [...url.searchParams.entries()].filter(([k]) => k !== param);
  entries.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

/** Signed URL options. */
export interface SignUrlOptions {
  /** Lifetime in seconds; adds an `exp` query parameter covered by the signature. */
  expiresIn?: number;
  /** Signature parameter name (default `sig`). */
  param?: string;
  /** Clock override (epoch ms). */
  now?: number;
}

/**
 * Appends an HMAC-SHA256 signature over the canonical URL (pathname + sorted query, host-agnostic so
 * preview and production hosts share links). With `expiresIn`, an `exp` parameter (epoch seconds) is
 * added and covered by the signature.
 */
export async function signUrl(
  url: URL | string,
  secret: string,
  options: SignUrlOptions = {},
): Promise<string> {
  const param = options.param ?? 'sig';
  const u = new URL(typeof url === 'string' ? url : url.href);
  u.searchParams.delete(param);
  if (options.expiresIn !== undefined) {
    const exp = Math.floor((options.now ?? Date.now()) / 1000) + options.expiresIn;
    u.searchParams.set('exp', String(exp));
  }
  u.searchParams.set(param, await mac(secret, `url:${canonicalUrl(u, param)}`));
  return u.href;
}

/** Verifies a URL signed by `signUrl`, including its expiry. */
export async function verifyUrl(
  url: URL | string,
  secret: string,
  options: { param?: string; now?: number } = {},
): Promise<boolean> {
  const param = options.param ?? 'sig';
  const u = new URL(typeof url === 'string' ? url : url.href);
  const sig = u.searchParams.get(param);
  if (!sig) return false;
  const exp = u.searchParams.get('exp');
  if (exp !== null) {
    const expiry = Number(exp);
    if (!Number.isFinite(expiry) || expiry * 1000 <= (options.now ?? Date.now())) return false;
  }
  const expected = await mac(secret, `url:${canonicalUrl(u, param)}`);
  return timingSafeEqual(expected, sig);
}

/** Signs a value: `<value>.<sig>`; the value must not contain a trailing `.`-separated signature already. */
export async function signValue(value: string, secret: string): Promise<string> {
  return `${value}.${await mac(secret, `value:${value}`)}`;
}

/** Returns the original value when the signature verifies, otherwise `null`. */
export async function verifyValue(signed: string, secret: string): Promise<string | null> {
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  if (!sig) return null;
  const expected = await mac(secret, `value:${value}`);
  return timingSafeEqual(expected, sig) ? value : null;
}

async function bodyHash(request: Request): Promise<string> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return sha256Hex('');
  const buf = new Uint8Array(await request.clone().arrayBuffer());
  return sha256Hex(buf);
}

function internalPayload(timestamp: string, method: string, url: URL, hash: string): string {
  return `internal:${timestamp}\n${method.toUpperCase()}\n${url.pathname}\n${url.search}\n${hash}`;
}

/**
 * Signs an internal request (cron/queue → route handler) with `x-hypdriv-timestamp` and
 * `x-hypdriv-signature = HMAC(timestamp + method + pathname + search + sha256(body))`.
 * Returns a new `Request`; the body is cloned, not consumed.
 */
export async function signInternalRequest(
  request: Request,
  secret: string,
  now: number = Date.now(),
): Promise<Request> {
  const timestamp = String(Math.floor(now / 1000));
  const url = new URL(request.url);
  const signature = await mac(
    secret,
    internalPayload(timestamp, request.method, url, await bodyHash(request)),
  );
  const headers = new Headers(request.headers);
  headers.set(HEADER.internalTimestamp, timestamp);
  headers.set(HEADER.internalSignature, signature);
  return new Request(request, { headers });
}

/** Verifies `signInternalRequest` headers within a time window (default 300 s), constant-time. */
export async function verifyInternalRequest(
  request: Request,
  secret: string,
  options: { ttlSeconds?: number; now?: number; header?: string } = {},
): Promise<boolean> {
  const timestamp = request.headers.get(HEADER.internalTimestamp);
  const signature = request.headers.get(options.header ?? HEADER.internalSignature);
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > (options.ttlSeconds ?? 300)) return false;
  const url = new URL(request.url);
  const expected = await mac(
    secret,
    internalPayload(timestamp, request.method, url, await bodyHash(request)),
  );
  return timingSafeEqual(expected, signature);
}

/** Signing utilities namespace (matches the `signing` export in docs/contracts.md). */
export const signing = {
  signUrl,
  verifyUrl,
  signValue,
  verifyValue,
  signInternalRequest,
  verifyInternalRequest,
  signAuditToken,
  verifyAuditToken,
  canonicalUrl,
};
