import {
  base64UrlEncode,
  defineStage,
  getCookie,
  hmacSign,
  json,
  matchesAny,
  type ResolvedConfig,
  randomToken,
  readEnv,
  type Stage,
  timingSafeEqual,
} from '@hypdriv/core';

/** Methods that never need CSRF protection. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** Alternate form field accepted for the token. */
export const CSRF_FORM_FIELD = '_csrf';

async function sign(secret: string, id: string, sessionId: string | undefined): Promise<string> {
  return base64UrlEncode(await hmacSign(secret, `csrf:${id}:${sessionId ?? ''}`));
}

/**
 * Issues a CSRF token: `<id>.<sig>` where `sig = HMAC-SHA256(secret, "csrf:" + id + ":" + sessionId)`.
 * Put it in the CSRF cookie and echo it in the header (or the `_csrf` form field).
 */
export async function issueCsrfToken(secret: string, sessionId?: string): Promise<string> {
  const id = randomToken(16);
  return `${id}.${await sign(secret, id, sessionId)}`;
}

/** Verifies a token issued by `issueCsrfToken` (constant-time). */
export async function verifyCsrfToken(secret: string, token: string, sessionId?: string): Promise<boolean> {
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return false;
  const id = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!id || !sig) return false;
  return timingSafeEqual(await sign(secret, id, sessionId), sig);
}

/** Reads the submitted token from the header or, for form posts, from the form body. */
export async function readSubmittedCsrfToken(request: Request, headerName: string): Promise<string | null> {
  const fromHeader = request.headers.get(headerName);
  if (fromHeader) return fromHeader;
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/x-www-form-urlencoded') && !type.includes('multipart/form-data'))
    return null;
  try {
    const form = await request.clone().formData();
    const value = form.get(headerName) ?? form.get(CSRF_FORM_FIELD);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/** Why a request failed the CSRF check. */
export type CsrfFailure =
  | 'cross-site'
  | 'missing-cookie'
  | 'missing-token'
  | 'mismatch'
  | 'invalid-signature';

/**
 * Pure CSRF check for one request: same-origin `Sec-Fetch-Site` (when accepted) or a double-submit token
 * (cookie equals header/form value; verified with HMAC when a secret is available).
 */
export async function checkCsrf(
  request: Request,
  options: {
    cookie: string;
    header: string;
    acceptSecFetchSite: boolean;
    secret?: string;
    sessionId?: string;
  },
): Promise<{ ok: true; via: 'sec-fetch-site' | 'token' } | { ok: false; reason: CsrfFailure }> {
  const site = request.headers.get('sec-fetch-site');
  if (options.acceptSecFetchSite && (site === 'same-origin' || site === 'none'))
    return { ok: true, via: 'sec-fetch-site' };
  const cookie = getCookie(request.headers, options.cookie);
  const submitted = await readSubmittedCsrfToken(request, options.header);
  if (!cookie && !submitted && site && site !== 'same-origin' && site !== 'none')
    return { ok: false, reason: 'cross-site' };
  if (!cookie) return { ok: false, reason: 'missing-cookie' };
  if (!submitted) return { ok: false, reason: 'missing-token' };
  if (!timingSafeEqual(cookie, submitted)) return { ok: false, reason: 'mismatch' };
  if (options.secret && !(await verifyCsrfToken(options.secret, submitted, options.sessionId)))
    return { ok: false, reason: 'invalid-signature' };
  return { ok: true, via: 'token' };
}

/**
 * The `csrf` stage: protects unsafe methods on matching, non-exempt routes. Uses the session secret
 * (`security.sessions.secretEnv`) to verify token signatures when it is available.
 */
export function csrfStage(config: ResolvedConfig): Stage {
  const csrf = config.security.csrf;
  return defineStage({
    name: 'csrf',
    async pre(ctx) {
      if (!csrf) return;
      if (SAFE_METHODS.has(ctx.request.method.toUpperCase())) return;
      if (!matchesAny(csrf.match, ctx.url) || matchesAny(csrf.exempt, ctx.url)) return;
      const result = await checkCsrf(ctx.request, {
        cookie: csrf.cookie,
        header: csrf.header,
        acceptSecFetchSite: csrf.acceptSecFetchSite,
        secret: readEnv(ctx.env, config.security.sessions.secretEnv),
      });
      if (result.ok) return;
      ctx.timings.mark('csrf', result.reason);
      ctx.log.warn('csrf rejected', {
        reason: result.reason,
        path: ctx.url.pathname,
        method: ctx.request.method,
      });
      return json(
        { error: 'csrf', reason: result.reason },
        { status: 403, headers: { 'cache-control': 'no-store' } },
      );
    },
  });
}
