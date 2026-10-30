import {
  createContext,
  emptyManifest,
  type GeoProperties,
  type HypContext,
  type HypDrivConfig,
  type HypManifest,
  type HypRoute,
  type ResolvedConfig,
  type RouteMatch,
  resolveConfig,
  routePatternToRegex,
  type Stage,
} from '@hypdriv/core';

export function route(partial: Partial<HypRoute> & Pick<HypRoute, 'pathname'>): HypRoute {
  const kind = partial.kind ?? 'app-page';
  return {
    id: `${kind}:${partial.pathname}`,
    regex: routePatternToRegex(partial.pathname),
    kind,
    classification: 'dynamic',
    runtime: 'nodejs',
    dynamic: /\[/.test(partial.pathname),
    assets: { js: [], css: [], fonts: [] },
    ...partial,
  };
}

export interface MakeCtxOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  config?: ResolvedConfig | HypDrivConfig;
  route?: HypRoute | RouteMatch | null;
  manifest?: Partial<HypManifest>;
  cf?: GeoProperties;
  ip?: string;
  development?: boolean;
  env?: Record<string, unknown>;
  host?: boolean;
}

export function makeCtx(options: MakeCtxOptions = {}): HypContext {
  const url = options.url ?? 'https://app.test/';
  const headers = new Headers(options.headers ?? {});
  if (options.host !== false && !headers.has('host')) headers.set('host', new URL(url).host);
  const request = new Request(url, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined && options.body !== null ? { body: options.body } : {}),
  });
  const config =
    options.config && 'stages' in options.config && 'cloudflare' in options.config
      ? (options.config as ResolvedConfig)
      : resolveConfig((options.config as HypDrivConfig | undefined) ?? {});
  const routeMatch: RouteMatch | null =
    options.route === undefined || options.route === null
      ? null
      : 'route' in options.route
        ? options.route
        : { route: options.route, params: {} };
  return createContext({
    request,
    config,
    manifest: emptyManifest(options.manifest ?? {}),
    cf: options.cf,
    ip: options.ip ?? '203.0.113.7',
    development: options.development ?? false,
    env: options.env ?? {},
    route: routeMatch,
    runner: 'test',
  });
}

/** Runs one stage: pre, then (unless short-circuited) `next`, then post. */
export async function runStage(
  stage: Stage,
  ctx: HypContext,
  next: (request: Request) => Promise<Response> | Response = () =>
    new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
): Promise<{ response: Response; shortCircuited: boolean; forwarded: Request | null }> {
  let response = await stage.pre?.(ctx);
  let shortCircuited = false;
  let forwarded: Request | null = null;
  if (response instanceof Response) shortCircuited = true;
  else {
    forwarded = new Request(ctx.request, { headers: ctx.requestHeaders });
    response = await next(forwarded);
  }
  if (stage.post) response = await stage.post(ctx, response);
  return { response, shortCircuited, forwarded };
}

/** Deterministic clock for rate-limit tests. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
      return t;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

/** Minimal in-memory `CacheLike` for the Cache API counter store. */
export function fakeCache() {
  const map = new Map<string, { body: string; headers: Headers; expiresAt: number }>();
  const key = (input: RequestInfo | URL) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return {
    map,
    async match(input: RequestInfo | URL) {
      const hit = map.get(key(input));
      if (!hit) return undefined;
      if (hit.expiresAt <= Date.now()) {
        map.delete(key(input));
        return undefined;
      }
      return new Response(hit.body, { headers: hit.headers });
    },
    async put(input: RequestInfo | URL, response: Response) {
      const cc = response.headers.get('cache-control') ?? '';
      const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? '60');
      map.set(key(input), {
        body: await response.text(),
        headers: new Headers(response.headers),
        expiresAt: Date.now() + maxAge * 1000,
      });
    },
    async delete(input: RequestInfo | URL) {
      return map.delete(key(input));
    },
  };
}

/** Minimal in-memory KV namespace. */
export function fakeKv() {
  const map = new Map<string, { value: string; expiresAt: number | null }>();
  const get = async (k: string) => {
    const hit = map.get(k);
    if (!hit) return null;
    if (hit.expiresAt !== null && hit.expiresAt <= Date.now()) {
      map.delete(k);
      return null;
    }
    return hit.value;
  };
  return {
    map,
    get: (async (k: string, opts?: unknown) => {
      const v = await get(k);
      if (
        v !== null &&
        (opts === 'json' || (typeof opts === 'object' && opts && (opts as { type?: string }).type === 'json'))
      )
        return JSON.parse(v);
      return v;
    }) as never,
    async put(
      k: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      opts?: { expirationTtl?: number; expiration?: number },
    ) {
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value as ArrayBuffer);
      map.set(k, {
        value: text,
        expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null,
      });
    },
    async delete(k: string) {
      map.delete(k);
    },
  };
}
