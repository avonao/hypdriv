import {
  defineStage,
  type HypContext,
  isHtmlLike,
  isRscRequest,
  type ResolvedConfig,
  type Stage,
  stateKey,
} from '@hypdriv/core';
import { CSP_EXTRA_HASHES_KEY } from '@hypdriv/security';
import {
  buildSpeculationRules,
  type SpeculationRules,
  speculationScript,
  speculationScriptHash,
} from '../shared/speculation';

export const SPECULATION_KEY = stateKey<{
  rules: SpeculationRules;
  script: string;
  hash: string;
  injected: boolean;
}>('next.speculation');

interface HtmlRewriterLike {
  on(
    selector: string,
    handlers: {
      element(el: { append(content: string, options?: { html?: boolean }): void; remove(): void }): void;
    },
  ): HtmlRewriterLike;
  transform(response: Response): Response;
}

/**
 * Prepares per-route Speculation Rules. On the edge (HTMLRewriter available) the route's link-graph rules
 * are injected into `<head>` and replace the `<Speculation/>` component's document rules; elsewhere the
 * component's rules stand.
 */
export function speculationStage(config: ResolvedConfig): Stage | null {
  const spec = config.performance.speculation;
  if (!spec || spec.inject === 'off') return null;
  const cache = new Map<string, { rules: SpeculationRules; script: string; hash: string } | null>();

  const prepare = async (ctx: HypContext) => {
    const key = ctx.route?.route.pathname ?? ctx.url.pathname;
    if (cache.has(key)) return cache.get(key)!;
    const rules = buildSpeculationRules({ manifest: ctx.manifest, config: spec, pathname: key });
    const prepared = rules
      ? { rules, script: speculationScript(rules), hash: await speculationScriptHash(rules) }
      : null;
    cache.set(key, prepared);
    return prepared;
  };

  return defineStage({
    name: 'speculation',
    runOnRsc: false,
    async pre(ctx) {
      if (ctx.request.method !== 'GET' || isRscRequest(ctx.request.headers)) return;
      if (ctx.route && ctx.route.route.kind !== 'app-page' && ctx.route.route.kind !== 'page') return;
      const prepared = await prepare(ctx);
      if (!prepared) return;
      const willInject =
        spec.inject !== 'component' &&
        typeof (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter === 'function';
      ctx.state.set(SPECULATION_KEY, { ...prepared, injected: willInject });
      if (willInject) {
        const extra = ctx.state.get(CSP_EXTRA_HASHES_KEY) ?? [];
        ctx.state.set(CSP_EXTRA_HASHES_KEY, [...extra, prepared.hash]);
      }
      ctx.requestHeaders.set('x-hypdriv-speculation', willInject ? 'edge' : 'component');
    },
    post(ctx, response) {
      const state = ctx.state.get(SPECULATION_KEY);
      if (!state?.injected || response.status !== 200 || !isHtmlLike(ctx, response)) return response;
      const Rewriter = (globalThis as { HTMLRewriter?: new () => HtmlRewriterLike }).HTMLRewriter;
      if (!Rewriter) return response;
      ctx.timings.mark('speculation', 'edge');
      return (
        new Rewriter()
          // The <Speculation/> component's route-independent rules are superseded by the graph-aware ones.
          .on('script[type="speculationrules"][data-hypdriv="speculation"]', {
            element(el) {
              el.remove();
            },
          })
          .on('head', {
            element(el) {
              el.append(
                `<script type="speculationrules" data-hypdriv="speculation-edge">${state.script}</script>`,
                { html: true },
              );
            },
          })
          .transform(response)
      );
    },
  });
}
