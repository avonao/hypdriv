import {
  base64UrlEncode,
  HEADER,
  type HypContext,
  hmacSign,
  type ResolvedConfig,
  readEnv,
  type StateKey,
  stateKey,
  timingSafeEqual,
} from '@hypdriv/core';

/** Longest lifetime a verifier accepts, however far in the future a token claims to expire. */
export const AUDIT_TOKEN_MAX_TTL_SECONDS = 3600;

/** Default lifetime of tokens minted by `signAuditToken` (and `hypdriv audit|bench|warm`). */
export const AUDIT_TOKEN_DEFAULT_TTL_SECONDS = 1800;

export interface SignAuditTokenOptions {
  /** Host name the token is valid for (the audited origin's `hostname`; ports are ignored). */
  host: string;
  /** Lifetime in seconds (default 1800, capped at {@link AUDIT_TOKEN_MAX_TTL_SECONDS}). */
  ttlSeconds?: number;
  now?: number;
}

export interface VerifyAuditTokenOptions {
  /** Host name of the request (`ctx.url.hostname`). */
  host: string;
  now?: number;
  /** Maximum remaining lifetime accepted (default {@link AUDIT_TOKEN_MAX_TTL_SECONDS}). */
  maxTtlSeconds?: number;
}

function payload(exp: number, host: string): string {
  return `audit:v1:${exp}:${host.toLowerCase()}`;
}

/**
 * Mints a short-lived audit token (`v1.<exp>.<sig>`, sent as `x-hypdriv-audit`) with the internal secret.
 * The owner's own tooling — `hypdriv audit`, `bench`, `warm` and the Purser headless-Chrome audit — presents
 * it so the bot shield and the rate limiter do not treat the audit as hostile automation. It is bound to
 * one host name and expires within an hour; it grants nothing beyond skipping those two stages.
 */
export async function signAuditToken(secret: string, options: SignAuditTokenOptions): Promise<string> {
  const now = options.now ?? Date.now();
  const ttl = Math.max(
    1,
    Math.min(options.ttlSeconds ?? AUDIT_TOKEN_DEFAULT_TTL_SECONDS, AUDIT_TOKEN_MAX_TTL_SECONDS),
  );
  const exp = Math.floor(now / 1000) + ttl;
  const sig = base64UrlEncode(await hmacSign(secret, payload(exp, options.host)));
  return `v1.${exp}.${sig}`;
}

/** Verifies an audit token: version, expiry, maximum lifetime, host binding and HMAC (constant time). */
export async function verifyAuditToken(
  token: string | null | undefined,
  secret: string,
  options: VerifyAuditTokenOptions,
): Promise<boolean> {
  if (!token || token.length > 256) return false;
  const [version, expRaw, sig, extra] = token.split('.');
  if (version !== 'v1' || !expRaw || !sig || extra !== undefined || !/^\d{1,12}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (exp <= nowSeconds) return false;
  if (exp - nowSeconds > (options.maxTtlSeconds ?? AUDIT_TOKEN_MAX_TTL_SECONDS)) return false;
  const expected = base64UrlEncode(await hmacSign(secret, payload(exp, options.host)));
  return timingSafeEqual(expected, sig);
}

/** Memoised outcome of the audit-token check for the current request. */
export const AUDIT_KEY: StateKey<boolean> = stateKey<boolean>('security.audit');

/**
 * `true` when the request carries a valid `x-hypdriv-audit` token for its host, signed with the configured
 * internal secret (`security.internalAuth.secretEnv`, default `HYPDRIV_INTERNAL_SECRET`). The result is
 * memoised per request, so the bot shield and the rate limiter verify the HMAC once.
 */
export async function verifiedAudit(ctx: HypContext, config: ResolvedConfig): Promise<boolean> {
  const memo = ctx.state.get(AUDIT_KEY);
  if (memo !== undefined) return memo;
  const token = ctx.request.headers.get(HEADER.auditToken);
  let ok = false;
  if (token) {
    const secret = readEnv(ctx.env, config.security.internalAuth.secretEnv);
    // The URL host, and the Host the client connected with: some servers rewrite the URL host
    // (`next start` reports `localhost` for requests to 127.0.0.1).
    const hosts = new Set([ctx.url.hostname.toLowerCase()]);
    const hostHeader = ctx.request.headers.get('host');
    if (hostHeader)
      hosts.add(
        hostHeader
          .replace(/:\d+$/, '')
          .replace(/^\[|\]$/g, '')
          .toLowerCase(),
      );
    if (secret)
      for (const host of hosts) {
        if (await verifyAuditToken(token, secret, { host })) {
          ok = true;
          break;
        }
      }
    if (!ok)
      ctx.log.warn('invalid audit token', {
        path: ctx.url.pathname,
        hosts: [...hosts],
        reason: secret ? 'signature, expiry or host' : 'no internal secret',
      });
  }
  ctx.state.set(AUDIT_KEY, ok);
  return ok;
}
