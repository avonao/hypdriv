import type { CspDirectives } from '@hypdriv/core';
import { mergeDirectives } from './directives';

/** Normalised CSP violation report (legacy `csp-report` and Reporting API shapes). */
export interface CspReport {
  documentUri: string;
  violatedDirective: string;
  effectiveDirective: string;
  blockedUri: string;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
  disposition: 'enforce' | 'report';
  originalPolicy?: string;
  sample?: string;
  userAgent?: string;
  /** Epoch milliseconds when the report was received. */
  ts: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

type Raw = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Normalises one report body (either shape) into a `CspReport`; returns null when unusable. */
export function normalizeCspReport(body: unknown, meta: { userAgent?: string; ts?: number } = {}): CspReport | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Raw;
  const violated = str(raw['violated-directive']) ?? str(raw.violatedDirective) ?? str(raw.effectiveDirective);
  const effective = str(raw['effective-directive']) ?? str(raw.effectiveDirective) ?? violated;
  if (!effective) return null;
  const dispositionRaw = str(raw.disposition);
  const report: CspReport = {
    documentUri: str(raw['document-uri']) ?? str(raw.documentURL) ?? str(raw.documentUri) ?? '',
    violatedDirective: (violated ?? effective).split(/\s+/)[0] ?? effective,
    effectiveDirective: effective.split(/\s+/)[0] ?? effective,
    blockedUri: str(raw['blocked-uri']) ?? str(raw.blockedURL) ?? str(raw.blockedUri) ?? '',
    disposition: dispositionRaw === 'report' ? 'report' : 'enforce',
    ts: meta.ts ?? Date.now(),
  };
  const sourceFile = str(raw['source-file']) ?? str(raw.sourceFile);
  if (sourceFile) report.sourceFile = sourceFile;
  const line = num(raw['line-number']) ?? num(raw.lineNumber);
  if (line !== undefined) report.lineNumber = line;
  const column = num(raw['column-number']) ?? num(raw.columnNumber);
  if (column !== undefined) report.columnNumber = column;
  const original = str(raw['original-policy']) ?? str(raw.originalPolicy);
  if (original) report.originalPolicy = original;
  const sample = str(raw['script-sample']) ?? str(raw.sample);
  if (sample) report.sample = sample.slice(0, 200);
  if (meta.userAgent) report.userAgent = meta.userAgent;
  return report;
}

/** Extracts every report from a parsed request body of any supported shape. */
export function extractCspReports(parsed: unknown, meta: { userAgent?: string; ts?: number }): CspReport[] {
  const out: CspReport[] = [];
  const push = (body: unknown, ua?: string) => {
    const r = normalizeCspReport(body, { ...meta, ...(ua ? { userAgent: ua } : {}) });
    if (r) out.push(r);
  };
  if (Array.isArray(parsed)) {
    // Reporting API: [{ type: 'csp-violation', body: {...}, user_agent, url, age }]
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Raw;
      if (entry.type && entry.type !== 'csp-violation') continue;
      push(entry.body ?? entry, str(entry.user_agent) ?? str(entry.userAgent) ?? meta.userAgent);
    }
    return out;
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Raw;
    if (obj['csp-report']) push(obj['csp-report']);
    else if (obj.body && typeof obj.body === 'object') push(obj.body, str(obj.user_agent) ?? meta.userAgent);
    else push(obj);
  }
  return out;
}

/**
 * Handler for the CSP report collector (`/_hypdriv/csp-report`). Accepts `application/csp-report`,
 * `application/reports+json` and plain JSON; caps the body size; answers `204` after passing each
 * normalised report to `sink`.
 */
export function cspReportHandler(options: {
  sink: (report: CspReport) => void | Promise<void>;
  maxBytes?: number;
}): (request: Request) => Promise<Response> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'POST' } });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > maxBytes) return new Response(null, { status: 413 });
    let text: string;
    try {
      text = await request.text();
    } catch {
      return new Response(null, { status: 400 });
    }
    if (text.length > maxBytes) return new Response(null, { status: 413 });
    if (!text.trim()) return new Response(null, { status: 204 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(null, { status: 400 });
    }
    const reports = extractCspReports(parsed, {
      userAgent: request.headers.get('user-agent') ?? undefined,
      ts: Date.now(),
    });
    for (const report of reports) await options.sink(report);
    return new Response(null, { status: 204 });
  };
}

const IGNORED_BLOCKED = new Set([
  '',
  'inline',
  'eval',
  'wasm-eval',
  'self',
  'about',
  'about:blank',
  'trusted-types-sink',
  'trusted-types-policy',
]);
const IGNORED_SCHEMES = /^(?:chrome|chrome-extension|moz-extension|safari-extension|safari-web-extension|edge-extension|ms-browser-extension|opera-extension|about|javascript|resource|file):/i;
const SCHEME_SOURCES = new Set(['data', 'blob', 'filesystem', 'mediastream', 'ws', 'wss']);

/** Maps a blocked URI to a CSP source expression, or null when it should be ignored. */
export function sourceForBlockedUri(blockedUri: string, documentUri: string): string | null {
  const uri = blockedUri.trim();
  if (IGNORED_BLOCKED.has(uri.toLowerCase()) || IGNORED_SCHEMES.test(uri)) return null;
  const bare = uri.endsWith(':') ? uri.slice(0, -1) : uri;
  if (SCHEME_SOURCES.has(bare.toLowerCase())) return `${bare.toLowerCase()}:`;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (!/^(?:https?|wss?):$/.test(url.protocol)) return null;
  try {
    if (documentUri && new URL(documentUri).origin === url.origin) return "'self'";
  } catch {
    // unparsable document URI: fall through to the origin
  }
  return url.origin;
}

const ELEM_ATTR_SUFFIX = /-(?:elem|attr)$/;

/**
 * Aggregates violation reports into origin-level source additions per directive, ignoring inline/eval
 * violations and browser-extension noise. Returns the proposed additions (sorted by count) and the
 * merged directive set.
 */
export function suggestPolicy(
  reports: CspReport[],
  current: CspDirectives,
): { directives: CspDirectives; additions: Array<{ directive: string; source: string; count: number }> } {
  const counts = new Map<string, { directive: string; source: string; count: number }>();
  for (const report of reports) {
    let directive = (report.effectiveDirective || report.violatedDirective).toLowerCase();
    if (!directive) continue;
    // Browsers report `script-src-elem`; fold into the base directive unless the policy sets the specific one.
    if (ELEM_ATTR_SUFFIX.test(directive) && !(directive in current)) directive = directive.replace(ELEM_ATTR_SUFFIX, '');
    const source = sourceForBlockedUri(report.blockedUri, report.documentUri);
    if (!source) continue;
    const existing = current[directive];
    if (Array.isArray(existing) && existing.some((s) => s.toLowerCase() === source.toLowerCase())) continue;
    const key = `${directive} ${source}`;
    const entry = counts.get(key) ?? { directive, source, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const additions = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.directive.localeCompare(b.directive) || a.source.localeCompare(b.source),
  );
  const patch: CspDirectives = {};
  for (const add of additions) {
    const list = patch[add.directive];
    patch[add.directive] = [...(Array.isArray(list) ? list : []), add.source];
  }
  return { directives: mergeDirectives(current, patch), additions };
}
