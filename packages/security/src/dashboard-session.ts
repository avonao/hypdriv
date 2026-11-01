import { base64UrlEncode, hmacSign, sha256Hex, timingSafeEqual } from '@hypdriv/core';

/** Shortest dashboard access token accepted. A shorter one is treated as not configured. */
export const DASHBOARD_TOKEN_MIN_LENGTH = 24;

/** Default lifetime of a dashboard session cookie (8 hours). */
export const DASHBOARD_SESSION_DEFAULT_TTL_SECONDS = 8 * 3600;

/** Longest lifetime a verifier accepts, however far in the future a cookie claims to expire (24 hours). */
export const DASHBOARD_SESSION_MAX_TTL_SECONDS = 24 * 3600;

export interface SignDashboardSessionOptions {
  /** Host name the session is valid for (ports are ignored). */
  host: string;
  ttlSeconds?: number;
  now?: number;
}

export interface VerifyDashboardSessionOptions {
  host: string;
  now?: number;
}

// Its own payload prefix: a dashboard session can never stand in for a purge or audit token, nor the reverse.
function payload(exp: number, host: string): string {
  return `dash:v1:${exp}:${host.toLowerCase()}`;
}

/**
 * Compares a presented access token with the configured one in constant time. Both sides are hashed first so
 * the comparison does not leak the length of the secret.
 */
export async function verifyDashboardToken(
  presented: string | null | undefined,
  expected: string | null | undefined,
): Promise<boolean> {
  if (!presented || !expected || expected.length < DASHBOARD_TOKEN_MIN_LENGTH || presented.length > 1024)
    return false;
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(expected)]);
  return timingSafeEqual(a, b);
}

/**
 * Mints a dashboard session (`v1.<exp>.<sig>`) bound to one host, signed with the access token. It carries no
 * secret, so it can live in an `HttpOnly` cookie; rotating the access token invalidates every session.
 */
export async function signDashboardSession(
  secret: string,
  options: SignDashboardSessionOptions,
): Promise<string> {
  const now = options.now ?? Date.now();
  const ttl = Math.max(
    1,
    Math.min(options.ttlSeconds ?? DASHBOARD_SESSION_DEFAULT_TTL_SECONDS, DASHBOARD_SESSION_MAX_TTL_SECONDS),
  );
  const exp = Math.floor(now / 1000) + ttl;
  const sig = base64UrlEncode(await hmacSign(secret, payload(exp, options.host)));
  return `v1.${exp}.${sig}`;
}

/** Verifies a dashboard session: version, expiry, maximum lifetime, host binding and HMAC (constant time). */
export async function verifyDashboardSession(
  session: string | null | undefined,
  secret: string,
  options: VerifyDashboardSessionOptions,
): Promise<boolean> {
  if (!session || session.length > 256 || secret.length < DASHBOARD_TOKEN_MIN_LENGTH) return false;
  const [version, expRaw, sig, extra] = session.split('.');
  if (version !== 'v1' || !expRaw || !sig || extra !== undefined || !/^\d{1,12}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (exp <= nowSeconds || exp - nowSeconds > DASHBOARD_SESSION_MAX_TTL_SECONDS) return false;
  const expected = base64UrlEncode(await hmacSign(secret, payload(exp, options.host)));
  return timingSafeEqual(expected, sig);
}
