import {
  appendListHeader,
  buildForwardedRequest,
  createRouteMatcher,
  defineStage,
  type FlagValue,
  type GeoProperties,
  getSetCookies,
  HEADER,
  type HypContext,
  type HypManifest,
  isRscRequest,
  type Logger,
  negotiateLanguage,
  parseCacheControl,
  parseCookies,
  type ResolvedConfig,
  type ResolvedEdgeCachePolicy,
  type RouteMatch,
  type RouteMatcher,
  SingleFlight,
  type Stage,
  silentLogger,
  stateKey,
  toError,
  withHeaders,
} from '@hypdriv/core';
import { buildCacheKey } from './keys';
import { cacheControlFor, effectiveTags, matchPolicyFor, resolvePolicies } from './policies';
import { CACHE_DECISION_KEY, UPSTREAM_KEY, type UpstreamFetch } from './state';
import { entryFreshness, isNullBodyStatus, lifetimeOf, readBody, storableHeaders } from './stores/meta';
import type {
  CacheDecision,
  CacheDimensionResolvers,
  CacheEntry,
  CacheMeta,
  CacheStatus,
  CacheStore,
  EdgeCache,
  EdgeCacheOptions,
  Purger,
  TagIndex,
} from './types';

type EdgeConfig = NonNullable<ResolvedConfig['cache']['edge']>;

/** Request header added to background revalidation requests. */
export const REVALIDATE_HEADER = 'x-hypdriv-revalidate';

/** The leader's buffered response, handed to coalesced followers. */
interface Shared {
  body: ArrayBuffer | null;
  status: number;
  statusText: string;
  headers: Headers;
  meta: CacheMeta;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  let settled = false;
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** Per-request bookkeeping of the stage (not exported: other packages read `CACHE_DECISION_KEY`). */
interface Local {
  edge: EdgeConfig;
  policy: ResolvedEdgeCachePolicy;
  key: string;
  vary: string[];
  tags: string[];
  method: 'GET' | 'HEAD';
  staleCandidate: CacheEntry | null;
  staleAge: number;
  leader: Deferred<Shared | null> | null;
  servedErrorStale: boolean;
}

const LOCAL_KEY = stateKey<Local>('edge-cache.local');

type Verdict =
  | { ok: true; ttl: number; swr: number; sie: number; negative: boolean }
  | { ok: false; reason: string };

function seconds(value: string | true | undefined): number | undefined {
  if (value === undefined || value === true) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}

/** Decides whether an upstream response may be stored under the policy, and with which durations. */
export function cacheability(
  input: { method: string; policy: ResolvedEdgeCachePolicy },
  response: Response,
  edge: Pick<EdgeConfig, 'negativeTtl' | 'maxBodySize'>,
): Verdict {
  const { policy } = input;
  if (input.method === 'HEAD') return { ok: false, reason: 'head' };
  const status = response.status;
  if (!policy.statuses.includes(status)) return { ok: false, reason: `status:${status}` };
  let ttl = policy.ttl;
  let swr = policy.swr;
  let sie = policy.staleIfError;
  let negative = false;
  if (status === 404 || status === 410) {
    if (edge.negativeTtl <= 0) return { ok: false, reason: 'negative-disabled' };
    ttl = edge.negativeTtl;
    swr = 0;
    sie = 0;
    negative = true;
  }
  if (getSetCookies(response.headers).length) return { ok: false, reason: 'set-cookie' };
  if (response.headers.get('vary')?.trim() === '*') return { ok: false, reason: 'vary' };
  if (policy.respectOrigin) {
    const cc = parseCacheControl(response.headers.get('cache-control'));
    if (cc['no-store']) return { ok: false, reason: 'origin:no-store' };
    if (cc.private) return { ok: false, reason: 'origin:private' };
    if (cc['no-cache']) return { ok: false, reason: 'origin:no-cache' };
    const originTtl = seconds(cc['s-maxage']) ?? seconds(cc['max-age']);
    if (originTtl !== undefined) {
      if (originTtl <= 0) return { ok: false, reason: 'origin:max-age=0' };
      ttl = Math.min(ttl, originTtl);
    }
    const originSwr = seconds(cc['stale-while-revalidate']);
    if (originSwr !== undefined) swr = Math.min(swr, originSwr);
    const originSie = seconds(cc['stale-if-error']);
    if (originSie !== undefined) sie = Math.min(sie, originSie);
    if (cc['must-revalidate'] || cc['proxy-revalidate']) {
      swr = 0;
      sie = 0;
    }
  }
  if (ttl + swr + sie <= 0) return { ok: false, reason: 'zero-ttl' };
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > edge.maxBodySize) return { ok: false, reason: 'too-large' };
  return { ok: true, ttl, swr, sie, negative };
}

/** Returns the bypass reason for a request under a policy, or null when it may use the cache. */
export function bypassReason(policy: ResolvedEdgeCachePolicy, ctx: HypContext): string | null {
  const headers = ctx.request.headers;
  if (!policy.includeRsc && isRscRequest(headers)) return 'rsc';
  if (headers.has('authorization')) return 'authorization';
  if (policy.bypass.cookies.length) {
    const cookies = parseCookies(headers.get('cookie'));
    for (const name of policy.bypass.cookies) if (name in cookies) return `cookie:${name}`;
  }
  for (const name of policy.bypass.headers) if (headers.has(name)) return `header:${name}`;
  for (const name of policy.bypass.query) if (ctx.url.searchParams.has(name)) return `query:${name}`;
  if (policy.bypass.when?.({ url: ctx.url, headers })) return 'when';
  const cc = parseCacheControl(headers.get('cache-control'));
  if (cc['no-cache'] || cc['no-store'] || headers.get('pragma')?.toLowerCase().includes('no-cache'))
    return 'no-cache';
  return null;
}

/** Device class from client hints or the user agent, for `vary.device` policies. */
export function deviceClassOf(headers: Headers): 'mobile' | 'desktop' {
  const hint = headers.get('sec-ch-ua-mobile');
  if (hint) return hint.includes('?1') ? 'mobile' : 'desktop';
  const ua = headers.get('user-agent') ?? '';
  return /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(ua) ? 'mobile' : 'desktop';
}

function defaultFlags(ctx: HypContext): Record<string, FlagValue> | undefined {
  const fromState = ctx.state.entries().find(([name]) => name === 'flags')?.[1];
  if (fromState && typeof fromState === 'object' && !Array.isArray(fromState))
    return fromState as Record<string, FlagValue>;
  const raw = ctx.requestHeaders.get(ctx.config.flags.header);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, FlagValue>;
  } catch {
    // Not JSON: the flags package exposes its decoder; wire it through `resolvers.flags`.
  }
  return undefined;
}

function defaultLocale(ctx: HypContext): string | undefined {
  const header = ctx.requestHeaders.get(ctx.config.i18n?.header ?? HEADER.locale);
  if (header) return header;
  const accept = ctx.request.headers.get('accept-language');
  if (!accept) return undefined;
  if (ctx.config.i18n)
    return negotiateLanguage(accept, ctx.config.i18n.locales, ctx.config.i18n.defaultLocale);
  const first = accept.split(',')[0]?.split(';')[0]?.trim().toLowerCase();
  return first?.split('-')[0] || undefined;
}

function responseFromEntry(entry: CacheEntry, method: 'GET' | 'HEAD'): Response {
  const source = entry.response;
  if (method === 'HEAD') {
    void source.body?.cancel().catch(() => undefined);
    return new Response(null, {
      status: source.status,
      statusText: source.statusText,
      headers: source.headers,
    });
  }
  return new Response(isNullBodyStatus(source.status) ? null : source.body, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });
}

interface DecorateOptions {
  status: CacheStatus;
  key: string;
  tags: string[];
  vary: string[];
  policy: ResolvedEdgeCachePolicy | null;
  edge: EdgeConfig;
  age?: number;
}

/** Applies the cache headers of architecture §6 to a response. */
export function decorateResponse(response: Response, o: DecorateOptions): Response {
  const headers = new Headers(response.headers);
  if (o.edge.debugHeader) {
    headers.set(HEADER.cache, o.status);
    headers.set(HEADER.cacheKey, o.key.slice(0, 16));
  }
  if (o.age !== undefined) headers.set('age', String(Math.max(0, Math.floor(o.age))));
  if (o.edge.emitTagHeaders && o.tags.length) {
    headers.set('cache-tag', o.tags.join(','));
    headers.set('surrogate-key', o.tags.join(' '));
  }
  if (o.vary.length) appendListHeader(headers, 'vary', o.vary);
  if (o.policy && !headers.has('cache-control')) headers.set('cache-control', cacheControlFor(o.policy));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

class EdgeCacheImpl implements EdgeCache {
  readonly store: CacheStore;
  private readonly tagIndex: TagIndex | undefined;
  private readonly purger: Purger | undefined;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly coalesceTimeoutMs: number;
  private readonly resolvers: CacheDimensionResolvers;
  private readonly inflight = new Map<string, Deferred<Shared | null>>();
  private readonly revalidating = new SingleFlight<void>();
  private readonly policyCache = new WeakMap<
    HypManifest,
    WeakMap<ResolvedConfig, ResolvedEdgeCachePolicy[]>
  >();
  private readonly matchers = new WeakMap<HypManifest, RouteMatcher>();
  private learned: { config: ResolvedConfig; manifest: HypManifest; origin: string | null } | null;

  constructor(options: EdgeCacheOptions) {
    this.store = options.store;
    this.tagIndex = options.tagIndex;
    this.purger = options.purger;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? silentLogger;
    this.coalesceTimeoutMs = options.coalesceTimeoutMs ?? 10_000;
    this.resolvers = options.resolvers ?? {};
    this.learned =
      options.config && options.manifest
        ? { config: options.config, manifest: options.manifest, origin: options.config.site.origin }
        : null;
  }

  stage(): Stage {
    return defineStage({
      name: 'edge-cache',
      pre: (ctx) => this.pre(ctx),
      post: (ctx, response) => this.post(ctx, response),
    });
  }

  // -- pre ---------------------------------------------------------------------------------------

  private async pre(ctx: HypContext): Promise<Response | undefined> {
    const edge = ctx.config.cache.edge;
    this.learn(ctx);
    if (!edge) return this.decide(ctx, { status: 'DYNAMIC', reason: 'disabled' });
    const method = ctx.request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD')
      return this.decide(ctx, { status: 'DYNAMIC', reason: `method:${method}` });
    const policies = this.policiesFor(ctx.config, ctx.manifest);
    const policy = matchPolicyFor(policies, ctx.url, ctx.route, ctx.manifest.basePath);
    if (!policy) return this.decide(ctx, { status: 'DYNAMIC', reason: 'no-policy' });
    if (!policy.methods.includes(method))
      return this.decide(ctx, { status: 'DYNAMIC', reason: `method:${method}`, policy });
    const bypass = bypassReason(policy, ctx);
    if (bypass) return this.decide(ctx, { status: 'BYPASS', reason: bypass, policy });
    if (lifetimeOf(policy) <= 0) return this.decide(ctx, { status: 'BYPASS', reason: 'zero-ttl', policy });

    const dims = this.dimensions(ctx, policy);
    const { key, vary } = await buildCacheKey({
      request: ctx.request,
      url: ctx.url,
      policy,
      buildId: ctx.manifest.buildId,
      geo: dims.geo,
      flags: dims.flags,
      locale: dims.locale,
      device: dims.device,
      trailingSlash: ctx.config.site.trailingSlash ?? ctx.manifest.trailingSlash,
      ignoredQuery: edge.ignoredQuery,
    });
    const tags = effectiveTags(policy, ctx.route, ctx.manifest.buildId);
    const local: Local = {
      edge,
      policy,
      key,
      vary,
      tags,
      method,
      staleCandidate: null,
      staleAge: 0,
      leader: null,
      servedErrorStale: false,
    };
    ctx.state.set(LOCAL_KEY, local);

    let entry: CacheEntry | null = null;
    try {
      entry = await this.store.get(key);
    } catch (err) {
      ctx.log.warn('edge-cache: lookup failed', { key: key.slice(0, 16), error: toError(err).message });
    }
    if (entry) {
      const { state, age } = entryFreshness(entry.meta, this.now());
      if (state === 'fresh') return this.serveFresh(ctx, local, entry, age);
      if (state === 'stale') return this.serveStale(ctx, local, entry, age);
      if (state === 'error') {
        local.staleCandidate = entry;
        local.staleAge = age;
      } else void entry.response.body?.cancel().catch(() => undefined);
    }

    let reason = 'lookup';
    if (method === 'GET') {
      const existing = this.inflight.get(key);
      if (existing) {
        const shared = await withTimeout(existing.promise, this.coalesceTimeoutMs);
        if (shared) return this.serveShared(ctx, local, shared);
        reason = 'coalesced:fallthrough';
      }
      const lead = deferred<Shared | null>();
      this.inflight.set(key, lead);
      void lead.promise.then(() => {
        if (this.inflight.get(key) === lead) this.inflight.delete(key);
      });
      local.leader = lead;
      try {
        ctx.signal?.addEventListener('abort', () => lead.resolve(null), { once: true });
      } catch {
        // Some runtimes expose a non-standard signal; coalesced followers then rely on the timeout.
      }
    }

    const upstream = ctx.state.get(UPSTREAM_KEY);
    if (upstream) ctx.state.set(UPSTREAM_KEY, this.wrapUpstream(ctx, local, upstream));
    this.decide(ctx, { status: 'MISS', reason, policy, key, tags });
    return undefined;
  }

  private serveFresh(ctx: HypContext, local: Local, entry: CacheEntry, age: number): Response {
    const negative = entry.meta.status === 404 || entry.meta.status === 410;
    const status: CacheStatus = negative ? 'NEGATIVE' : 'HIT';
    this.decide(ctx, {
      status,
      reason: negative ? 'negative' : 'fresh',
      policy: local.policy,
      key: local.key,
      age,
      tags: entry.meta.tags,
    });
    return decorateResponse(responseFromEntry(entry, local.method), {
      status,
      age,
      key: local.key,
      tags: entry.meta.tags,
      vary: entry.meta.vary,
      policy: local.policy,
      edge: local.edge,
    });
  }

  private serveStale(ctx: HypContext, local: Local, entry: CacheEntry, age: number): Response {
    const upstream = ctx.state.get(UPSTREAM_KEY);
    let reason: string;
    if (!upstream) reason = 'swr:no-upstream';
    else if (this.revalidating.has(local.key)) reason = 'swr:in-flight';
    else {
      reason = 'swr:revalidating';
      ctx.waitUntil(this.revalidate(ctx, local, upstream));
    }
    this.decide(ctx, {
      status: 'STALE',
      reason,
      policy: local.policy,
      key: local.key,
      age,
      tags: entry.meta.tags,
    });
    return decorateResponse(responseFromEntry(entry, local.method), {
      status: 'STALE',
      age,
      key: local.key,
      tags: entry.meta.tags,
      vary: entry.meta.vary,
      policy: local.policy,
      edge: local.edge,
    });
  }

  private serveShared(ctx: HypContext, local: Local, shared: Shared): Response {
    this.decide(ctx, {
      status: 'HIT',
      reason: 'coalesced',
      policy: local.policy,
      key: local.key,
      age: 0,
      tags: shared.meta.tags,
    });
    const response = new Response(local.method === 'HEAD' ? null : shared.body, {
      status: shared.status,
      statusText: shared.statusText,
      headers: new Headers(shared.headers),
    });
    return decorateResponse(response, {
      status: 'HIT',
      age: 0,
      key: local.key,
      tags: shared.meta.tags,
      vary: shared.meta.vary,
      policy: local.policy,
      edge: local.edge,
    });
  }

  private wrapUpstream(ctx: HypContext, local: Local, upstream: UpstreamFetch): UpstreamFetch {
    return async (request) => {
      try {
        return await upstream(request);
      } catch (err) {
        const stale = this.staleOnError(ctx, local, 'upstream:error');
        if (stale) return stale;
        local.leader?.resolve(null);
        throw err;
      }
    };
  }

  private staleOnError(ctx: HypContext, local: Local, reason: string): Response | undefined {
    const entry = local.staleCandidate;
    if (!entry || local.servedErrorStale) return undefined;
    local.servedErrorStale = true;
    local.staleCandidate = null;
    local.leader?.resolve(null);
    this.decide(ctx, {
      status: 'ERROR-STALE',
      reason,
      policy: local.policy,
      key: local.key,
      age: local.staleAge,
      tags: entry.meta.tags,
    });
    return decorateResponse(responseFromEntry(entry, local.method), {
      status: 'ERROR-STALE',
      age: local.staleAge,
      key: local.key,
      tags: entry.meta.tags,
      vary: entry.meta.vary,
      policy: local.policy,
      edge: local.edge,
    });
  }

  recover(ctx: HypContext): Response | undefined {
    const local = ctx.state.get(LOCAL_KEY);
    if (!local) return undefined;
    const stale = this.staleOnError(ctx, local, 'upstream:error');
    if (!stale) local.leader?.resolve(null);
    return stale;
  }

  // -- post --------------------------------------------------------------------------------------

  private async post(ctx: HypContext, response: Response): Promise<Response> {
    const edge = ctx.config.cache.edge;
    const local = ctx.state.get(LOCAL_KEY);
    const decision = ctx.state.get(CACHE_DECISION_KEY);
    if (!edge || !local || !decision) {
      return edge?.debugHeader && decision
        ? withHeaders(response, { [HEADER.cache]: decision.status })
        : response;
    }
    if (decision.status !== 'MISS' || local.servedErrorStale) return response;

    if (response.status >= 500) {
      const stale = this.staleOnError(ctx, local, `upstream:${response.status}`);
      if (stale) {
        void response.body?.cancel().catch(() => undefined);
        return stale;
      }
    }
    this.dropStaleCandidate(local);

    const verdict = cacheability(local, response, edge);
    if (!verdict.ok) {
      local.leader?.resolve(null);
      this.decide(ctx, { ...decision, reason: `uncacheable:${verdict.reason}` });
      return decorateResponse(response, {
        status: 'MISS',
        key: local.key,
        tags: [],
        vary: local.vary,
        policy: null,
        edge,
      });
    }

    const meta: CacheMeta = {
      key: local.key,
      storedAt: this.now(),
      ttl: verdict.ttl,
      swr: verdict.swr,
      staleIfError: verdict.sie,
      tags: local.tags,
      buildId: ctx.manifest.buildId,
      policyId: local.policy.id,
      vary: local.vary,
      status: response.status,
    };
    const clientHeaders = new Headers(response.headers);
    if (!clientHeaders.has('cache-control'))
      clientHeaders.set('cache-control', cacheControlFor(local.policy));
    if (local.vary.length) appendListHeader(clientHeaders, 'vary', local.vary);
    const storedHeaders = storableHeaders(clientHeaders);

    let clientBody = response.body;
    let storeBody: ReadableStream<Uint8Array> | null = null;
    if (response.body && !isNullBodyStatus(response.status)) {
      const [a, b] = response.body.tee();
      clientBody = a;
      storeBody = b;
    }
    ctx.waitUntil(
      this.persist(ctx, local, meta, storedHeaders, storeBody, response.status, response.statusText),
    );
    this.decide(ctx, {
      status: 'MISS',
      reason: verdict.negative ? 'store:negative' : 'store',
      policy: local.policy,
      key: local.key,
      tags: local.tags,
    });
    return decorateResponse(
      new Response(clientBody, {
        status: response.status,
        statusText: response.statusText,
        headers: clientHeaders,
      }),
      { status: 'MISS', key: local.key, tags: local.tags, vary: [], policy: local.policy, edge },
    );
  }

  private async persist(
    ctx: HypContext,
    local: Local,
    meta: CacheMeta,
    headers: Headers,
    body: ReadableStream<Uint8Array> | null,
    status: number,
    statusText: string,
  ): Promise<void> {
    try {
      const buffer = body ? await readBody(body, local.edge.maxBodySize) : null;
      if (body && buffer === null) {
        local.leader?.resolve(null);
        ctx.log.debug('edge-cache: body exceeds maxBodySize, not stored', { key: meta.key.slice(0, 16) });
        return;
      }
      const shared: Shared = { body: buffer?.byteLength ? buffer : null, status, statusText, headers, meta };
      local.leader?.resolve(shared);
      await this.writeEntry(shared);
    } catch (err) {
      local.leader?.resolve(null);
      ctx.log.warn('edge-cache: store failed', { key: meta.key.slice(0, 16), error: toError(err).message });
    }
  }

  private async writeEntry(shared: Shared): Promise<void> {
    await this.store.set(shared.meta.key, {
      response: new Response(shared.body, {
        status: shared.status,
        statusText: shared.statusText,
        headers: new Headers(shared.headers),
      }),
      meta: shared.meta,
    });
    if (this.tagIndex) {
      const indexed = shared.meta.tags.filter((t) => !t.startsWith('build:'));
      if (indexed.length) await this.tagIndex.add(shared.meta.key, indexed, lifetimeOf(shared.meta));
    }
  }

  private dropStaleCandidate(local: Local): void {
    const entry = local.staleCandidate;
    if (!entry) return;
    local.staleCandidate = null;
    void entry.response.body?.cancel().catch(() => undefined);
  }

  // -- revalidation ------------------------------------------------------------------------------

  private async revalidate(ctx: HypContext, local: Local, upstream: UpstreamFetch): Promise<void> {
    const { promise } = this.revalidating.run(local.key, async () => {
      const forwarded = buildForwardedRequest(ctx);
      const headers = new Headers(forwarded.headers);
      headers.set(REVALIDATE_HEADER, '1');
      const request = new Request(forwarded.url, { method: 'GET', headers });
      const response = await upstream(request);
      const verdict = cacheability({ method: 'GET', policy: local.policy }, response, local.edge);
      if (!verdict.ok) {
        void response.body?.cancel().catch(() => undefined);
        ctx.log.debug('edge-cache: revalidation kept the stale entry', {
          key: local.key.slice(0, 16),
          status: response.status,
          reason: verdict.reason,
        });
        return;
      }
      const buffer = await readBody(response.body, local.edge.maxBodySize);
      if (buffer === null) return;
      const clientHeaders = new Headers(response.headers);
      if (!clientHeaders.has('cache-control'))
        clientHeaders.set('cache-control', cacheControlFor(local.policy));
      if (local.vary.length) appendListHeader(clientHeaders, 'vary', local.vary);
      const meta: CacheMeta = {
        key: local.key,
        storedAt: this.now(),
        ttl: verdict.ttl,
        swr: verdict.swr,
        staleIfError: verdict.sie,
        tags: local.tags,
        buildId: ctx.manifest.buildId,
        policyId: local.policy.id,
        vary: local.vary,
        status: response.status,
      };
      await this.writeEntry({
        body: buffer.byteLength ? buffer : null,
        status: response.status,
        statusText: response.statusText,
        headers: storableHeaders(clientHeaders),
        meta,
      });
      ctx.log.debug('edge-cache: revalidated', { key: local.key.slice(0, 16), status: 'REVALIDATED' });
    });
    try {
      await promise;
    } catch (err) {
      ctx.log.warn('edge-cache: revalidation failed', {
        key: local.key.slice(0, 16),
        error: toError(err).message,
      });
    }
  }

  // -- purge -------------------------------------------------------------------------------------

  async purgeTags(tags: string[]): Promise<number> {
    const unique = [...new Set(tags.filter(Boolean))];
    if (!unique.length) return 0;
    let keys: string[] = [];
    if (this.tagIndex) {
      try {
        keys = await this.tagIndex.keysFor(unique);
      } catch (err) {
        this.log.warn('edge-cache: tag index lookup failed', { error: toError(err).message });
      }
    }
    let deleted = 0;
    const results = await Promise.allSettled(keys.map((key) => this.store.delete(key)));
    for (const r of results) if (r.status === 'fulfilled') deleted++;
    if (this.tagIndex && keys.length) {
      try {
        await this.tagIndex.remove(keys);
      } catch (err) {
        this.log.warn('edge-cache: tag index remove failed', { error: toError(err).message });
      }
    }
    if (this.tagIndex?.removeTags) {
      try {
        await this.tagIndex.removeTags(unique);
      } catch (err) {
        this.log.warn('edge-cache: tag index removeTags failed', { error: toError(err).message });
      }
    }
    if (this.purger) {
      try {
        await this.purger.purgeTags(unique);
      } catch (err) {
        this.log.warn('edge-cache: zone purge failed', { error: toError(err).message });
      }
    }
    return deleted;
  }

  async purgeUrls(urls: string[]): Promise<number> {
    const context = this.learned;
    const absolute: URL[] = [];
    for (const raw of urls) {
      try {
        absolute.push(new URL(raw, context?.origin ?? undefined));
      } catch {
        this.log.warn('edge-cache: purgeUrls skipped a relative URL without a known origin', { url: raw });
      }
    }
    let deleted = 0;
    const edge = context?.config.cache.edge;
    if (context && edge) {
      const policies = this.policiesFor(context.config, context.manifest);
      const matcher = this.matcherFor(context.manifest);
      for (const url of absolute) {
        const route: RouteMatch | null = matcher.match(url.pathname);
        const policy = matchPolicyFor(policies, url, route, context.manifest.basePath);
        if (!policy) continue;
        const { key } = await buildCacheKey({
          request: new Request(url, { method: 'GET' }),
          url,
          policy,
          buildId: context.manifest.buildId,
          trailingSlash: context.config.site.trailingSlash ?? context.manifest.trailingSlash,
          ignoredQuery: edge.ignoredQuery,
        });
        try {
          await this.store.delete(key);
          deleted++;
        } catch (err) {
          this.log.warn('edge-cache: delete failed', { key: key.slice(0, 16), error: toError(err).message });
        }
      }
    }
    if (this.purger && absolute.length) {
      try {
        await this.purger.purgeUrls(absolute.map((u) => u.href));
      } catch (err) {
        this.log.warn('edge-cache: zone purge failed', { error: toError(err).message });
      }
    }
    return deleted;
  }

  // -- helpers -----------------------------------------------------------------------------------

  private decide(ctx: HypContext, decision: CacheDecision): undefined {
    ctx.state.set(CACHE_DECISION_KEY, decision);
    ctx.timings.mark('cache', decision.status);
    return undefined;
  }

  private learn(ctx: HypContext): void {
    if (this.learned?.config === ctx.config && this.learned.manifest === ctx.manifest) return;
    this.learned = {
      config: ctx.config,
      manifest: ctx.manifest,
      origin: ctx.config.site.origin ?? ctx.url.origin,
    };
  }

  private policiesFor(config: ResolvedConfig, manifest: HypManifest): ResolvedEdgeCachePolicy[] {
    let byConfig = this.policyCache.get(manifest);
    if (!byConfig) {
      byConfig = new WeakMap();
      this.policyCache.set(manifest, byConfig);
    }
    let policies = byConfig.get(config);
    if (!policies) {
      policies = resolvePolicies(config, manifest);
      byConfig.set(config, policies);
    }
    return policies;
  }

  private matcherFor(manifest: HypManifest): RouteMatcher {
    let matcher = this.matchers.get(manifest);
    if (!matcher) {
      matcher = createRouteMatcher(manifest);
      this.matchers.set(manifest, matcher);
    }
    return matcher;
  }

  private dimensions(
    ctx: HypContext,
    policy: ResolvedEdgeCachePolicy,
  ): { geo?: GeoProperties; flags?: Record<string, FlagValue>; locale?: string; device?: string } {
    return {
      geo: policy.vary.geo.length ? ctx.cf : undefined,
      flags: policy.vary.flags.length ? (this.resolvers.flags?.(ctx) ?? defaultFlags(ctx)) : undefined,
      locale: policy.vary.language ? (this.resolvers.locale?.(ctx) ?? defaultLocale(ctx)) : undefined,
      device: policy.vary.device
        ? (this.resolvers.device?.(ctx) ?? deviceClassOf(ctx.request.headers))
        : undefined,
    };
  }
}

/**
 * Creates the edge cache: the `edge-cache` stage plus purge helpers, sharing one store, tag index and
 * purger per isolate. Coalescing and revalidation single-flight state lives on the instance.
 */
export function createEdgeCache(options: EdgeCacheOptions): EdgeCache {
  return new EdgeCacheImpl(options);
}
