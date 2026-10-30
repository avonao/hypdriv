import type { HypRoute, LinkEntry, ResolvedPerformance } from '@hypdriv/core';
import { serializeLink } from '@hypdriv/core';

export interface HintOptions {
  /** Entry chunks that bootstrap the route; defaults to the first four scripts. */
  main?: string[];
  /** Already-present preconnect hosts (avoid duplicates). */
  existingPreconnects?: string[];
}

/** Computes the Early Hints `Link` entries for a route from its assets and the configured policy. */
export function linkEntriesForRoute(
  route: Pick<HypRoute, 'assets'>,
  config: NonNullable<ResolvedPerformance['earlyHints']>,
  options: HintOptions = {},
): LinkEntry[] {
  const entries: LinkEntry[] = [];
  const seen = new Set<string>();
  const add = (e: LinkEntry) => {
    const key = `${e.rel}|${e.href}`;
    if (seen.has(key) || entries.length >= config.maxLinks) return;
    seen.add(key);
    entries.push(e);
  };
  for (const origin of config.preconnect) {
    if (options.existingPreconnects?.includes(origin)) continue;
    add({ href: origin, rel: 'preconnect', crossorigin: 'anonymous' });
  }
  if (config.styles) for (const css of route.assets.css) add({ href: css, rel: 'preload', as: 'style' });
  if (config.fonts) for (const font of route.assets.fonts) add({ href: font, rel: 'preload', as: 'font', crossorigin: 'anonymous', ...(fontType(font) ? { type: fontType(font) } : {}) });
  if (config.scripts) {
    const scripts = config.scripts === 'main' ? (options.main?.length ? options.main : route.assets.js.slice(0, 4)) : route.assets.js;
    for (const js of scripts) add({ href: js, rel: 'preload', as: 'script' });
  }
  return entries;
}

function fontType(href: string): string | undefined {
  if (href.endsWith('.woff2')) return 'font/woff2';
  if (href.endsWith('.woff')) return 'font/woff';
  if (href.endsWith('.ttf')) return 'font/ttf';
  if (href.endsWith('.otf')) return 'font/otf';
  return undefined;
}

/** Serialised header values (one per entry) as stored in `manifest.earlyHints`. */
export function linkHeaderValues(entries: LinkEntry[]): string[] {
  return entries.map((e) => serializeLink([e]));
}
