import { parseCspLocal } from './csp-parse';

export interface HeaderGrade {
  grade: 'A+' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  score: number;
  present: string[];
  missing: string[];
  deductions: Array<{ points: number; reason: string }>;
  /** Recommendations that do not affect the grade. */
  notes: string[];
}

export type HeaderMap = Headers | Record<string, string>;

function get(headers: HeaderMap, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key]! : null;
}

const REQUIRED: Array<{ name: string; label: string; points: number }> = [
  { name: 'content-security-policy', label: 'Content-Security-Policy', points: 25 },
  { name: 'strict-transport-security', label: 'Strict-Transport-Security', points: 25 },
  { name: 'x-content-type-options', label: 'X-Content-Type-Options', points: 15 },
  { name: 'x-frame-options', label: 'X-Frame-Options / frame-ancestors', points: 15 },
  { name: 'referrer-policy', label: 'Referrer-Policy', points: 10 },
  { name: 'permissions-policy', label: 'Permissions-Policy', points: 10 },
];

/**
 * Grades response headers the way securityheaders.com does: the six core headers earn points, an
 * A+ requires all of them with an enforced CSP and no deductions, and leaky or weak values deduct.
 */
export function gradeHeaders(
  headers: HeaderMap,
  options: {
    https?: boolean /** false for non-HTML responses (APIs): no CSP required. */;
    document?: boolean;
  } = {},
): HeaderGrade {
  const present: string[] = [];
  const missing: string[] = [];
  const deductions: HeaderGrade['deductions'] = [];
  const notes: string[] = [];
  let score = 0;
  const csp = get(headers, 'content-security-policy');
  const cspRo = get(headers, 'content-security-policy-report-only');
  const parsedCsp = csp ? parseCspLocal(csp) : null;
  const frameAncestors = parsedCsp?.['frame-ancestors'];

  for (const req of REQUIRED) {
    // Browsers ignore HSTS on plain http (local previews), so it is not applicable there.
    if (req.name === 'strict-transport-security' && options.https === false) {
      score += req.points;
      continue;
    }
    // A CSP governs documents; JSON and other non-HTML responses do not need one.
    if (req.name === 'content-security-policy' && options.document === false && !get(headers, req.name)) {
      score += req.points;
      continue;
    }
    let value = get(headers, req.name);
    if (req.name === 'x-frame-options' && !value && Array.isArray(frameAncestors))
      value = `frame-ancestors ${frameAncestors.join(' ')}`;
    if (value) {
      present.push(req.label);
      score += req.points;
    } else missing.push(req.label);
  }
  if (!csp && cspRo) notes.push('CSP is report-only; it does not count towards the grade until enforced.');

  // Value quality
  if (parsedCsp) {
    const script = parsedCsp['script-src'] ?? parsedCsp['default-src'];
    const list = Array.isArray(script) ? script : [];
    const hasNonceOrHash = list.some((s) => /^'(nonce-|sha(256|384|512)-)/i.test(s));
    if (list.some((s) => s.toLowerCase() === "'unsafe-inline'") && !hasNonceOrHash)
      deductions.push({ points: 10, reason: "script-src allows 'unsafe-inline' without nonces or hashes" });
    if (list.some((s) => s.toLowerCase() === "'unsafe-eval'"))
      deductions.push({ points: 5, reason: "script-src allows 'unsafe-eval'" });
    if (list.some((s) => s === '*' || s === 'http:' || s === 'https:'))
      deductions.push({ points: 5, reason: 'script-src allows any origin' });
    if (
      !parsedCsp['object-src'] &&
      !(Array.isArray(parsedCsp['default-src']) && parsedCsp['default-src'].includes("'none'"))
    )
      notes.push("CSP lacks object-src 'none'.");
    if (!parsedCsp['base-uri']) notes.push('CSP lacks base-uri.');
  }
  const hsts = get(headers, 'strict-transport-security');
  if (hsts) {
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
    if (maxAge < 15768000) deductions.push({ points: 5, reason: `HSTS max-age ${maxAge} is below 6 months` });
    else if (maxAge < 31536000) notes.push('HSTS max-age is below one year (preload requires 31536000).');
    if (!/includesubdomains/i.test(hsts)) notes.push('HSTS lacks includeSubDomains.');
  }
  const xcto = get(headers, 'x-content-type-options');
  if (xcto && xcto.toLowerCase().trim() !== 'nosniff')
    deductions.push({ points: 5, reason: `X-Content-Type-Options is "${xcto}" (expected nosniff)` });
  const xfo = get(headers, 'x-frame-options');
  if (xfo && !/^(deny|sameorigin)$/i.test(xfo.trim()))
    deductions.push({ points: 5, reason: `X-Frame-Options "${xfo}" is not DENY/SAMEORIGIN` });
  const referrer = get(headers, 'referrer-policy');
  if (referrer && /unsafe-url|^no-referrer-when-downgrade$/i.test(referrer))
    deductions.push({ points: 5, reason: `Referrer-Policy "${referrer}" leaks the full URL` });

  // Leaks
  const poweredBy = get(headers, 'x-powered-by');
  if (poweredBy) deductions.push({ points: 5, reason: `X-Powered-By reveals "${poweredBy}"` });
  const server = get(headers, 'server');
  if (server && /\d/.test(server) && !/^cloudflare$/i.test(server))
    deductions.push({ points: 5, reason: `Server header reveals a version ("${server}")` });
  for (const name of ['x-aspnet-version', 'x-aspnetmvc-version', 'x-generator']) {
    const v = get(headers, name);
    if (v) deductions.push({ points: 3, reason: `${name} reveals "${v}"` });
  }

  // Recommendations
  if (!get(headers, 'cross-origin-opener-policy')) notes.push('Cross-Origin-Opener-Policy is missing.');
  if (!get(headers, 'cross-origin-resource-policy')) notes.push('Cross-Origin-Resource-Policy is missing.');
  if (!get(headers, 'cache-control')) notes.push('Cache-Control is missing.');
  if (options.https === false && !hsts)
    notes.push('HSTS is not graded over http (local preview); Hypdriv sends it on https origins.');

  const penalty = deductions.reduce((n, d) => n + d.points, 0);
  score = Math.max(0, Math.min(100, score - penalty));
  const allPresent = missing.length === 0 && csp !== null;
  let grade: HeaderGrade['grade'];
  if (allPresent && deductions.length === 0) grade = 'A+';
  else if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 60) grade = 'C';
  else if (score >= 45) grade = 'D';
  else if (score >= 25) grade = 'E';
  else grade = 'F';
  return { grade, score, present, missing, deductions, notes };
}
