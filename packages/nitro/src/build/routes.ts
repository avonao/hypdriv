import { type DiscoveredRoute, normalizePathname } from '@hypdriv/vite';

/** A Nitro route handler (Nitro 2: `nitro.scannedHandlers` + `nitro.options.handlers`; Nitro 3: `nitro.routing.routes.routes`). */
export interface NitroHandlerLike {
  route?: string;
  method?: string;
  middleware?: boolean;
  handler?: string;
  lazy?: boolean;
}

/** How Nitro renders requests no route matched (Nitro 3's `renderer`, Nitro 2's `renderer` handler path). */
export type NitroRendererLike =
  | string
  | { template?: string; handler?: string; static?: boolean }
  | false
  | undefined;

/**
 * Nitro (radix3 / rou3) route syntax → canonical: `/users/:id` → `/users/[id]`, `/files/**:path` →
 * `/files/[[...path]]`, `/proxy/**` → `/proxy/[[...path]]`, `/a/*` → `/a/[_]`.
 */
export function fromNitroRoute(route: string): string {
  const segments = route.split('/').filter((s) => s !== '');
  let unnamed = 0;
  const out = segments.map((seg) => {
    const catchAll = /^\*\*(?::([A-Za-z0-9_]+))?$/.exec(seg);
    if (catchAll) return `[[...${catchAll[1] ?? 'path'}]]`;
    if (seg === '*') return `[_${unnamed++ || ''}]`;
    const param = /^:([A-Za-z0-9_]+)$/.exec(seg);
    if (param) return `[${param[1]}]`;
    return seg;
  });
  return normalizePathname(out.join('/'));
}

/** Paths Nitro and the framework serve for their own machinery (build assets, error rendering, the dev tools). */
export function isInternalRoute(route: string, assetPrefixes: readonly string[] = []): boolean {
  if (route.startsWith('/_hypdriv') || route.startsWith('/__') || route.startsWith('/_nitro')) return true;
  return assetPrefixes.some((prefix) => {
    const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return route.startsWith(base) || route === base.slice(0, -1);
  });
}

function stripExtension(file: string): string {
  return file.replace(/\.(?:[cm]?[jt]s|tsx?|jsx?)$/, '');
}

/** Whether a handler answers the HTTP methods a page is navigated with (any method, GET or HEAD). */
function answersNavigation(method: string | undefined): boolean {
  const m = (method ?? '').toLowerCase();
  return m === '' || m === 'get' || m === 'head';
}

export interface ServerRoutesOptions {
  /** Handler files to leave out (the framework's renderer). */
  exclude?: Array<string | undefined>;
  /** Public prefixes of build assets. */
  assetPrefixes?: readonly string[];
  /** Whether a handler route renders HTML documents. Default: routes outside `/api/` that answer GET. */
  isPage?: (route: string, handler: NitroHandlerLike) => boolean;
}

function defaultIsPage(route: string, handler: NitroHandlerLike): boolean {
  if (!answersNavigation(handler.method)) return false;
  return !(route === '/api' || route.startsWith('/api/'));
}

/**
 * Nitro's route handlers (`routes/`, `api/`, module-registered handlers) as Hypdriv routes. API routes are
 * endpoints; GET routes elsewhere render documents and are pages. A `/**` handler is a catch-all page.
 */
export function serverRoutes(
  handlers: NitroHandlerLike[],
  options: ServerRoutesOptions = {},
): DiscoveredRoute[] {
  const excluded = new Set(
    (options.exclude ?? []).filter(Boolean).map((file) => stripExtension(file as string)),
  );
  const isPage = options.isPage ?? defaultIsPage;
  const seen = new Set<string>();
  const out: DiscoveredRoute[] = [];
  for (const handler of handlers) {
    if (handler.middleware || !handler.route) continue;
    if (handler.handler && excluded.has(stripExtension(handler.handler))) continue;
    if (isInternalRoute(handler.route, options.assetPrefixes)) continue;
    const pathname = fromNitroRoute(handler.route);
    const kind = isPage(handler.route, handler) ? 'page' : 'endpoint';
    const key = `${kind}:${pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pathname, kind, frameworkId: handler.route });
  }
  return out;
}

/**
 * The catch-all page of a renderer: a template (`index.html`) is a fallback document, a handler renders per request.
 * Nothing when the app has no renderer.
 */
export function rendererRoute(renderer: NitroRendererLike): DiscoveredRoute | null {
  if (!renderer) return null;
  const isTemplate = typeof renderer === 'object' && !!renderer.template && renderer.static !== false;
  return { pathname: '/[[...path]]', kind: 'page', ...(isTemplate ? { fallback: true } : {}) };
}

export interface DiscoverRoutesInput {
  /** Pages the framework knows (Analog's file router); they win over a handler with the same pattern. */
  pages?: DiscoveredRoute[];
  handlers: NitroHandlerLike[];
  renderer?: NitroRendererLike;
  assetPrefixes?: readonly string[];
  isPage?: ServerRoutesOptions['isPage'];
}

/** Every route of the app: the framework's pages, Nitro's handlers, then the renderer's catch-all. */
export function discoverNitroRoutes(input: DiscoverRoutesInput): DiscoveredRoute[] {
  const renderer = input.renderer;
  const rendererFiles = typeof renderer === 'string' ? [renderer] : [renderer ? renderer.handler : undefined];
  const pages = input.pages ?? [];
  const handlers = serverRoutes(input.handlers, {
    exclude: rendererFiles,
    ...(input.assetPrefixes ? { assetPrefixes: input.assetPrefixes } : {}),
    ...(input.isPage ? { isPage: input.isPage } : {}),
  });
  const out: DiscoveredRoute[] = [...pages];
  const taken = new Set(out.map((r) => r.pathname));
  for (const route of handlers) {
    // A handler never shadows a page of the same pattern; the page's own server data lives in the endpoint.
    if (route.kind === 'page' && taken.has(route.pathname)) continue;
    out.push(route);
    taken.add(route.pathname);
  }
  const catchAll = rendererRoute(renderer);
  // A `/**` handler is already the catch-all page; a framework with its own pages renders through the renderer.
  if (catchAll && !taken.has(catchAll.pathname) && !pages.length) out.push(catchAll);
  return out;
}
