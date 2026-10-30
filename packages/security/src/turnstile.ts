/** Cloudflare Turnstile siteverify endpoint. */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Header and form field that carry a Turnstile token. */
export const TURNSTILE_TOKEN_FIELD = 'cf-turnstile-response';

/** Result of `verifyTurnstile`. */
export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
  /** Hostname the challenge was solved on. */
  hostname?: string;
  /** `action` configured on the widget. */
  action?: string;
  /** `cData` configured on the widget. */
  cdata?: string;
  challengeTs?: string;
}

/**
 * Verifies a Turnstile token with Cloudflare's siteverify API (form-encoded POST). Network failures
 * resolve to `{ success: false, errorCodes: ['network-error'] }`; the function never throws.
 */
export async function verifyTurnstile(
  secret: string,
  token: string,
  ip?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TurnstileResult> {
  if (!token || !secret) return { success: false, errorCodes: ['missing-input-response'] };
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== '0.0.0.0') body.set('remoteip', ip);
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return { success: false, errorCodes: [`http-${res.status}`] };
    const data = (await res.json()) as {
      success?: boolean;
      'error-codes'?: string[];
      hostname?: string;
      action?: string;
      cdata?: string;
      challenge_ts?: string;
    };
    const out: TurnstileResult = { success: data.success === true, errorCodes: data['error-codes'] ?? [] };
    if (data.hostname) out.hostname = data.hostname;
    if (data.action) out.action = data.action;
    if (data.cdata) out.cdata = data.cdata;
    if (data.challenge_ts) out.challengeTs = data.challenge_ts;
    return out;
  } catch {
    return { success: false, errorCodes: ['network-error'] };
  }
}

/** Reads a Turnstile token from the header, or from a form body for `POST` form submissions. */
export async function readTurnstileToken(
  request: Request,
  field = TURNSTILE_TOKEN_FIELD,
): Promise<string | null> {
  const fromHeader = request.headers.get(field);
  if (fromHeader) return fromHeader;
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/x-www-form-urlencoded') && !type.includes('multipart/form-data'))
    return null;
  try {
    const form = await request.clone().formData();
    const value = form.get(field);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Options of `turnstileChallengePage`. */
export interface ChallengePageOptions {
  siteKey: string;
  /** Per-response CSP nonce for the inline script. */
  nonce: string;
  action?: string | null;
  title?: string;
  /** Header the page sets when posting the token back (lets the stage answer with a clearance cookie). */
  resubmitHeader?: string;
}

/**
 * Minimal HTML challenge page: renders the Turnstile widget and, on success, posts the token to the
 * current URL (header `cf-turnstile-response` + `resubmitHeader`), then reloads so the original request
 * is retried with the clearance cookie.
 */
export function turnstileChallengePage(options: ChallengePageOptions): string {
  const title = escapeHtml(options.title ?? 'Checking your browser');
  const action = options.action ? ` data-action="${escapeHtml(options.action)}"` : '';
  const resubmit = escapeHtml(options.resubmitHeader ?? 'x-hypdriv-challenge');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
html,body{height:100%;margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fafafa}
main{min-height:100%;display:grid;place-items:center;padding:24px}
section{max-width:420px;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0 0 1rem;color:#555}
noscript{display:block;color:#b00}
</style>
<script nonce="${options.nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
<main><section>
<h1>${title}</h1>
<p>This check keeps automated traffic away. It only takes a moment.</p>
<div class="cf-turnstile" data-sitekey="${escapeHtml(options.siteKey)}" data-callback="hypdrivChallengeDone"${action}></div>
<noscript>JavaScript is required to continue.</noscript>
<p id="status" aria-live="polite"></p>
</section></main>
<script nonce="${options.nonce}">
window.hypdrivChallengeDone=function(token){
  var s=document.getElementById('status');
  fetch(location.pathname+location.search,{method:'POST',credentials:'same-origin',headers:{'${TURNSTILE_TOKEN_FIELD}':token,'${resubmit}':'1'}})
    .then(function(r){if(r.ok){location.reload();}else{s.textContent='Verification failed. Please reload and try again.';}})
    .catch(function(){s.textContent='Network error. Please reload and try again.';});
};
</script>
</body>
</html>
`;
}
