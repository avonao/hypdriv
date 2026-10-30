import {
  type CspDirectives,
  createNonce,
  defineStage,
  firstMatch,
  HEADER,
  type HypContext,
  isHtmlResponse,
  isRscRequest,
  type ResolvedConfig,
  type ResolvedCsp,
  type Stage,
  type StateKey,
  stateKey,
  withHeaders,
} from '@hypdriv/core';
import { CSP_EXTRA_HASHES_KEY, CSP_MODE_KEY, type CspMode, NONCE_KEY } from '../keys';
import { buildCspDirectives } from './build';
import { mergeDirectives, serializeCsp, withoutSource } from './directives';

/** Structural subset of Workers' `HTMLRewriter` (kept local: this package never imports workers-types). */
export interface HtmlRewriterElementLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): unknown;
}
export interface HtmlRewriterLike {
  on(
    selector: string,
    handlers: { element?(element: HtmlRewriterElementLike): void | Promise<void> },
  ): HtmlRewriterLike;
  transform(response: Response): Response;
}
export type HtmlRewriterConstructor = new () => HtmlRewriterLike;

/** Options of `cspStage`. */
export interface CspStageOptions {
  /**
   * Edge nonce injection for HTML responses in nonce mode (ADR 0006 amendment):
   * - `auto` (default): inject with `HTMLRewriter` when it exists; without it, `isr`/`shell` routes fall
   *   back to `script-src 'self' 'unsafe-inline'` (`x-hypdriv-csp: unsafe-inline-fallback`).
   * - `always`: inject when `HTMLRewriter` exists and never degrade to the fallback.
   * - `never`: never transform bodies; `isr`/`shell` routes use the fallback policy.
   */
  edgeNonceInjection?: 'auto' | 'always' | 'never';
  /** Override the `HTMLRewriter` implementation (tests, custom runtimes). Default `globalThis.HTMLRewriter`. */
  htmlRewriter?: HtmlRewriterConstructor | null;
}

/** Decision made in `pre`, consumed in `post`. */
export interface CspDecision {
  mode: 'nonce' | 'hash' | 'unsafe-inline' | 'off';
  nonce?: string;
  /** Serialised policy sent to Next.js in nonce mode (request header). */
  requestPolicy?: string;
  reportOnly: boolean | 'both';
  /** Effective config: base config with the matching route's directives merged in. */
  effective: ResolvedCsp;
  hashes?: { scriptHashes: string[]; styleHashes: string[] };
  inject: boolean;
}

/** The decision of the `csp` stage for the current request (read by DevTools and tests). */
export const CSP_DECISION_KEY: StateKey<CspDecision> = stateKey<CspDecision>('security.csp-decision');

function resolveRewriter(options: CspStageOptions): HtmlRewriterConstructor | null {
  if (options.htmlRewriter !== undefined) return options.htmlRewriter;
  const ctor = (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
  return typeof ctor === 'function' ? (ctor as HtmlRewriterConstructor) : null;
}

/**
 * Adds `nonce` to every `<script>` (and optionally `<style>`) element lacking one, using `HTMLRewriter`.
 * Returns the response untouched when no rewriter is available. Idempotent for Next-rendered HTML that
 * already carries the nonce.
 */
export function injectNonce(
  response: Response,
  nonce: string,
  options: { styles?: boolean; htmlRewriter?: HtmlRewriterConstructor | null } = {},
): Response {
  const Rewriter = resolveRewriter(options);
  if (!Rewriter) return response;
  const handler = {
    element(el: HtmlRewriterElementLike) {
      if (!el.getAttribute('nonce')) el.setAttribute('nonce', nonce);
    },
  };
  let rewriter = new Rewriter().on('script', handler);
  if (options.styles) rewriter = rewriter.on('style', handler).on('link[rel="stylesheet"]', handler);
  return rewriter.transform(response);
}

function absolutize(reportTo: string, origin: string): string {
  try {
    return new URL(reportTo, origin).href;
  } catch {
    return reportTo;
  }
}

/** Policy headers computed for a decision. */
export function policyHeadersFor(
  decision: CspDecision,
  ctx: Pick<HypContext, 'development' | 'url' | 'state'> & Partial<Pick<HypContext, 'manifest'>>,
): { enforced?: string; reportOnly?: string } {
  if (decision.mode === 'off') return {};
  // Inline scripts injected by edge stages (speculation rules, theme pinning) are allowed by hash in both
  // modes: in nonce mode the injected tags carry no nonce on uncached responses, and CSP3 permits hashes
  // alongside 'strict-dynamic'. The 'unsafe-inline' fallback mode needs no hashes.
  // HypDriv's own route-independent inline scripts (speculation document rules, the Purser theme
  // fallback) render without a nonce so layouts stay prerenderable; the manifest carries their hashes.
  const manifest = (ctx as { manifest?: HypContext['manifest'] }).manifest;
  const manifestHashes = [...(manifest?.inlineScriptHashes ?? []), ...(manifest?.purser?.themeScriptHash ? [manifest.purser.themeScriptHash] : [])];
  const extra =
    decision.mode === 'hash' || decision.mode === 'nonce'
      ? [...new Set([...(ctx.state.get(CSP_EXTRA_HASHES_KEY) ?? []), ...manifestHashes])]
      : [];
  const directives: CspDirectives = buildCspDirectives({
    config: decision.effective,
    mode: decision.mode,
    nonce: decision.nonce,
    hashes: decision.hashes,
    extraScriptHashes: extra,
    // 'unsafe-eval' is only for `next dev`; the Worker always serves a production build of Next.js.
    development: ctx.development && (ctx as { runner?: string }).runner !== 'worker',
    origin: ctx.url.origin,
  });
  const policy = serializeCsp(directives);
  if (decision.reportOnly === true) return { reportOnly: policy };
  if (decision.reportOnly === 'both')
    return { enforced: policy, reportOnly: serializeCsp(withoutSource(directives, "'unsafe-inline'")) };
  return { enforced: policy };
}

/**
 * The `csp` stage (ADR 0006). `pre` picks the mode (route override → config → `auto`), generates the
 * nonce and forwards it to Next.js through the request headers; `post` emits the response policy,
 * injects the nonce into cached HTML at the edge, and never overrides a policy the application set.
 */
export function cspStage(config: ResolvedConfig, options: CspStageOptions = {}): Stage {
  const csp = config.security.csp;
  const injection = options.edgeNonceInjection ?? 'auto';

  return defineStage({
    name: 'csp',
    pre(ctx) {
      if (!csp) {
        ctx.state.set(CSP_MODE_KEY, 'off');
        return;
      }
      const override = firstMatch(csp.routes, ctx.url);
      const configured = override?.mode ?? csp.mode;
      const reportOnly = override?.reportOnly ?? csp.reportOnly;
      const effective: ResolvedCsp = override
        ? { ...csp, directives: mergeDirectives(csp.directives, override.directives) }
        : csp;
      if (configured === 'off') {
        ctx.state.set(CSP_DECISION_KEY, { mode: 'off', reportOnly, effective, inject: false });
        ctx.state.set(CSP_MODE_KEY, 'off');
        return;
      }
      const route = ctx.route?.route;
      const hashes = route ? ctx.manifest.csp[route.id] : undefined;
      const rsc = isRscRequest(ctx.request.headers);
      const classification = route?.classification;
      let mode: 'nonce' | 'hash' | 'unsafe-inline';
      if (configured === 'hash') mode = 'hash';
      else if (configured === 'nonce') mode = 'nonce';
      else mode = classification === 'static' && hashes && !rsc ? 'hash' : 'nonce';

      const rewriter = resolveRewriter(options);
      const canInject = injection !== 'never' && rewriter !== null;
      let inject = false;
      if (mode === 'nonce') {
        const cachedHtml = classification === 'isr' || classification === 'shell';
        if (canInject) inject = true;
        else if (cachedHtml && injection !== 'always') mode = 'unsafe-inline';
      }

      const decision: CspDecision = { mode, reportOnly, effective, inject, ...(hashes ? { hashes } : {}) };
      if (mode === 'nonce') {
        const nonce = createNonce();
        decision.nonce = nonce;
        decision.requestPolicy = serializeCsp(
          buildCspDirectives({
            config: effective,
            mode: 'nonce',
            nonce,
            development: ctx.development && ctx.runner !== 'worker',
            origin: ctx.url.origin,
          }),
        );
        ctx.state.set(NONCE_KEY, nonce);
        ctx.requestHeaders.set(effective.nonceHeader, nonce);
        // Next.js reads the nonce from the request's CSP header and applies it to its inline scripts.
        ctx.requestHeaders.set('content-security-policy', decision.requestPolicy);
      }
      ctx.state.set(CSP_DECISION_KEY, decision);
      ctx.state.set(CSP_MODE_KEY, effectiveMode(decision));
    },
    post(ctx, response) {
      const decision = ctx.state.get(CSP_DECISION_KEY);
      if (!csp || !decision) return response;
      const headers: Record<string, string> = {};
      if (decision.mode === 'off') {
        headers[HEADER.cspMode] = 'off';
        ctx.timings.mark('csp', 'off');
        return withHeaders(response, headers);
      }
      const reportTo = decision.effective.reportTo;
      if (reportTo && decision.effective.reportingEndpoints)
        headers['reporting-endpoints'] = `hypdriv="${absolutize(reportTo, ctx.url.origin)}"`;
      if (!isHtmlResponse(response))
        return Object.keys(headers).length ? withHeaders(response, headers) : response;

      const { enforced, reportOnly } = policyHeadersFor(decision, ctx);
      const appEnforced = response.headers.get('content-security-policy');
      const appReportOnly = response.headers.get('content-security-policy-report-only');
      const appSet =
        (appEnforced && appEnforced !== enforced) || (appReportOnly && appReportOnly !== reportOnly);
      if (appSet) {
        headers[HEADER.cspMode] = 'app';
        ctx.timings.mark('csp', 'app');
        return withHeaders(response, headers);
      }

      let out = response;
      if (decision.mode === 'nonce' && decision.nonce && decision.inject) {
        out = injectNonce(out, decision.nonce, {
          styles: !decision.effective.unsafeInlineStyles,
          htmlRewriter: resolveRewriter(options),
        });
      }
      if (enforced) headers['content-security-policy'] = enforced;
      if (reportOnly) headers['content-security-policy-report-only'] = reportOnly;
      const mode = effectiveMode(decision);
      headers[HEADER.cspMode] = mode;
      ctx.state.set(CSP_MODE_KEY, mode);
      ctx.timings.mark('csp', mode);
      return withHeaders(out, headers);
    },
  });
}

function effectiveMode(decision: CspDecision): CspMode {
  if (decision.mode === 'off') return 'off';
  if (decision.reportOnly === true) return 'report-only';
  if (decision.mode === 'unsafe-inline') return 'unsafe-inline-fallback';
  return decision.mode;
}
