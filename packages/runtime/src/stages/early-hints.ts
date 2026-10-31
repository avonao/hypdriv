import {
  appendLinkHeader,
  defineStage,
  type HypContext,
  isHtmlLike,
  isRscRequest,
  type LinkEntry,
  parseLink,
  type ResolvedConfig,
  type Stage,
} from '@hypdriv/core';
import { hasModuleScripts, linkEntriesForRoute } from '../shared/hints';

/**
 * Emits `Link: rel=preload|preconnect` headers per route so Cloudflare can send 103 Early Hints on
 * subsequent requests (Early Hints must be enabled on the zone). Uses the manifest's precomputed
 * entries when available and falls back to the route's assets.
 */
export function earlyHintsStage(config: ResolvedConfig): Stage | null {
  const eh = config.performance.earlyHints;
  if (!eh) return null;
  const cache = new Map<string, LinkEntry[]>();

  const entriesFor = (ctx: HypContext): LinkEntry[] => {
    const route = ctx.route?.route;
    if (!route) return [];
    const hit = cache.get(route.id);
    if (hit) return hit;
    const precomputed = ctx.manifest.earlyHints[route.id];
    const entries = precomputed?.length
      ? precomputed.flatMap((v) => parseLink(v))
      : linkEntriesForRoute(route, eh, { moduleScripts: hasModuleScripts(ctx.manifest) });
    cache.set(route.id, entries);
    return entries;
  };

  return defineStage({
    name: 'early-hints',
    runOnRsc: true,
    post(ctx, response) {
      if (response.status !== 200) return response;
      const rsc = isRscRequest(ctx.request.headers);
      if (rsc && !eh.onRsc) return response;
      if (!rsc && !isHtmlLike(ctx, response)) return response;
      const entries = entriesFor(ctx);
      if (!entries.length) return response;
      const headers = new Headers(response.headers);
      appendLinkHeader(headers, entries, eh.maxLinks);
      ctx.timings.mark('hints', String(entries.length));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });
}
