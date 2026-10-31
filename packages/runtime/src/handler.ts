import { createKvTagIndex, type EdgePurger, registerEdgePurger, UPSTREAM_KEY } from '@hypdriv/cache';
import {
  assertManifest,
  cacheVersion,
  clientIp,
  createContext,
  type DeployTarget,
  detectDeployTarget,
  emptyManifest,
  type GeoProperties,
  getCf,
  getCurrentContext,
  HEADER,
  type HypContext,
  type HypDrivConfig,
  type HypDrivEnv,
  type HypManifest,
  isResolvedConfig,
  isWorkerd,
  type KVNamespaceLike,
  loadConfig,
  nodeEnvironment,
  orderStages,
  platformWaitUntil,
  type ResolvedConfig,
  registerRuntime,
  runPipeline,
  runWithContext,
  type Stage,
  sanitizeInboundRequest,
} from '@hypdriv/core';
import { createDoCounterStore, createDoTagIndex } from './cloudflare/stores';
import { ensureContextStore } from './context-store';
import { readManifestFile } from './shared/manifest-file';
import { edgeStages } from './stages/edge';
import { geoFrom } from './stages/geo';
import {
  buildDefaultStages,
  type CreatePlatformInput,
  createPlatform,
  httpsUpgrade,
  internalRoutes,
  type Platform,
} from './stages/index';

/** A stage list, or a function of the defaults and the platform. */
export type StageList = Stage[] | ((defaults: Stage[], platform: Platform) => Stage[]);

/** Where the manifest comes from: the object itself, a loader (`() => import('./.hypdriv/manifest.js')`) or none. */
export type ManifestSource =
  | HypManifest
  | null
  | (() =>
      | Promise<HypManifest | { default: HypManifest } | null | undefined>
      | HypManifest
      | { default: HypManifest }
      | null
      | undefined);

export interface CreateHandlerOptions {
  config: HypDrivConfig | ResolvedConfig;
  /**
   * The build manifest. Default: `.hypdriv/manifest.json` read from the working directory on Node (Vercel
   * Functions, Node servers); an empty manifest elsewhere. Framework integrations pass the manifest module the
   * HypDriv Vite plugin generates.
   */
  manifest?: ManifestSource;
  /** Customise the stage list. */
  stages?: StageList;
  /** Deployment target (default: the config's `platform`, else detected: workerd → `cloudflare`, `VERCEL=1` → `vercel`). */
  target?: DeployTarget;
  /** Development mode (dev endpoints, verbose timings, `'unsafe-eval'` for dev servers). Default: `NODE_ENV`. */
  development?: boolean;
  /** Platform overrides (stores, providers) for tests and custom hosts. */
  platform?: CreatePlatformInput['overrides'];
  /** The framework label reported in logs and `/_hypdriv/health` (`react-router`, `astro`, `sveltekit`…). */
  host?: string;
  /** Extra state for the DevTools endpoints. */
  devState?: () => Promise<Record<string, unknown>>;
  /**
   * Called when a stage throws outside a request's normal flow. Default: rethrow, so the framework renders its
   * own error page (stale-if-error still answers first when a policy allows it).
   */
  onError?: (error: Error, request: Request, ctx: HypContext | null) => Response | Promise<Response>;
  /**
   * Requests that skip the pipeline (the application answers them directly): static files that reach the
   * handler (hashed assets in dev servers, `favicon.ico`…). Default: file-like paths outside `/api/`. Internal
   * routes and the HTTPS upgrade still apply.
   */
  skip?: (url: URL, request: Request) => boolean;
}

export interface HandleInput {
  /** Renders the application's response for the (forwarded) request. */
  upstream: (request: Request) => Promise<Response> | Response;
  /**
   * The platform environment: Cloudflare bindings, or `process.env` (default). On Workers pass the `env` the
   * framework exposes (bindings are only reachable through it).
   */
  env?: HypDrivEnv;
  /** Keeps background work alive after the response (`ctx.waitUntil` on Workers, Vercel's `waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** `request.cf` when the framework hands over a request without it. */
  cf?: GeoProperties;
  /** The client IP when the framework knows it better than the forwarded headers (Node socket address). */
  ip?: string;
}

export interface HandlerRuntime {
  platform: Platform;
  stages: Stage[];
  internal: ReturnType<typeof internalRoutes>;
  target: DeployTarget;
}

/** The request handler returned by `createHandler`. */
export interface HypHandler {
  (request: Request, input: HandleInput): Promise<Response>;
  /** The resolved configuration. */
  readonly config: ResolvedConfig;
  /** Initialises (once per environment) and returns the runtime: platform, stages, internal routes. */
  ready(env?: HypDrivEnv): Promise<HandlerRuntime>;
  /**
   * Wraps a Workers-style `fetch(request, env, ctx)` handler (Cloudflare worker entries, Nitro/vinext workers):
   * bindings come from `env`, background work goes to `ctx.waitUntil`.
   */
  wrapFetch<Env, Ctx extends { waitUntil(promise: Promise<unknown>): void } | undefined>(
    fetch: (request: Request, env: Env, ctx: Ctx) => Promise<Response> | Response,
  ): (request: Request, env: Env, ctx: Ctx) => Promise<Response>;
}

function processEnv(): HypDrivEnv {
  return ((globalThis as { process?: { env?: HypDrivEnv } }).process?.env ?? {}) as HypDrivEnv;
}

async function loadManifestSource(source: ManifestSource | undefined): Promise<HypManifest> {
  try {
    if (source === undefined) return (await readManifestFile(Number.POSITIVE_INFINITY)) ?? emptyManifest();
    if (source === null) return emptyManifest();
    const loaded = typeof source === 'function' ? await source() : source;
    const manifest =
      loaded && typeof loaded === 'object' && 'default' in loaded
        ? (loaded as { default: HypManifest }).default
        : (loaded as HypManifest | null | undefined);
    if (!manifest) return emptyManifest();
    assertManifest(manifest);
    return manifest;
  } catch (err) {
    console.warn(`hypdriv: manifest unavailable (${(err as Error).message}); running with generic behaviour`);
    return emptyManifest();
  }
}

/** Purser diagnostics written by the dev watcher (statically scoped path, Node only). */
async function readDevState(): Promise<Record<string, unknown>> {
  try {
    const proc = (globalThis as { process?: { versions?: { node?: string }; cwd?: () => string } }).process;
    if (!proc?.versions?.node || typeof proc.cwd !== 'function') return {};
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    return {
      purser: JSON.parse(
        await readFile(join(proc.cwd(), '.hypdriv', 'dev', 'purser.json'), 'utf8'),
      ) as unknown,
    };
  } catch {
    return {};
  }
}

const ASSET_EXTENSION =
  /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|webmanifest|mp4|webm|ogg|mp3|wav|wasm)$/i;

/**
 * The default `skip` rule: build assets and media (`/assets/app-3f2a.js`, `/favicon.ico`) outside `/api/`.
 * Data-like paths (`.json`, `.xml`, `.txt`, `.data`) stay in the pipeline: frameworks serve navigation data,
 * feeds and endpoints under them.
 */
export function isStaticRequest(url: URL): boolean {
  return ASSET_EXTENSION.test(url.pathname) && !url.pathname.startsWith('/api/');
}

/** `env` and `waitUntil` of the current Worker invocation (`cloudflare:workers`), or null outside workerd. */
async function workersContext(): Promise<{
  env: HypDrivEnv;
  waitUntil?: (p: Promise<unknown>) => void;
} | null> {
  if (!isWorkerd()) return null;
  try {
    const specifier = 'cloudflare:workers';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      env?: HypDrivEnv;
      waitUntil?: (p: Promise<unknown>) => void;
    };
    if (!mod.env) return null;
    return { env: mod.env, ...(typeof mod.waitUntil === 'function' ? { waitUntil: mod.waitUntil } : {}) };
  } catch {
    return null;
  }
}

/**
 * Assembles a platform for `target` (Cloudflare Durable Object stores, Vercel services) and the stage
 * adapter that goes with it. Shared by `createHandler` and the Next.js proxy.
 */
export async function platformFor(input: {
  config: ResolvedConfig;
  manifest: HypManifest | null;
  env: HypDrivEnv;
  runner: 'proxy' | 'host';
  target: DeployTarget;
  development: boolean;
  overrides?: CreatePlatformInput['overrides'] | undefined;
}): Promise<{
  platform: Platform;
  env: HypDrivEnv;
  adapt: ((defaults: Stage[]) => Stage[]) | null;
  purger: EdgePurger | null;
}> {
  const { config, target, runner } = input;
  let env = input.env;
  let overrides: CreatePlatformInput['overrides'] = input.overrides;
  let adapt: ((defaults: Stage[]) => Stage[]) | null = null;
  let purger: EdgePurger | null = null;
  if (target === 'vercel') {
    const vercel = await import('@hypdriv/vercel');
    env = vercel.vercelEnv(config, env as Record<string, unknown>) as HypDrivEnv;
    const { edgePurger, ...platformOverrides } = vercel.vercelPlatformOverrides(
      config,
      env as Record<string, unknown>,
    );
    overrides = { ...platformOverrides, ...(input.overrides ?? {}) };
    purger = edgePurger;
    // Inside the function that renders the response, Vercel's CDN follows the headers the stage sets.
    adapt = vercel.vercelStages(config, { responseOwner: runner === 'host' });
  } else if (target === 'cloudflare') {
    // Durable Object counters and tag index when the bindings exist (same choice as the Worker shell).
    const b = config.cloudflare.bindings;
    const cf: NonNullable<CreatePlatformInput['overrides']> = {};
    const limiter = env[b.limiter] as { idFromName?: unknown } | undefined;
    const tagIndex = env[b.tagIndex] as { idFromName?: unknown } | undefined;
    const kv = env[b.kv] as KVNamespaceLike | undefined;
    if (typeof limiter?.idFromName === 'function')
      cf.counterStores = { 'durable-object': createDoCounterStore(limiter as never) };
    if (typeof tagIndex?.idFromName === 'function') cf.tagIndex = createDoTagIndex(tagIndex as never);
    else if (kv && typeof kv.get === 'function' && typeof kv.put === 'function')
      cf.tagIndex = createKvTagIndex(kv);
    overrides = { ...cf, ...(input.overrides ?? {}) };
  }
  const platform = createPlatform({
    config,
    manifest: input.manifest,
    env,
    runner,
    target,
    development: input.development,
    ...(overrides ? { overrides } : {}),
  });
  return { platform, env, adapt, purger };
}

/**
 * Creates a request handler that runs the HypDriv Drivetrain around any Web `fetch` handler — the integration
 * point of every non-Next.js host (React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext, plain Vite
 * apps). The handler owns the full response, so on every platform it can inject CSP nonces, set Vercel CDN
 * headers that Vercel's cache follows, and answer `/_hypdriv/*`:
 *
 * ```ts
 * const hypdriv = createHandler({ config, manifest: () => import('virtual:hypdriv/manifest'), host: 'astro' });
 * const response = await hypdriv(request, { upstream: () => next(), env, waitUntil });
 * ```
 *
 * Inside the HypDriv Cloudflare Worker shell (which already ran the stages around the request) the handler
 * passes straight through to `upstream`.
 */
export function createHandler(options: CreateHandlerOptions): HypHandler {
  const config: ResolvedConfig = isResolvedConfig(options.config)
    ? options.config
    : loadConfig(options.config);
  let runtimePromise: Promise<HandlerRuntime> | null = null;
  let runtimeEnv: HypDrivEnv | null = null;
  let manifestPromise: Promise<HypManifest> | null = null;
  const skip = options.skip ?? ((url: URL) => isStaticRequest(url));

  const build = async (env: HypDrivEnv): Promise<HandlerRuntime> => {
    manifestPromise ??= loadManifestSource(options.manifest);
    const manifest = await manifestPromise;
    const target = options.target ?? detectDeployTarget(env as Record<string, unknown>, config.platform);
    const development =
      options.development ?? nodeEnvironment(env as Record<string, unknown>) === 'development';
    const {
      platform,
      env: augmented,
      adapt,
      purger,
    } = await platformFor({
      config,
      manifest,
      env,
      runner: 'host',
      target,
      development,
      overrides: options.platform,
    });
    const base = buildDefaultStages(platform);
    const withPlatform = adapt ? adapt(base) : base;
    // HTML streaming transforms exist where `HTMLRewriter` does (workerd).
    const defaults = platform.capabilities.htmlRewriter
      ? [...withPlatform, ...edgeStages(config)]
      : withPlatform;
    const list =
      typeof options.stages === 'function'
        ? options.stages(defaults, platform)
        : (options.stages ?? defaults);
    const stages = orderStages(list, { order: config.stages.order, disable: config.stages.disable });
    registerRuntime({ config, env: augmented, target });
    // `revalidate()` / `purgeEdge()` purge what actually caches responses: Vercel's CDN or the edge cache.
    if (purger) registerEdgePurger(purger);
    else if (platform.edgeCache) registerEdgePurger(platform.edgeCache);
    const internal = internalRoutes(platform, {
      devEndpoints: development,
      devState: options.devState ?? readDevState,
    });
    await ensureContextStore();
    platform.log.info('hypdriv handler ready', {
      host: options.host ?? 'custom',
      target,
      build: cacheVersion(manifest),
      deployment: manifest.deploymentId ?? null,
      routes: manifest.routes.length,
      stages: stages.map((s) => s.name),
    });
    return { platform, stages, internal, target };
  };

  const ready = (env?: HypDrivEnv): Promise<HandlerRuntime> => {
    const e = env ?? processEnv();
    if (!runtimePromise || runtimeEnv !== e) {
      runtimeEnv = e;
      runtimePromise = build(e).catch((err) => {
        runtimePromise = null;
        throw err;
      });
    }
    return runtimePromise;
  };

  const handle = async (incoming: Request, input: HandleInput): Promise<Response> => {
    // The Worker shell (or an outer handler) already ran the stages around this request.
    const current = getCurrentContext();
    if (current && (current.runner === 'worker' || current.runner === 'host'))
      return input.upstream(incoming);

    // On Workers, bindings and `waitUntil` come from the invocation when the framework does not hand them over.
    const workers = input.env === undefined || input.waitUntil === undefined ? await workersContext() : null;
    const env = input.env ?? workers?.env;
    const runtime = await ready(env);
    const { platform, stages, internal } = runtime;
    // Client-supplied x-hypdriv-* / nonce / x-middleware-* headers never reach the stages or the application's
    // forwarded request (helpers read the request context, never these headers).
    const request = sanitizeInboundRequest(incoming, {
      nonceHeader: platform.config.security.csp?.nonceHeader ?? HEADER.nonce,
    });
    const upgrade = httpsUpgrade(platform.config, request, { development: platform.development });
    if (upgrade) return upgrade;

    const cf = input.cf ?? getCf(request);
    const ip = input.ip ?? clientIp(request.headers, platform.config.security.trustedProxies);
    const country = geoFrom(cf, request.headers).country;
    const waitUntil =
      input.waitUntil ??
      workers?.waitUntil ??
      platformWaitUntil() ??
      ((p: Promise<unknown>) => {
        void p.catch(() => undefined);
      });
    const handled = await internal(request, { ip, ...(country ? { country } : {}), waitUntil });
    if (handled) return handled;

    const url = new URL(request.url);
    if (skip(url, request)) return input.upstream(incoming);

    const ctx = createContext({
      request,
      config: platform.config,
      manifest: platform.manifest,
      env: platform.env,
      ...(cf ? { cf } : {}),
      runner: 'host',
      development: platform.development,
      waitUntil,
      ip,
      log: platform.log,
    });
    ctx.route = platform.matcher.match(url.pathname);
    ctx.requestHeaders.set(HEADER.runner, 'host');
    ctx.requestHeaders.set('x-hypdriv-pathname', url.pathname);
    if (ctx.route) ctx.requestHeaders.set(HEADER.route, ctx.route.route.id);
    ctx.state.set(UPSTREAM_KEY, async (forwarded) => input.upstream(forwarded));
    try {
      const { response } = await runWithContext(ctx, () =>
        runPipeline({
          stages,
          ctx,
          skipEdgeOnly: !platform.capabilities.htmlRewriter,
          next: (forwarded) => ctx.state.get(UPSTREAM_KEY)!(forwarded),
          onStageError: (error, stage, phase) => {
            platform.log.error('stage failed', {
              stage: stage.name,
              phase,
              error: error.message,
              requestId: ctx.id,
            });
            return 'continue';
          },
        }),
      );
      return response;
    } catch (err) {
      platform.log.error('request failed', {
        requestId: ctx.id,
        path: url.pathname,
        error: (err as Error).message,
      });
      const stale = platform.edgeCache?.recover(ctx);
      if (stale) return stale;
      if (options.onError) return options.onError(err as Error, request, ctx);
      throw err;
    }
  };

  const handler = handle as HypHandler;
  Object.defineProperty(handler, 'config', { value: config, enumerable: true });
  (handler as { ready: HypHandler['ready'] }).ready = ready;
  (handler as { wrapFetch: HypHandler['wrapFetch'] }).wrapFetch = (fetch) => async (request, env, ctx) =>
    handle(request, {
      upstream: (forwarded) => fetch(forwarded, env, ctx),
      env: env as HypDrivEnv,
      ...(ctx && typeof ctx.waitUntil === 'function'
        ? { waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p) }
        : {}),
    });
  return handler;
}
