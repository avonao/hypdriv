import type { CspDirectives, ResolvedCsp } from '@hypdriv/core';
import { mergeDirectives, normalizeSources, serializeCsp } from './directives';

/** Input of `buildCspHeader` / `buildCspDirectives`. */
export interface CspBuildInput {
  config: ResolvedCsp;
  /**
   * - `nonce`: `script-src 'self' 'nonce-…' 'strict-dynamic'` (dynamic, shell and ISR routes, and any
   *   HTML the edge can rewrite).
   * - `hash`: `script-src 'self' 'sha256-…' …` for immutable static HTML. `'strict-dynamic'` is
   *   deliberately omitted: prerendered HTML contains parser-inserted external `<script src>` tags
   *   without a nonce, which `'strict-dynamic'` would block.
   * - `unsafe-inline`: `script-src 'self' 'unsafe-inline'` — the fallback for cached HTML on runtimes
   *   without `HTMLRewriter` (see `cspStage`).
   */
  mode: 'nonce' | 'hash' | 'unsafe-inline';
  nonce?: string;
  /** Build-time hashes from `manifest.csp[routeId]`, already formatted as `'sha256-…'` (quotes optional). */
  hashes?: { scriptHashes: string[]; styleHashes: string[] };
  /** Additional script hashes (edge-injected inline scripts). Quotes optional. */
  extraScriptHashes?: string[];
  development: boolean;
  /** Overrides `config.reportTo`; `null` disables reporting for this policy. */
  reportTo?: string | null;
  /** Request origin; in development its `ws(s)://` form is added to `connect-src` for HMR. */
  origin?: string | null;
}

/** Normalises a hash source: `sha256-abc` → `'sha256-abc'`, keeps already-quoted values untouched. */
export function formatHashSource(hash: string): string {
  const trimmed = hash.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed;
  return `'${trimmed}'`;
}

function isNonceSource(src: string): boolean {
  return /^'nonce-/i.test(src);
}

/** Builds the directive set for a request. Pure: the same input always yields the same directives. */
export function buildCspDirectives(input: CspBuildInput): CspDirectives {
  const { config, mode, development } = input;
  const allow = config.allow;
  const directives = mergeDirectives(config.directives, {
    'img-src': allow.images,
    'font-src': allow.fonts,
    'connect-src': allow.connect,
    'frame-src': allow.frames,
    'media-src': allow.media,
    'worker-src': allow.workers,
    'frame-ancestors': allow.frameAncestors,
    'form-action': allow.formAction,
  });

  // script-src
  const scriptBase = (Array.isArray(directives['script-src']) ? directives['script-src'] : []).filter(
    (s) => !isNonceSource(s) && s.toLowerCase() !== "'strict-dynamic'",
  );
  const scriptSrc: string[] = ["'self'"];
  if (mode === 'nonce') {
    if (!input.nonce) throw new TypeError('buildCspHeader: nonce mode requires a nonce');
    scriptSrc.push(`'nonce-${input.nonce}'`);
    if (config.strictDynamic) scriptSrc.push("'strict-dynamic'");
  } else if (mode === 'hash') {
    for (const h of input.hashes?.scriptHashes ?? []) scriptSrc.push(formatHashSource(h));
  }
  for (const h of input.extraScriptHashes ?? []) scriptSrc.push(formatHashSource(h));
  if (mode === 'hash' || mode === 'unsafe-inline') {
    // CSP1 fallback: browsers that understand hashes ignore 'unsafe-inline' when a hash is present.
    scriptSrc.push("'unsafe-inline'");
  }
  if (development && config.devUnsafeEval) scriptSrc.push("'unsafe-eval'");
  scriptSrc.push(...allow.scripts, ...scriptBase);
  directives['script-src'] = normalizeSources(scriptSrc);

  // style-src
  const styleBase = (Array.isArray(directives['style-src']) ? directives['style-src'] : []).filter(
    (s) => !isNonceSource(s),
  );
  const styleSrc: string[] = ["'self'"];
  if (config.unsafeInlineStyles) styleSrc.push("'unsafe-inline'");
  else if (mode === 'nonce' && input.nonce) styleSrc.push(`'nonce-${input.nonce}'`);
  else if (mode === 'hash')
    for (const h of input.hashes?.styleHashes ?? []) styleSrc.push(formatHashSource(h));
  else if (mode === 'unsafe-inline') styleSrc.push("'unsafe-inline'");
  styleSrc.push(...allow.styles, ...styleBase);
  directives['style-src'] = normalizeSources(styleSrc);

  // development conveniences: HMR websocket
  if (development && input.origin) {
    try {
      const u = new URL(input.origin);
      const ws = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
      directives['connect-src'] = normalizeSources([
        ...(Array.isArray(directives['connect-src']) ? directives['connect-src'] : ["'self'"]),
        ws,
      ]);
    } catch {
      // ignore unparsable origins
    }
  }

  // reporting
  const reportTo = input.reportTo === undefined ? config.reportTo : input.reportTo;
  if (reportTo) {
    directives['report-uri'] = [reportTo];
    directives['report-to'] = ['hypdriv'];
  } else {
    delete directives['report-uri'];
    delete directives['report-to'];
  }

  // upgrade-insecure-requests: never in development (http://localhost)
  if (config.upgradeInsecureRequests && !development) directives['upgrade-insecure-requests'] = true;
  else delete directives['upgrade-insecure-requests'];

  // Trusted Types
  if (config.trustedTypes) {
    directives['require-trusted-types-for'] = ["'script'"];
    const policies = [...config.trustedTypes.policies];
    if (config.trustedTypes.allowDuplicates) policies.push("'allow-duplicates'");
    directives['trusted-types'] = normalizeSources(policies);
  }

  return directives;
}

/** Serialised policy for a request (see `buildCspDirectives`). */
export function buildCspHeader(input: CspBuildInput): string {
  return serializeCsp(buildCspDirectives(input));
}
