import {
  emptyManifest,
  type HypManifest,
  type HypRoute,
  type ManifestFramework,
  routeId,
  routePatternToRegex,
} from '@hypdriv/core';

/** The label reported in logs and `/_hypdriv/health`. */
export const HOST_LABEL = 'rwsdk';

/** The HTTP verbs RedwoodSDK's method tables (`route('/api', { get, post })`) take. */
const METHOD_VERBS = ['delete', 'get', 'head', 'patch', 'post', 'put'] as const;

/**
 * Converts a RedwoodSDK route path to Hypdriv's canonical pattern syntax. RedwoodSDK stores paths with a trailing
 * slash (`/about/`) and matches `:name` against one segment and `*` against anything (`(.*)`, also across slashes):
 *
 * `/users/:id/` → `/users/[id]`, `/files/*` → `/files/[...splat]`; a wildcard before the last segment becomes
 * `[splat]`, and every further wildcard `[splat1]`, `[splat2]`… (a trailing one `[...splat1]`). Parameter names are
 * unique in a pattern (a wildcard never takes the name of a `:splat` parameter), so the compiled expression has no
 * duplicate capture group.
 */
export function rwsdkPattern(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const taken = new Set<string>();
  for (const segment of segments) {
    const name = /:([A-Za-z0-9_]+)/.exec(segment)?.[1];
    if (name) taken.add(name);
  }
  let wildcards = 0;
  const splatName = (): string => {
    for (;;) {
      const position = wildcards++;
      const name = `splat${position ? position : ''}`;
      if (!taken.has(name)) {
        taken.add(name);
        return name;
      }
    }
  };
  const converted = segments.map((segment, index) => {
    const name = /:([A-Za-z0-9_]+)/.exec(segment)?.[1];
    if (segment.includes('*') && !name) {
      const splat = splatName();
      return segment === '*' && index === segments.length - 1 ? `[...${splat}]` : `[${splat}]`;
    }
    return name ? `[${name}]` : segment;
  });
  return `/${converted.join('/')}`;
}

/**
 * Whether RedwoodSDK renders the handler as a page. Mirrors the router's own test (`isRouteComponent`): a client
 * reference, a handler RedwoodSDK already marked as a route component, or a function whose source calls the JSX
 * runtime. Anything else is called for its `Response`.
 */
function isComponent(handler: unknown): boolean {
  if (typeof handler !== 'function') return false;
  if (Object.hasOwn(handler, '$$isClientReference') || Object.hasOwn(handler, '__rwsdk_route_component'))
    return true;
  try {
    return Function.prototype.toString.call(handler).includes('jsx');
  } catch {
    return false;
  }
}

/** `page` when RedwoodSDK renders the route's final handler as a component, `endpoint` when it returns a `Response`. */
export function handlerKind(handler: unknown): 'page' | 'endpoint' {
  // `[middleware, …, final]`: the last entry decides.
  if (Array.isArray(handler)) return handlerKind(handler.at(-1));
  if (typeof handler === 'function') return isComponent(handler) ? 'page' : 'endpoint';
  if (handler && typeof handler === 'object') {
    // A method table is a page when its `get` renders (its other verbs are the page's actions).
    const get = (handler as Record<string, unknown>).get;
    return get !== undefined && handlerKind(get) === 'page' ? 'page' : 'endpoint';
  }
  return 'endpoint';
}

/** A route of the running app, as `defineApp([...])` registered it. */
export interface AppRoute {
  /** RedwoodSDK's path (`/users/:id/`). */
  path: string;
  kind: 'page' | 'endpoint';
  /** The verbs a method table answers (`['GET', 'POST']`), empty for a component or a single function. */
  methods: string[];
}

interface RouteDefinitionLike {
  path: string;
  handler: unknown;
}

const isRouteDefinition = (value: unknown): value is RouteDefinitionLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { path?: unknown }).path === 'string' &&
  'handler' in value;

/** The route table of an app built with `defineApp`: its `__rwRoutes` flattened to the routes that answer paths. */
export function appRoutes(app: { __rwRoutes?: unknown }): AppRoute[] {
  const out: AppRoute[] = [];
  const visit = (entry: unknown, depth: number): void => {
    if (depth > 64) return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    // Functions are middleware, `except()` handlers are error boundaries: neither answers a path by itself.
    if (!isRouteDefinition(entry)) return;
    const table =
      entry.handler && typeof entry.handler === 'object' && !Array.isArray(entry.handler)
        ? (entry.handler as Record<string, unknown>)
        : null;
    const methods = table
      ? [
          ...METHOD_VERBS.filter((verb) => table[verb] !== undefined).map((verb) => verb.toUpperCase()),
          ...Object.keys((table.custom as Record<string, unknown> | undefined) ?? {}).map((verb) =>
            verb.toUpperCase(),
          ),
        ]
      : [];
    out.push({ path: entry.path, kind: handlerKind(entry.handler), methods });
  };
  visit(app.__rwRoutes, 0);
  return out;
}

const isDynamic = (pathname: string): boolean => /\[[^\]]+\]/.test(pathname);

/** The manifest routes of an app's route table: pages render per request (`dynamic`), endpoints are `route`s. */
export function manifestRoutes(routes: readonly AppRoute[]): HypRoute[] {
  const seen = new Map<string, HypRoute>();
  for (const route of routes) {
    const pathname = rwsdkPattern(route.path);
    const id = routeId(route.kind, pathname);
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      pathname,
      regex: routePatternToRegex(pathname),
      kind: route.kind,
      classification: route.kind === 'page' ? 'dynamic' : 'route',
      runtime: 'nodejs',
      dynamic: isDynamic(pathname),
      assets: { js: [], css: [], fonts: [] },
    });
  }
  return [...seen.values()];
}

export interface AppManifestOptions {
  /** Reported in the manifest (`hypdriv manifest`). */
  version?: string;
  /** The deployment's build id. Default `runtime`: the manifest is derived from the running app. */
  buildId?: string;
}

/**
 * The route manifest of the running app: the pages and endpoints `defineApp` registered. With the build's manifest
 * (`virtual:hypdriv/manifest`) the routes are the app's own, and every route the build also found keeps what the
 * build learned about it (client assets for Early Hints and budgets, source file); the build id, CSP data and
 * warnings stay the build's. Without one, the manifest holds only the routes.
 */
export function appManifest(
  app: { __rwRoutes?: unknown },
  build: HypManifest | null,
  options: AppManifestOptions = {},
): HypManifest {
  const derived = manifestRoutes(appRoutes(app));
  if (!build) {
    const framework: ManifestFramework = { name: 'rwsdk', version: options.version ?? 'unknown' };
    return emptyManifest({ buildId: options.buildId ?? 'runtime', framework, routes: derived });
  }
  const known = new Map(build.routes.map((route) => [route.id, route]));
  const routes = derived.map((route) => {
    const built = known.get(route.id);
    return built
      ? {
          ...route,
          assets: built.assets,
          ...(built.sourcePage ? { sourcePage: built.sourcePage } : {}),
        }
      : route;
  });
  // A route table that cannot be read (an app without `__rwRoutes`) keeps the build's.
  return { ...build, routes: routes.length ? routes : build.routes };
}
