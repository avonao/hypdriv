import {
  cleanRoutePathname,
  type HypRoute,
  type HypRoutePrerender,
  type RouteClassification,
  routeId,
  routePatternToRegex,
} from '@hypdriv/core';
import type { AdapterOutputs, PrerenderOutput, SharedRouteFields } from './types';

export interface ClassifiedRoute {
  route: HypRoute;
  /** Primary prerender output (HTML) when one exists. */
  primaryPrerender: PrerenderOutput | null;
  /** Concrete prerendered paths for dynamic routes (`/blog/[slug]` → `/blog/first`). */
  concretePrerenders: PrerenderOutput[];
  output: SharedRouteFields;
}

function isRscVariant(pathname: string, suffix: string): boolean {
  return pathname.endsWith(suffix) || pathname.includes('.segments/');
}

function stripIndex(pathname: string): string {
  return pathname === '/index' ? '/' : pathname;
}

function isDynamicPattern(pathname: string): boolean {
  return /\[[^\]]+\]/.test(pathname);
}

function classifyPrerender(
  p: PrerenderOutput | null,
  concrete: PrerenderOutput[],
  dynamic: boolean,
): RouteClassification {
  if (p) {
    const revalidate = p.fallback?.initialRevalidate;
    // `renderingMode: 'PARTIALLY_STATIC'` is reported for every route when Cache Components / PPR is on,
    // so it says nothing about this prerender. A shell is a prerender with postponed (dynamic) holes.
    const hasShellBody =
      p.fallback?.filePath !== undefined &&
      (p.compute === 'resuming' || p.config.partialFallback === true || !!p.fallback?.postponedState);
    if (hasShellBody) return 'shell';
    if (p.compute === 'resuming') return 'shell';
    if (p.compute === 'static') return revalidate === false || revalidate === undefined ? 'static' : 'isr';
    if (p.compute === 'blocking') {
      // Dynamic route rendered on demand; concrete prerenders tell us whether it is ISR-like.
      if (dynamic && concrete.length) {
        const anyStatic = concrete.some((c) => c.compute === 'static');
        if (anyStatic)
          return concrete.some((c) => typeof c.fallback?.initialRevalidate === 'number') ? 'isr' : 'static';
      }
      return 'dynamic';
    }
  }
  if (dynamic && concrete.length) {
    const revalidating = concrete.some((c) => typeof c.fallback?.initialRevalidate === 'number');
    return revalidating ? 'isr' : 'static';
  }
  return 'dynamic';
}

function prerenderInfo(
  p: PrerenderOutput | null,
  concrete: PrerenderOutput[],
): HypRoutePrerender | undefined {
  if (!p && !concrete.length) return undefined;
  const source = p ?? concrete[0]!;
  const info: HypRoutePrerender = {};
  if (source.routeType) info.routeType = source.routeType;
  if (source.response) info.response = source.response;
  if (source.compute) info.compute = source.compute;
  const revalidate =
    source.fallback?.initialRevalidate ??
    concrete.find((c) => c.fallback?.initialRevalidate !== undefined)?.fallback?.initialRevalidate;
  if (revalidate !== undefined) info.revalidate = revalidate;
  const expire = source.fallback?.initialExpiration;
  if (expire !== undefined) info.expire = expire;
  if (source.htmlSize !== undefined) info.htmlSize = source.htmlSize;
  if (source.config.partialFallback) info.partialFallback = true;
  if (source.config.renderingMode) info.renderingMode = source.config.renderingMode;
  if (concrete.length) {
    info.paths = concrete.map((c) => c.pathname).slice(0, 200);
    info.pathCount = concrete.length;
  }
  return info;
}

/** Turns adapter outputs into HypDriv routes with classification and prerender metadata. */
export function classifyOutputs(outputs: AdapterOutputs, rscSuffix = '.rsc'): ClassifiedRoute[] {
  const prerendersById = new Map<string, PrerenderOutput>();
  const primaryByRoute = new Map<string, PrerenderOutput>();
  const concreteByRoute = new Map<string, PrerenderOutput[]>();
  for (const p of outputs.prerenders) {
    prerendersById.set(p.id, p);
    if (isRscVariant(p.pathname, rscSuffix)) continue;
    if (!p.routeType && !p.compute) continue; // sibling data outputs
    if (p.pathname === p.route || stripIndex(p.pathname) === p.route) {
      primaryByRoute.set(p.route, p);
    } else {
      const list = concreteByRoute.get(p.route) ?? [];
      list.push(p);
      concreteByRoute.set(p.route, list);
    }
  }

  const out: ClassifiedRoute[] = [];
  const seen = new Set<string>();

  const add = (output: SharedRouteFields, kind: HypRoute['kind']) => {
    if (isRscVariant(output.pathname, rscSuffix)) return;
    const pathname = stripIndex(output.pathname);
    const id = routeId(kind, pathname);
    if (seen.has(id)) return;
    seen.add(id);
    const dynamic = isDynamicPattern(pathname);
    const primary = primaryByRoute.get(pathname) ?? prerendersById.get(pathname) ?? null;
    const concrete = concreteByRoute.get(pathname) ?? [];
    const isRoute = kind === 'app-route' || kind === 'page-api';
    const classification: RouteClassification = isRoute
      ? 'route'
      : classifyPrerender(primary && !isRoute ? primary : null, concrete, dynamic);
    const route: HypRoute = {
      id,
      pathname,
      regex: routePatternToRegex(pathname),
      kind,
      classification,
      runtime: output.runtime,
      dynamic,
      assets: { js: [], css: [], fonts: [] },
      sourcePage: output.sourcePage,
    };
    const pre = isRoute ? undefined : prerenderInfo(primary, concrete);
    if (pre) route.prerender = pre;
    if (output.config.maxDuration !== undefined || output.config.preferredRegion !== undefined) {
      route.segment = {
        ...(output.config.maxDuration !== undefined ? { maxDuration: output.config.maxDuration } : {}),
        ...(output.config.preferredRegion !== undefined
          ? { preferredRegion: output.config.preferredRegion }
          : {}),
      };
    }
    out.push({ route, primaryPrerender: primary, concretePrerenders: concrete, output });
  };

  for (const o of outputs.appPages) add(o, 'app-page');
  for (const o of outputs.appRoutes) add(o, 'app-route');
  for (const o of outputs.pages) add(o, 'page');
  for (const o of outputs.pagesApi) add(o, 'page-api');

  // Deterministic order: static paths first (alphabetical), then dynamic by specificity.
  out.sort((a, b) => {
    if (a.route.dynamic !== b.route.dynamic) return a.route.dynamic ? 1 : -1;
    return cleanRoutePathname(a.route.pathname).localeCompare(cleanRoutePathname(b.route.pathname));
  });
  return out;
}

/** Public (non-`_next`) static files become asset routes; `_next/static` is summarised. */
export function staticFileRoutes(outputs: AdapterOutputs): {
  routes: HypRoute[];
  count: number;
  immutablePrefixes: string[];
} {
  const routes: HypRoute[] = [];
  const prefixes = new Set<string>();
  let count = 0;
  for (const f of outputs.staticFiles) {
    count++;
    if (f.pathname.includes('/_next/static/')) {
      const m = /^(.*\/_next\/static\/)/.exec(f.pathname);
      if (m) prefixes.add(m[1]!);
      continue;
    }
    if (f.pathname === '/404' || f.pathname === '/500') continue;
    routes.push({
      id: routeId('static-file', f.pathname),
      pathname: f.pathname,
      regex: routePatternToRegex(f.pathname),
      kind: 'static-file',
      classification: 'asset',
      runtime: 'nodejs',
      dynamic: false,
      assets: { js: [], css: [], fonts: [] },
    });
  }
  if (!prefixes.size) prefixes.add('/_next/static/');
  return { routes, count, immutablePrefixes: [...prefixes] };
}
