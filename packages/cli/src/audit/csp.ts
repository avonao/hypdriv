import { createHash } from 'node:crypto';
import {
  inlineScriptsLocal,
  nonceOf,
  parseCspLocal,
  scriptHashesOf,
  scriptSources,
  scriptTags,
} from './csp-parse';

export type AuditLevel = 'pass' | 'warn' | 'fail';

export interface AuditFinding {
  /** `info` findings explain a result without affecting it. */
  level: 'info' | 'warn' | 'fail';
  message: string;
}

export interface CspAuditResult {
  path: string;
  status: AuditLevel;
  /** Observed policy mode. */
  mode: 'nonce' | 'hash' | 'unsafe-inline' | 'report-only' | 'none';
  expected: 'hash' | 'nonce' | 'none';
  findings: AuditFinding[];
  policy: string | null;
  scripts: { inline: number; external: number; withNonce: number; hashed: number; unmatched: number };
}

export interface CspAuditInput {
  path: string;
  status: number;
  headers: Headers;
  body: string;
  expected: 'hash' | 'nonce' | 'none';
  contentType?: string | null;
}

export interface CspAuditOptions {
  extractInlineScripts?: (html: string) => string[];
}

export function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

function worst(findings: AuditFinding[]): AuditLevel {
  if (findings.some((f) => f.level === 'fail')) return 'fail';
  if (findings.some((f) => f.level === 'warn')) return 'warn';
  return 'pass';
}

/** Validates the CSP of one fetched document against the route's expected mode. */
export function auditCsp(input: CspAuditInput, options: CspAuditOptions = {}): CspAuditResult {
  const findings: AuditFinding[] = [];
  const policy = input.headers.get('content-security-policy');
  const reportOnly = input.headers.get('content-security-policy-report-only');
  const contentType = input.contentType ?? input.headers.get('content-type') ?? '';
  const isHtml = /text\/html/i.test(contentType);
  const scripts = { inline: 0, external: 0, withNonce: 0, hashed: 0, unmatched: 0 };
  const base = (mode: CspAuditResult['mode']): CspAuditResult => ({
    path: input.path,
    status: worst(findings),
    mode,
    expected: input.expected,
    findings,
    policy: policy ?? reportOnly,
    scripts,
  });

  if (input.expected === 'none') {
    if (policy)
      findings.push({
        level: 'warn',
        message: 'a CSP is set on a non-document response (harmless, but unnecessary)',
      });
    return base(policy ? 'nonce' : 'none');
  }
  if (!policy) {
    if (reportOnly) {
      findings.push({
        level: 'warn',
        message: 'only Content-Security-Policy-Report-Only is set; nothing is enforced',
      });
      return base('report-only');
    }
    findings.push({ level: 'fail', message: 'no Content-Security-Policy header' });
    return base('none');
  }
  const directives = parseCspLocal(policy);
  const sources = scriptSources(directives);
  const lower = sources.map((s) => s.toLowerCase());
  const nonce = nonceOf(directives);
  const hashes = scriptHashesOf(directives);
  const mode: CspAuditResult['mode'] = nonce
    ? 'nonce'
    : hashes.length
      ? 'hash'
      : lower.includes("'unsafe-inline'")
        ? 'unsafe-inline'
        : 'none';

  if (!sources.length)
    findings.push({ level: 'fail', message: 'policy has neither script-src nor default-src' });
  // Hypdriv declares its documented fallback for cached HTML (ISR / PPR shells) on runtimes that cannot inject
  // a nonce into a cached body (proxy.ts on Node and Vercel): a known trade-off, not a misconfiguration.
  const declaredFallback = input.headers.get('x-hypdriv-csp') === 'unsafe-inline-fallback';
  if (lower.includes("'unsafe-inline'") && !nonce && !hashes.length)
    findings.push(
      declaredFallback
        ? {
            level: 'warn',
            message:
              "'unsafe-inline' fallback for cached HTML (ISR / PPR shell): no per-request nonce can reach a cached body here — render the route dynamically, or serve it through the Cloudflare Worker for edge nonces",
          }
        : { level: 'fail', message: "script-src allows 'unsafe-inline' without nonces or hashes" },
    );
  if (lower.includes("'unsafe-eval'"))
    findings.push({ level: 'warn', message: "script-src allows 'unsafe-eval'" });
  const objectSrc = directives['object-src'];
  const defaultNone =
    Array.isArray(directives['default-src']) &&
    directives['default-src'].some((s) => s.toLowerCase() === "'none'");
  if (!(Array.isArray(objectSrc) && objectSrc.some((s) => s.toLowerCase() === "'none'")) && !defaultNone)
    findings.push({ level: 'warn', message: "missing object-src 'none'" });
  if (!directives['base-uri']) findings.push({ level: 'warn', message: 'missing base-uri' });
  if (mode === 'nonce' && !lower.includes("'strict-dynamic'"))
    findings.push({
      level: 'warn',
      message: "nonce mode without 'strict-dynamic' (dynamically inserted chunks need host allow-lists)",
    });
  if (input.expected === 'hash' && mode === 'nonce')
    findings.push({
      level: 'warn',
      message:
        'static route served with a nonce policy (expected build-time hashes; the response is not cacheable as-is)',
    });
  if (input.expected === 'nonce' && mode === 'hash')
    findings.push({
      level: 'warn',
      message:
        'dynamic route served with a hash policy; inline scripts that change per request will be blocked',
    });

  if (isHtml && input.body) {
    const tags = scriptTags(input.body);
    const executable = tags.filter((t) => t.executable);
    scripts.inline = executable.filter((t) => t.inline).length;
    scripts.external = executable.filter((t) => !t.inline).length;
    if (mode === 'nonce') {
      const missing = executable.filter((t) => t.attrs.nonce !== nonce);
      scripts.withNonce = executable.length - missing.length;
      // CSP3: inline scripts listed by hash run alongside nonces and 'strict-dynamic' (Hypdriv's
      // speculation rules and theme script are allowed this way).
      const allowedHashes = new Set(hashes.filter((h) => h.startsWith('sha256-')).map((h) => h.slice(7)));
      const missingInline = missing.filter(
        (t) => t.inline && !allowedHashes.has(sha256Base64(t.content)),
      ).length;
      const missingExternal = missing.filter((t) => !t.inline).length;
      if (missingInline)
        findings.push({
          level: 'fail',
          message: `${missingInline} inline script(s) lack the policy nonce and will be blocked`,
        });
      if (missingExternal && !lower.includes("'self'"))
        findings.push({ level: 'fail', message: `${missingExternal} external script(s) lack the nonce` });
      else if (missingExternal)
        findings.push({
          level: 'warn',
          message: `${missingExternal} external script(s) lack the nonce (allowed through 'self' only until 'strict-dynamic' applies)`,
        });
    } else if (mode === 'hash') {
      const extractor = options.extractInlineScripts ?? inlineScriptsLocal;
      const inline = extractor(input.body);
      const sha = new Set(hashes.filter((h) => h.startsWith('sha256-')).map((h) => h.slice(7)));
      let unmatched = 0;
      for (const body of inline) if (!sha.has(sha256Base64(body))) unmatched++;
      scripts.hashed = inline.length - unmatched;
      scripts.unmatched = unmatched;
      if (unmatched)
        findings.push({
          level: 'fail',
          message: `${unmatched} of ${inline.length} inline script(s) do not match any policy hash (stale manifest or per-request inline content)`,
        });
    } else if (mode === 'unsafe-inline' && !declaredFallback) {
      findings.push({
        level: 'warn',
        message:
          "inline scripts run under 'unsafe-inline' (the Node fallback for cached HTML); the Worker upgrades this to nonces",
      });
    }
  }
  return base(mode);
}
