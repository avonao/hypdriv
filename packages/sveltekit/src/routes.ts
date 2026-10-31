import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { RouteAssetSources } from '@hypdriv/build';
import { type DiscoveredRoute, fromSvelteKitId, normalizePathname } from '@hypdriv/vite';

/** The parts of SvelteKit's `RouteDefinition` (`builder.routes`) the integration reads. */
export interface SvelteKitRouteLike {
  id: string;
  pattern: RegExp;
  prerender: boolean | 'auto';
  page: { methods: string[] };
  api: { methods: string[] };
  config?: unknown;
}

/** A SvelteKit route id converted to Hypdriv's canonical pattern syntax. */
export interface SvelteKitPattern {
  pathname: string;
  /**
   * False when a segment mixes parameters with literal text (`[slug]-[id]`, `[name].json`, `v[major]`): the
   * canonical syntax has whole-segment parameters only, so such a route matches with SvelteKit's own regex.
   */
  exact: boolean;
}

/** `[x+2f]` / `[u+0041]` escape sequences of route ids, decoded the way SvelteKit decodes them. */
function decodeEscapes(segment: string): string {
  return segment.replace(/\[([ux])\+([^\]]+)\]/g, (_, _kind: string, code: string) =>
    String.fromCodePoint(...code.split('-').map((c) => Number.parseInt(c, 16))),
  );
}

/**
 * Converts a SvelteKit route id: `(group)` segments removed, matchers dropped (`[id=integer]` → `[id]`), escape
 * sequences decoded, `[[optional]]` and `[...rest]` kept. A segment that mixes parameters and text becomes one
 * parameter named after its parameters (`[slug]-[id]` → `[slug_id]`) and is reported as not exact.
 */
export function svelteKitPattern(id: string): SvelteKitPattern {
  let exact = true;
  const segments = id
    .split('/')
    .filter((s) => s !== '' && !/^\(.+\)$/.test(s))
    .map((segment) => {
      const withoutMatchers = segment.replace(/\[(\[?)(\.\.\.)?([\w-]+)=[\w-]+\](\]?)/g, '[$1$2$3$4]');
      // Whole-segment parameters: `[x]`, `[[x]]`, `[...x]`.
      if (/^\[\[?(?:\.\.\.)?[\w-]+\]\]?$/.test(withoutMatchers) && !/^\[[ux]\+/.test(withoutMatchers))
        return withoutMatchers;
      const names = [...withoutMatchers.matchAll(/\[\[?(?:\.\.\.)?([\w-]+)\]\]?/g)]
        .map((m) => m[1]!)
        .filter((name) => !/^[ux]\+/.test(name));
      const literal = decodeEscapes(withoutMatchers);
      if (!names.length) return encodeLiteral(literal);
      exact = false;
      const rest = /\[\.\.\./.test(withoutMatchers);
      const name = names.join('_').replace(/[^\w]/g, '_');
      return rest ? `[...${name}]` : `[${name}]`;
    });
  return { pathname: fromSvelteKitId(`/${segments.join('/')}`), exact };
}

/**
 * Literal text is matched against the request's (encoded) pathname: characters the URL parser percent-encodes in a
 * path (non-ASCII, spaces, quotes, `<>{}` and backticks) and the escaped `/ ? #` are encoded the same way.
 */
function encodeLiteral(segment: string): string {
  return segment.replace(/[^\x21-\x7e]|["<>`{}?#/]/gu, (c) => encodeURIComponent(c));
}

/** `isr.expiration` of adapter-vercel's route config (seconds), when the route regenerates on Vercel. */
function isrExpiration(config: unknown): number | false | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const isr = (config as { isr?: unknown }).isr;
  if (!isr || typeof isr !== 'object') return undefined;
  const expiration = (isr as { expiration?: unknown }).expiration;
  if (expiration === false) return false;
  const seconds = typeof expiration === 'string' ? Number(expiration) : expiration;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** The source file of a route (`src/routes/blog/[slug]/+page.svelte`), relative to the project root. */
function sourceFileFor(
  root: string,
  routesDir: string,
  id: string,
  kind: 'page' | 'endpoint',
): string | null {
  const dir = join(resolve(root, routesDir), ...id.split('/').filter(Boolean));
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const match =
    kind === 'page'
      ? (entries.find((f) => /^\+page(@[^.]*)?\.svelte$/.test(f)) ??
        entries.find((f) => /^\+page(\.server)?\.[cm]?[jt]s$/.test(f)))
      : entries.find((f) => /^\+server\.[cm]?[jt]s$/.test(f));
  return match ? relative(root, join(dir, match)).split(sep).join('/') : null;
}

export interface RoutesFromBuilderInput {
  routes: readonly SvelteKitRouteLike[];
  /** Project root and SvelteKit's routes directory (`files.routes`), for source files. */
  root?: string;
  routesDir?: string;
  /** Client assets per route id (`routeAssets()`). */
  assets?: Map<string, RouteAssetSources>;
  /** Pathnames of prerendered `+server` responses (`builder.prerendered.assets`). */
  prerenderedEndpoints?: Iterable<string>;
}

/**
 * Converts `builder.routes` into Hypdriv routes. A route with a page is a `page` (a `+server` next to it answers
 * non-HTML requests of the same URL); one with only `+server` is an `endpoint`. `prerender = true` routes are
 * prerendered; `'auto'` routes are classified by the documents the build produced. adapter-vercel's
 * `config.isr` marks a route as regenerated in the background (`isr`).
 */
export function routesFromBuilder(input: RoutesFromBuilderInput): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  const prerenderedEndpoints = new Set([...(input.prerenderedEndpoints ?? [])].map(normalizePathname));
  for (const route of input.routes) {
    const kind = route.page.methods.length ? 'page' : route.api.methods.length ? 'endpoint' : null;
    if (!kind) continue;
    const { pathname, exact } = svelteKitPattern(route.id);
    const expiration = kind === 'page' ? isrExpiration(route.config) : undefined;
    const prerendered =
      route.prerender === true || (kind === 'endpoint' && prerenderedEndpoints.has(pathname))
        ? true
        : expiration !== undefined && expiration !== false
          ? true
          : undefined;
    const sourcePage =
      input.root && input.routesDir ? sourceFileFor(input.root, input.routesDir, route.id, kind) : null;
    const sources = input.assets?.get(route.id);
    out.push({
      pathname,
      kind,
      ...(prerendered ? { prerendered } : {}),
      ...(expiration !== undefined && route.prerender !== true ? { revalidate: expiration } : {}),
      ...(exact ? {} : { regex: route.pattern.source }),
      ...(sourcePage ? { sourcePage } : {}),
      ...(sources && kind === 'page' ? { sources } : {}),
      frameworkId: route.id,
    });
  }
  return out;
}

const PAGE_FILE = /^\+page(@[^.]*)?\.[^.]+$/;
const SERVER_FILE = /^\+server\.[cm]?[jt]s$/;
const IGNORED = /\.(?:test|spec|stories)\./;

/**
 * Discovers routes from `src/routes` before a build exists (development, the server build): directories with a
 * `+page.*` file are pages, directories with only `+server.*` are endpoints. Prerendering is decided by the build.
 */
export function discoverRoutes(root: string, routesDir = 'src/routes'): DiscoveredRoute[] {
  const base = resolve(root, routesDir);
  if (!existsSync(base)) return [];
  const out: DiscoveredRoute[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    const files = entries.filter((name) => {
      try {
        return statSync(join(dir, name)).isFile() && !IGNORED.test(name);
      } catch {
        return false;
      }
    });
    const page = files.some((f) => PAGE_FILE.test(f));
    const endpoint = files.some((f) => SERVER_FILE.test(f));
    if (page || endpoint) {
      const rel = relative(base, dir).split(sep).join('/');
      const id = `/${rel}`.replace(/\/$/, '') || '/';
      const { pathname, exact } = svelteKitPattern(id);
      out.push({
        pathname,
        kind: page ? 'page' : 'endpoint',
        frameworkId: id,
        ...(exact ? {} : { regex: approximateRegex(id) }),
      });
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) walk(full);
      } catch {
        // unreadable entry
      }
    }
  };
  walk(base);
  return out;
}

/**
 * The regex SvelteKit builds for a route id (`parse_route_id`), for routes whose segments mix parameters and text.
 * Used in development, before `builder.routes` provides the real pattern.
 */
export function approximateRegex(id: string): string {
  const segments = id.split('/').filter((s) => s !== '' && !/^\(.+\)$/.test(s));
  if (!segments.length) return '^\\/$';
  const body = segments
    .map((segment) => {
      if (/^\[\.\.\.[\w-]+(?:=[\w-]+)?\]$/.test(segment)) return '(?:\\/([^]*))?';
      if (/^\[\[[\w-]+(?:=[\w-]+)?\]\]$/.test(segment)) return '(?:\\/([^/]+))?';
      const parts = segment.split(/\[(.+?)\](?!\])/);
      const source = parts
        .map((content, i) => {
          if (i % 2 === 0) return escapeRegex(content);
          if (content.startsWith('x+') || content.startsWith('u+'))
            return escapeRegex(decodeEscapes(`[${content}]`));
          const m = /^(\[)?(\.\.\.)?[\w-]+(?:=[\w-]+)?(\])?$/.exec(content);
          if (!m) return escapeRegex(content);
          return m[2] ? '([^]*?)' : m[1] ? '([^/]*)?' : '([^/]+?)';
        })
        .join('');
      return `\\/${source}`;
    })
    .join('');
  return `^${body}\\/?$`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
