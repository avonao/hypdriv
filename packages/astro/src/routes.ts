import type { RouteAssetSources } from '@hypdriv/build';
import { type DiscoveredRoute, normalizePathname } from '@hypdriv/vite';

/** One part of an Astro route segment (`[slug]`, `.json`, `[...rest]`). */
export interface AstroRoutePart {
  content: string;
  dynamic: boolean;
  spread: boolean;
}

/** The fields of Astro's `IntegrationResolvedRoute` Hypdriv reads (structural, so tests need no Astro build). */
export interface AstroRouteLike {
  /** Astro's route pattern: `/blog/[slug]`, `/docs/[...path]`, `/[lang]-[version]/info`. */
  pattern: string;
  /** `page`, `endpoint`, `redirect` (config redirects) or `fallback` (i18n fallback). */
  type: 'page' | 'endpoint' | 'redirect' | 'fallback';
  /** `project` (src/pages), `internal` (server islands, actions, image endpoint) or `external` (injected). */
  origin: 'internal' | 'project' | 'external';
  isPrerendered: boolean;
  /** The route's source module (`src/pages/blog/[slug].astro`). */
  entrypoint?: string;
  segments: AstroRoutePart[][];
}

/** Routes the integration never puts into the manifest: its own `/_hypdriv/*` endpoint. */
export function isHypDrivRoute(route: Pick<AstroRouteLike, 'pattern'>, internalPrefix: string): boolean {
  const prefix = normalizePathname(internalPrefix);
  return route.pattern === prefix || route.pattern.startsWith(`${prefix}/`);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function groupName(name: string, used: Set<string>): string {
  let base = name.replace(/^\.\.\./, '').replace(/[^A-Za-z0-9_]/g, '_') || 'param';
  if (/^[0-9]/.test(base)) base = `p_${base}`;
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}_${n++}`;
  used.add(candidate);
  return candidate;
}

/**
 * Converts an Astro route into Hypdriv's canonical pattern and an exact matcher. Astro already uses `[param]`;
 * its rest parameters match zero or more segments, so a segment that is only `[...rest]` becomes Hypdriv's
 * optional catch-all `[[...rest]]`. Segments that mix text and parameters (`[slug].json`, `[lang]-[version]`)
 * keep their spelling in the pattern and match through a regex built from Astro's segment parts, with named
 * groups so the runtime sees the parameters.
 */
export function astroPattern(route: Pick<AstroRouteLike, 'segments'>): { pathname: string; regex: string } {
  const used = new Set<string>();
  const display: string[] = [];
  let source = '';
  for (const segment of route.segments) {
    if (segment.length === 1 && segment[0]!.dynamic && segment[0]!.spread) {
      const name = segment[0]!.content.replace(/^\.\.\./, '');
      display.push(`[[...${name}]]`);
      source += `(?:/(?<${groupName(name, used)}>.*?))?`;
      continue;
    }
    let text = '';
    let part = '';
    for (const p of segment) {
      if (!p.dynamic) {
        text += p.content;
        part += escapeRegex(p.content);
        continue;
      }
      const name = p.content.replace(/^\.\.\./, '');
      text += p.spread ? `[...${name}]` : `[${name}]`;
      part += p.spread ? `(?<${groupName(name, used)}>.*?)` : `(?<${groupName(name, used)}>[^/]+?)`;
    }
    display.push(text);
    source += `/${part}`;
  }
  const pathname = normalizePathname(display.join('/'));
  return { pathname, regex: `^${source || '/'}(?:/)?$` };
}

/** Whether a canonical pattern needs Astro's exact matcher (a segment mixing text and parameters). */
function hasMixedSegments(route: Pick<AstroRouteLike, 'segments'>): boolean {
  return route.segments.some((segment) => segment.length > 1 && segment.some((p) => p.dynamic));
}

/**
 * Converts the routes of `astro:routes:resolved` into Hypdriv routes. Config redirects are left out (Astro answers
 * them before any middleware runs); Astro's internal routes (server islands, actions, the image endpoint) are kept
 * as endpoints so the runtime recognises them.
 */
export function fromAstroRoutes(
  routes: AstroRouteLike[],
  options: { internalPrefix?: string; sources?: Map<string, RouteAssetSources> } = {},
): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (route.type === 'redirect') continue;
    if (options.internalPrefix && isHypDrivRoute(route, options.internalPrefix)) continue;
    const { pathname, regex } = astroPattern(route);
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    const kind: DiscoveredRoute['kind'] =
      route.type === 'endpoint' || route.origin === 'internal' ? 'endpoint' : 'page';
    const sources = options.sources?.get(route.pattern);
    out.push({
      pathname,
      kind,
      prerendered: route.isPrerendered,
      ...(hasMixedSegments(route) ? { regex } : {}),
      ...(route.entrypoint && route.origin === 'project' ? { sourcePage: route.entrypoint } : {}),
      ...(sources && kind === 'page' ? { sources } : {}),
      frameworkId: route.pattern,
    });
  }
  return out;
}

/** The `routes[]` entries of Astro's serialized SSR manifest Hypdriv reads (`astro:build:ssr`). */
export interface AstroManifestRouteLike {
  routeData?: { route?: string; type?: string; prerender?: boolean };
  scripts?: Array<{ type?: string; value?: string; stage?: string; children?: string }>;
  styles?: Array<{ type?: string; src?: string; content?: string }>;
  links?: string[];
}

const FONT = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;

/**
 * Client assets of each route from Astro's SSR manifest (`astro:build:ssr`): external stylesheets and module
 * scripts, keyed by route pattern. On-demand pages get their Early Hints and preload candidates from these;
 * prerendered pages get theirs from the HTML.
 */
export function sourcesFromSsrManifest(
  routes: AstroManifestRouteLike[] | undefined,
  base = '/',
): Map<string, RouteAssetSources> {
  const out = new Map<string, RouteAssetSources>();
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const absolute = (href: string) =>
    /^(?:[a-z]+:)?\/\//i.test(href) || href.startsWith('/') ? href : `${prefix}${href.replace(/^\.?\//, '')}`;
  for (const entry of routes ?? []) {
    const pattern = entry.routeData?.route;
    if (!pattern || entry.routeData?.type !== 'page') continue;
    const css: string[] = [];
    const js: string[] = [];
    const fonts: string[] = [];
    for (const style of entry.styles ?? []) {
      if (style.type === 'external' && style.src) css.push(absolute(style.src));
    }
    for (const script of entry.scripts ?? []) {
      if (script.type === 'external' && script.value) js.push(absolute(script.value));
    }
    for (const link of entry.links ?? []) {
      if (FONT.test(link)) fonts.push(absolute(link));
      else if (/\.css(?:[?#]|$)/i.test(link)) css.push(absolute(link));
    }
    if (!css.length && !js.length && !fonts.length) continue;
    out.set(pattern, {
      css: [...new Set(css)],
      js: [...new Set(js)],
      fonts: [...new Set(fonts)],
      main: [...new Set(js)],
    });
  }
  return out;
}
