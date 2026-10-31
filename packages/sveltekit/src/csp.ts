import { type CspConfig, type CspDirectives, HEADER, type HypDrivConfig } from '@hypdriv/core';
import { mergeDirectives } from '@hypdriv/security';

/**
 * SvelteKit's `csp` option as the HypDriv integration carries it into the runtime (the `directives` of the
 * `sveltekit({ csp })` config; SvelteKit writes keywords unquoted: `['self', 'strict-dynamic']`).
 */
export interface SvelteKitCsp {
  mode?: 'auto' | 'hash' | 'nonce';
  directives?: Record<string, string[] | boolean | undefined>;
  reportOnly?: Record<string, string[] | boolean | undefined>;
}

/** Keywords SvelteKit quotes when it serialises a policy (`runtime/server/page/csp.js`). */
const QUOTED = new Set([
  'self',
  'unsafe-eval',
  'unsafe-hashes',
  'unsafe-inline',
  'none',
  'strict-dynamic',
  'report-sample',
  'report-sha256',
  'report-sha384',
  'report-sha512',
  'wasm-unsafe-eval',
  'script',
  'inline-speculation-rules',
]);

const CRYPTO_SOURCE = /^(?:nonce|sha\d{3})-/;

/** Quotes a SvelteKit source the way SvelteKit's serialiser does (`self` → `'self'`). */
export function quoteSource(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("'")) return trimmed;
  return QUOTED.has(trimmed) || CRYPTO_SOURCE.test(trimmed) ? `'${trimmed}'` : trimmed;
}

/**
 * Converts SvelteKit `csp.directives` into HypDriv directives: keywords quoted, `undefined` entries dropped,
 * nonces and hashes dropped (they belong to one response, never to a configuration) and `report-to` dropped
 * (it names a reporting group, and HypDriv's `security.csp.reportTo` owns the `Reporting-Endpoints` header).
 * Returns null when SvelteKit's config sets no directive.
 */
export function svelteKitDirectives(
  directives: SvelteKitCsp['directives'] | null | undefined,
): CspDirectives | null {
  if (!directives) return null;
  const out: CspDirectives = {};
  for (const [name, value] of Object.entries(directives)) {
    const key = name.toLowerCase();
    if (value === undefined || key === 'report-to') continue;
    if (typeof value === 'boolean') {
      if (value) out[key] = true;
      continue;
    }
    if (!Array.isArray(value)) continue;
    const sources = value
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map(quoteSource)
      .filter((v) => !/^'(?:nonce|sha\d{3})-/i.test(v));
    if (sources.length) out[key] = sources;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Folds SvelteKit's `csp.directives` into the HypDriv config, so one policy (HypDriv's, per request) carries both:
 * SvelteKit's sources are unioned with `security.csp.directives`; HypDriv's own `false` entries still remove a
 * directive. A disabled HypDriv CSP (`security.csp: false`) leaves the config untouched: SvelteKit's policy then
 * applies on its own.
 */
export function withSvelteKitCsp(config: HypDrivConfig, csp: SvelteKitCsp | null | undefined): HypDrivConfig {
  const directives = svelteKitDirectives(csp?.directives);
  if (!directives) return config;
  const security = config.security ?? {};
  if (security.csp === false) return config;
  const base: CspConfig = security.csp === true || security.csp === undefined ? {} : security.csp;
  return {
    ...config,
    security: {
      ...security,
      csp: { ...base, directives: mergeDirectives(directives, base.directives) },
    },
  };
}

const NONCE_SOURCE = /'nonce-([^']+)'/;

/** The nonce of a serialised policy (`'nonce-…'`), or null. */
export function policyNonce(policy: string | null | undefined): string | null {
  if (!policy) return null;
  return NONCE_SOURCE.exec(policy)?.[1] ?? null;
}

/**
 * Makes a response SvelteKit rendered with its own CSP (the `csp` option of `sveltekit()`) carry HypDriv's policy
 * instead: SvelteKit's nonce is replaced by the request's HypDriv nonce everywhere in the streamed body (its
 * hydration script, streamed `load` data, Svelte's `hydratable` script, `%sveltekit.nonce%`), and SvelteKit's
 * policy headers are removed so the `csp` stage emits HypDriv's policy (which already contains SvelteKit's
 * directives, see `withSvelteKitCsp`). Without a HypDriv nonce (HypDriv's CSP off, hash mode) the response is
 * returned untouched and SvelteKit's policy applies as the application's own.
 */
export function adoptSvelteKitCsp(response: Response, nonce: string | null | undefined): Response {
  if (!nonce) return response;
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return response;
  const enforced = response.headers.get('content-security-policy');
  const reportOnly = response.headers.get('content-security-policy-report-only');
  if (!enforced && !reportOnly) return response;
  // A policy marked by HypDriv is its own (a static rule), never SvelteKit's.
  if (response.headers.has(HEADER.cspMode)) return response;
  const theirs = policyNonce(enforced) ?? policyNonce(reportOnly);
  const headers = new Headers(response.headers);
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  let body: ReadableStream<Uint8Array> | null = response.body;
  if (theirs && theirs !== nonce && body) {
    body = replaceInStream(body, theirs, nonce);
    // The body changes length and content.
    headers.delete('content-length');
    headers.delete('etag');
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

const encoder = new TextEncoder();

/**
 * Replaces every occurrence of an ASCII token in a byte stream, including occurrences split across chunks. Used
 * for per-response random tokens (nonces), so no HTML awareness is needed.
 */
export function replaceInStream(
  body: ReadableStream<Uint8Array>,
  from: string,
  to: string,
): ReadableStream<Uint8Array> {
  const needle = encoder.encode(from);
  const replacement = encoder.encode(to);
  if (!needle.length) return body;
  let pending = new Uint8Array(0);
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const buf = pending.length ? concat(pending, chunk) : chunk;
      const parts: Uint8Array[] = [];
      let start = 0;
      let i = 0;
      const limit = buf.length - needle.length;
      while (i <= limit) {
        if (buf[i] === needle[0] && matchesAt(buf, needle, i)) {
          if (i > start) parts.push(buf.subarray(start, i));
          parts.push(replacement);
          i += needle.length;
          start = i;
        } else i++;
      }
      // A suffix shorter than the token may be the start of an occurrence completed by the next chunk.
      const keepFrom = Math.max(start, buf.length - (needle.length - 1));
      if (keepFrom > start) parts.push(buf.subarray(start, keepFrom));
      pending = buf.slice(keepFrom);
      if (parts.length) controller.enqueue(parts.length === 1 ? parts[0]! : concat(...parts));
    },
    flush(controller) {
      if (pending.length) controller.enqueue(pending);
      pending = new Uint8Array(0);
    },
  });
  return body.pipeThrough(transform);
}

function matchesAt(buf: Uint8Array, needle: Uint8Array, at: number): boolean {
  for (let j = 1; j < needle.length; j++) if (buf[at + j] !== needle[j]) return false;
  return true;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const a of arrays) size += a.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
