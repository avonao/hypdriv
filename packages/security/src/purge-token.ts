import { base64UrlEncode, hmacSign, timingSafeEqual } from '@hypdriv/core';

/** Longest lifetime a verifier accepts, however far in the future a token claims to expire. */
export const PURGE_TOKEN_MAX_TTL_SECONDS = 300;

/** Default lifetime of tokens minted by `signPurgeToken` (and `hypdriv purge`). */
export const PURGE_TOKEN_DEFAULT_TTL_SECONDS = 120;

export interface SignPurgeTokenOptions {
  /** Host name the token is valid for (the purged origin's `hostname`; ports are ignored). */
  host: string;
  /** Lifetime in seconds (default 120, capped at {@link PURGE_TOKEN_MAX_TTL_SECONDS}). */
  ttlSeconds?: number;
  now?: number;
}

export interface VerifyPurgeTokenOptions {
  /** Host name of the request. */
  host: string;
  now?: number;
}

// A different payload prefix from the audit token: an audit token (30 minutes, minted by every audit, bench and
// warm run) can never authorise a purge, and a purge token never passes the bot shield as an audit.
function payload(exp: number, host: string): string {
  return `purge:v1:${exp}:${host.toLowerCase()}`;
}

/**
 * Mints a short-lived purge token (`v1.<exp>.<sig>`, sent as `x-hypdriv-purge`) with the internal secret. It is
 * bound to one host name and expires within five minutes; `POST /_hypdriv/purge` accepts nothing else.
 */
export async function signPurgeToken(secret: string, options: SignPurgeTokenOptions): Promise<string> {
  const now = options.now ?? Date.now();
  const ttl = Math.max(
    1,
    Math.min(options.ttlSeconds ?? PURGE_TOKEN_DEFAULT_TTL_SECONDS, PURGE_TOKEN_MAX_TTL_SECONDS),
  );
  const exp = Math.floor(now / 1000) + ttl;
  const sig = base64UrlEncode(await hmacSign(secret, payload(exp, options.host)));
  return `v1.${exp}.${sig}`;
}

/** Verifies a purge token: version, expiry, maximum lifetime, host binding and HMAC (constant time). */
export async function verifyPurgeToken(
  token: string | null | undefined,
  secret: string,
  options: VerifyPurgeTokenOptions,
): Promise<boolean> {
  if (!token || token.length > 256) return false;
  const [version, expRaw, sig, extra] = token.split('.');
  if (version !== 'v1' || !expRaw || !sig || extra !== undefined || !/^\d{1,12}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (exp <= nowSeconds) return false;
  if (exp - nowSeconds > PURGE_TOKEN_MAX_TTL_SECONDS) return false;
  const expected = base64UrlEncode(await hmacSign(secret, payload(exp, options.host)));
  return timingSafeEqual(expected, sig);
}
