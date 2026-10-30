import {
  type CacheLike,
  type CreateContextOptions,
  createContext,
  createRouteMatcher,
  emptyManifest,
  type HypDrivConfig,
  type HypManifest,
  type HypRoute,
  type KVNamespaceLike,
  type ResolvedConfig,
  resolveConfig,
  routePatternToRegex,
} from '@hypdriv/core';

/** In-memory KV namespace with expiration and metadata, enough for the store and tag index. */
export function fakeKv(now: () => number = () => Date.now()) {
  const data = new Map<string, { value: ArrayBuffer; metadata?: unknown; expiration?: number }>();
  const puts: Array<{ key: string; options?: Record<string, unknown> }> = [];
  const toBuffer = (v: string | ArrayBuffer | ArrayBufferView | ReadableStream): ArrayBuffer => {
    if (typeof v === 'string') return new TextEncoder().encode(v).buffer as ArrayBuffer;
    if (v instanceof ArrayBuffer) return v.slice(0);
    if (ArrayBuffer.isView(v))
      return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
    throw new Error('streams not supported by fakeKv');
  };
  const live = (key: string) => {
    const e = data.get(key);
    if (!e) return null;
    if (e.expiration !== undefined && e.expiration * 1000 <= now()) {
      data.delete(key);
      return null;
    }
    return e;
  };
  const kv = {
    data,
    puts,
    async get(key: string, options?: unknown): Promise<unknown> {
      const e = live(key);
      if (!e) return null;
      const type =
        typeof options === 'string' ? options : ((options as { type?: string } | undefined)?.type ?? 'text');
      if (type === 'arrayBuffer') return e.value.slice(0);
      const text = new TextDecoder().decode(e.value);
      if (type === 'json') return JSON.parse(text);
      return text;
    },
    async put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: Record<string, unknown>,
    ) {
      puts.push({ key, options });
      const expiration =
        typeof options?.expiration === 'number'
          ? options.expiration
          : typeof options?.expirationTtl === 'number'
            ? Math.floor(now() / 1000) + options.expirationTtl
            : undefined;
      data.set(key, { value: toBuffer(value), metadata: options?.metadata, expiration });
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const keys = [...data.keys()]
        .filter((k) => live(k) && (!options?.prefix || k.startsWith(options.prefix)))
        .map((name) => ({ name, metadata: data.get(name)?.metadata }));
      return { keys, list_complete: true };
    },
  };
  return kv as typeof kv & KVNamespaceLike;
}

/** Minimal Cache API fake keyed by URL; stores a cloned Response. */
export function fakeCache(): CacheLike & { entries: Map<string, Response>; puts: number } {
  const entries = new Map<string, Response>();
  const urlOf = (r: RequestInfo | URL) => (typeof r === 'string' ? r : r instanceof URL ? r.href : r.url);
  const self = {
    entries,
    puts: 0,
    async match(request: RequestInfo | URL) {
      const hit = entries.get(urlOf(request));
      return hit ? hit.clone() : undefined;
    },
    async put(request: RequestInfo | URL, response: Response) {
      self.puts++;
      const buffered = new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      entries.set(urlOf(request), buffered);
    },
    async delete(request: RequestInfo | URL) {
      return entries.delete(urlOf(request));
    },
  };
  return self;
}

export function makeRoute(partial: Partial<HypRoute> & Pick<HypRoute, 'pathname'>): HypRoute {
  const kind = partial.kind ?? 'app-page';
  return {
    id: `${kind === 'app-page' ? 'app' : kind === 'app-route' ? 'route' : kind}:${partial.pathname}`,
    regex: routePatternToRegex(partial.pathname),
    kind,
    classification: 'static',
    runtime: 'nodejs',
    dynamic: /\[/.test(partial.pathname),
    assets: { js: [], css: [], fonts: [] },
    ...partial,
  };
}

export function makeManifest(routes: HypRoute[], partial: Partial<HypManifest> = {}): HypManifest {
  return emptyManifest({ buildId: 'build-1', routes, ...partial });
}

export const BASE_CONFIG: HypDrivConfig = {
  cache: { edge: { policies: [], infer: true } },
};

/** Builds a request context with the route matched from the manifest, like the runners do. */
export function makeCtx(
  input: string | Request,
  options: Omit<Partial<CreateContextOptions>, 'config'> & { config?: HypDrivConfig | ResolvedConfig } = {},
) {
  const request = typeof input === 'string' ? new Request(input) : input;
  const config = isResolved(options.config) ? options.config : resolveConfig(options.config ?? BASE_CONFIG);
  const manifest = options.manifest ?? makeManifest([]);
  const route =
    options.route === undefined
      ? createRouteMatcher(manifest).match(new URL(request.url).pathname)
      : options.route;
  return createContext({ ...options, request, config, manifest, route });
}

function isResolved(config: HypDrivConfig | ResolvedConfig | undefined): config is ResolvedConfig {
  return (
    !!config &&
    'site' in config &&
    'stages' in config &&
    typeof config.stages === 'object' &&
    config.stages !== null &&
    'disable' in config.stages
  );
}
