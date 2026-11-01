import { emptyManifest, type HypManifest, type HypRoute, routeId, routePatternToRegex } from '@hypdriv/core';

/** The part of a Hono app (or router) the manifest reads: its registered routes. */
export interface HonoRoutesSource {
  readonly routes: ReadonlyArray<{ readonly method: string; readonly path: string }>;
}

/**
 * Converts a Hono path to Hypdriv's canonical pattern syntax, or `null` for a route registered as middleware
 * (`app.use('*')`, `app.use('/api/*')`: method `ALL` ending in a wildcard), which answers nothing by itself.
 *
 * `/users/:id` → `/users/[id]`, `/posts/:id{[0-9]+}` → `/posts/[id]`, `/:lang?/about` → `/[[lang]]/about`,
 * `/files/*` → `/files/[...splat]`.
 */
export function honoPattern(method: string, path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  const last = segments.at(-1);
  if (method.toUpperCase() === 'ALL' && (segments.length === 0 ? path === '*' : last === '*')) return null;
  if (path === '*' || path === '/*') return method.toUpperCase() === 'ALL' ? null : '/[...splat]';
  let wildcard = 0;
  const converted = segments.map((segment, index) => {
    if (segment === '*') return index === segments.length - 1 ? '[...splat]' : `[splat${wildcard++ || ''}]`;
    const param = /^:([A-Za-z0-9_]+)(\{.*\})?(\?)?$/.exec(segment);
    if (param) return param[3] ? `[[${param[1]}]]` : `[${param[1]}]`;
    return segment;
  });
  return `/${converted.join('/')}`;
}

export interface HonoManifestOptions {
  /** Reported in the manifest (`hypdriv manifest`). */
  version?: string;
  /** The deployment's build id. Default `runtime`: the manifest is derived from the running app. */
  buildId?: string;
}

/**
 * The route manifest of a Hono app, derived from the routes it has registered. Hono renders everything per
 * request, so every route is a dynamic endpoint: the manifest gives route ids to rate limits, cache policies,
 * flags and logs (`match: '/api/**'` works without it) and lets `hypdriv routes` list the app. Evaluated when the
 * handler first runs, after the app registered its routes.
 */
export function honoManifest(source: HonoRoutesSource, options: HonoManifestOptions = {}): HypManifest {
  const seen = new Map<string, HypRoute>();
  for (const route of source.routes) {
    const pathname = honoPattern(route.method, route.path);
    if (pathname === null || seen.has(pathname)) continue;
    seen.set(pathname, {
      id: routeId('endpoint', pathname),
      pathname,
      regex: routePatternToRegex(pathname),
      kind: 'endpoint',
      classification: 'route',
      runtime: 'nodejs',
      dynamic: /\[[^\]]+\]/.test(pathname),
      assets: { js: [], css: [], fonts: [] },
    });
  }
  return emptyManifest({
    buildId: options.buildId ?? 'runtime',
    framework: { name: 'hono', version: options.version ?? 'unknown' },
    routes: [...seen.values()],
  });
}
