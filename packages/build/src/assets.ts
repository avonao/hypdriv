import { extractAssets } from './html';

/** Client assets of a route: what preload hints, budgets and weights are computed from. */
export interface RouteAssetSources {
  js: string[];
  css: string[];
  fonts: string[];
  /** Entry chunks that bootstrap the route (preload candidates). */
  main: string[];
}

/** Asset identity without Next's `?dpl=<deploymentId>` skew-protection query (and the hash fragment). */
function assetIdentity(href: string): string {
  const [path, query] = href.split('#')[0]!.split('?');
  if (!query) return path!;
  const kept = query.split('&').filter((pair) => !pair.startsWith('dpl='));
  return kept.length ? `${path}?${kept.join('&')}` : path!;
}

/** De-duplicates assets that differ only by `?dpl=`; the first spelling wins (HTML spellings come first). */
function uniqAssets(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const href of list) {
    const id = assetIdentity(href);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(href);
  }
  return out;
}

/** Merges manifest-derived assets with what the prerendered HTML actually references (HTML wins for order). */
export function mergeWithHtml(sources: RouteAssetSources, html: string | null): RouteAssetSources {
  if (!html) return sources;
  const fromHtml = extractAssets(html);
  const js = uniqAssets([
    ...fromHtml.scripts,
    ...fromHtml.modulePreloads,
    ...fromHtml.preloads.filter((p) => p.as === 'script').map((p) => p.href),
    ...sources.js,
  ]);
  const css = uniqAssets([
    ...fromHtml.stylesheets,
    ...fromHtml.preloads.filter((p) => p.as === 'style').map((p) => p.href),
    ...sources.css,
  ]);
  const fonts = uniqAssets([...fromHtml.fonts.map((f) => f.href), ...sources.fonts]);
  // Preloads must use the exact URL the document requests (including `?dpl=`), or the browser fetches twice.
  const spelling = new Map(js.map((href) => [assetIdentity(href), href]));
  const main = sources.main.length
    ? uniqAssets(sources.main.map((href) => spelling.get(assetIdentity(href)) ?? href))
    : js.slice(0, 4);
  return { js, css, fonts, main };
}
