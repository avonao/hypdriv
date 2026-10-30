import { createKvTagIndex, registerEdgePurger, UPSTREAM_KEY } from '@hypdriv/cache';
import {
  assertManifest,
  clientIp,
  createContext,
  detectCapabilities,
  emptyManifest,
  getCf,
  HEADER,
  type HypContext,
  type HypDrivConfig,
  type HypDrivEnv,
  type HypManifest,
  isResolvedConfig,
  type KVNamespaceLike,
  loadConfig,
  looksLikeStaticAsset,
  nodeEnvironment,
  orderStages,
  type ResolvedConfig,
  runPipeline,
  type Stage,
  sanitizeInboundRequest,
} from '@hypdriv/core';
import { buildDefaultStages, createPlatform, type Platform } from '@hypdriv/next/stages';
import { runWithHypContext } from './context';
import { edgeStages } from './edge-stages';
import { cloudflareGeo } from './geo';
import {
  type DispatchContext,
  dispatchEmail,
  dispatchQueue,
  dispatchScheduled,
  type EmailMessageLike,
  forwardTail,
  type MessageBatchLike,
  type ScheduledEventLike,
  type TailEventLike,
} from './handlers';
import { internalRoutes } from './internal-routes';
import { createDoCounterStore, createDoTagIndex } from './stores';

export interface NextWorkerModule {
  default: { fetch(request: Request, env: unknown, ctx: ExecutionContextLike): Promise<Response> | Response };
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface CreateWorkerOptions {
  config: HypDrivConfig | ResolvedConfig;
  /** Lazily imports OpenNext's worker (`() => import('./.open-next/worker.js')`). */
  next: () => Promise<NextWorkerModule>;
  /**
   * The build manifest. Defaults to importing `./.hypdriv/manifest.js` relative to the project; pass
   * `() => import('./.hypdriv/manifest.js')` explicitly when your bundler needs a static import.
   */
  manifest?: HypManifest | (() => Promise<{ default: HypManifest } | HypManifest>);
  /** Customise the stage list. */
  stages?: Stage[] | ((defaults: Stage[], platform: Platform) => Stage[]);
  /** Called when Next.js or a stage throws. Default: JSON 500 with the request id. */
  onError?: (error: Error, request: Request, ctx: HypContext | null) => Response | Promise<Response>;
  /** Treat requests as development/preview (dev endpoints, verbose timings). Default: `NODE_ENV`/`NEXTJS_ENV` or localhost. */
  development?: boolean;
  /** Extra state for the DevTools endpoints. */
  devState?: () => Promise<Record<string, unknown>>;
}

export interface HypDrivWorker {
  fetch(request: Request, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<Response>;
  scheduled(event: ScheduledEventLike, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void>;
  queue(batch: MessageBatchLike, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void>;
  email(message: EmailMessageLike, env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void>;
  tail(events: TailEventLike[], env: HypDrivEnv, ctx: ExecutionContextLike): Promise<void>;
}

interface Runtime {
  platform: Platform;
  stages: Stage[];
  internal: ReturnType<typeof internalRoutes>;
  development: boolean;
}

function isResolved(config: HypDrivConfig | ResolvedConfig): config is ResolvedConfig {
  return isResolvedConfig(config);
}

async function loadManifest(source: CreateWorkerOptions['manifest']): Promise<HypManifest> {
  try {
    const loaded = typeof source === 'function' ? await source() : source;
    const manifest =
      loaded && 'default' in (loaded as { default?: unknown })
        ? (loaded as { default: HypManifest }).default
        : (loaded as HypManifest | undefined);
    if (!manifest) return emptyManifest();
    assertManifest(manifest);
    return manifest;
  } catch (err) {
    console.warn(`hypdriv: manifest unavailable (${(err as Error).message}); running with generic behaviour`);
    return emptyManifest();
  }
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/**
 * Creates the Worker entry that wraps OpenNext's worker with the HypDriv Drivetrain (ADR 0011).
 * Startup work is minimal; OpenNext is imported on the first request that needs it.
 */
export function createWorker(options: CreateWorkerOptions): HypDrivWorker {
  const resolved = isResolved(options.config) ? options.config : loadConfig(options.config);
  let runtimePromise: Promise<Runtime> | null = null;
  let runtimeEnv: HypDrivEnv | null = null;
  let nextPromise: Promise<NextWorkerModule> | null = null;

  const loadNext = () => {
    nextPromise ??= options.next();
    return nextPromise;
  };

  const buildRuntime = async (env: HypDrivEnv, request?: Request): Promise<Runtime> => {
    const manifest = await loadManifest(options.manifest);
    const development =
      options.development ??
      (nodeEnvironment(env as Record<string, unknown>) === 'development' ||
        (request ? isLocalHost(new URL(request.url).hostname) : false));
    const caps = detectCapabilities(env as Record<string, unknown>, resolved, { cf: true, waitUntil: true });
    const b = resolved.cloudflare.bindings;
    const overrides: NonNullable<Parameters<typeof createPlatform>[0]['overrides']> = { capabilities: caps };
    if (caps.limiter)
      overrides.counterStores = { 'durable-object': createDoCounterStore(env[b.limiter] as never) };
    if (caps.tagIndex) overrides.tagIndex = createDoTagIndex(env[b.tagIndex] as never);
    else if (caps.kv) overrides.tagIndex = createKvTagIndex(env[b.kv] as KVNamespaceLike);
    const platform = createPlatform({
      config: resolved,
      manifest,
      env,
      runner: 'worker',
      development,
      overrides,
    });
    const defaults = [...buildDefaultStages(platform), ...edgeStages(resolved)];
    const list =
      typeof options.stages === 'function'
        ? options.stages(defaults, platform)
        : (options.stages ?? defaults);
    const stages = orderStages(list, { order: resolved.stages.order, disable: resolved.stages.disable });
    if (platform.edgeCache) registerEdgePurger(platform.edgeCache);
    const internal = internalRoutes(platform, {
      devEndpoints: development,
      ...(options.devState ? { devState: options.devState } : {}),
    });
    platform.log.info('hypdriv worker ready', {
      build: manifest.buildId,
      routes: manifest.routes.length,
      stages: stages.map((s) => s.name),
    });
    return { platform, stages, internal, development };
  };

  const getRuntime = (env: HypDrivEnv, request?: Request): Promise<Runtime> => {
    if (!runtimePromise || runtimeEnv !== env) {
      runtimeEnv = env;
      runtimePromise = buildRuntime(env, request).catch((err) => {
        runtimePromise = null;
        throw err;
      });
    }
    return runtimePromise;
  };

  const errorResponse = async (error: Error, request: Request, ctx: HypContext | null): Promise<Response> => {
    if (options.onError) return options.onError(error, request, ctx);
    const body = {
      error: 'internal_error',
      requestId: ctx?.id ?? null,
      message: ctx?.development ? error.message : undefined,
    };
    return new Response(JSON.stringify(body), {
      status: 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(ctx ? { [HEADER.requestId]: ctx.id, [HEADER.hypRequestId]: ctx.id } : {}),
      },
    });
  };

  const invokeNext = async (
    request: Request,
    env: HypDrivEnv,
    exec: ExecutionContextLike,
  ): Promise<Response> => {
    const mod = await loadNext();
    return mod.default.fetch(request, env, exec);
  };

  const fetchHandler = async (
    incoming: Request,
    env: HypDrivEnv,
    exec: ExecutionContextLike,
  ): Promise<Response> => {
    const runtime = await getRuntime(env, incoming);
    // Client-supplied x-hypdriv-* / nonce / x-middleware-* headers must never reach the stages or Next.js.
    const request = sanitizeInboundRequest(incoming, {
      nonceHeader: runtime.platform.config.security.csp?.nonceHeader ?? HEADER.nonce,
    });
    const { platform, stages, internal } = runtime;
    const url = new URL(request.url);
    const cf = getCf(request);
    const ip = clientIp(request.headers, platform.config.security.trustedProxies);
    const country = typeof cf?.country === 'string' ? cf.country : undefined;

    const handled = await internal(request, {
      ip,
      ...(country ? { country } : {}),
      waitUntil: (p) => exec.waitUntil(p),
    });
    if (handled) return handled;

    // Static assets are normally served before the Worker; when they do arrive (run_worker_first), skip the pipeline.
    if (
      platform.config.cloudflare.skipStaticAssets &&
      (url.pathname.startsWith('/_next/static/') ||
        (looksLikeStaticAsset(url.pathname) && !url.pathname.startsWith('/api/')))
    ) {
      return invokeNext(request, env, exec);
    }

    const ctx = createContext({
      request,
      config: platform.config,
      manifest: platform.manifest,
      env,
      cf: cloudflareGeo(cf),
      runner: 'worker',
      development: runtime.development,
      waitUntil: (p) => exec.waitUntil(p),
      ip,
      log: platform.log,
    });
    ctx.route = platform.matcher.match(url.pathname);
    ctx.requestHeaders.set(HEADER.runner, 'worker');
    ctx.requestHeaders.set('x-hypdriv-pathname', url.pathname);
    if (ctx.route) ctx.requestHeaders.set(HEADER.route, ctx.route.route.id);

    ctx.state.set(UPSTREAM_KEY, (forwarded) => invokeNext(forwarded, env, exec));
    try {
      const { response } = await runWithHypContext(ctx, () =>
        runPipeline({
          stages,
          ctx,
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
      // stale-if-error: answer with a cached copy when the policy allows it.
      const stale = platform.edgeCache?.recover(ctx);
      if (stale) return stale;
      return errorResponse(err as Error, request, ctx);
    }
  };

  const dispatchContext = (
    runtime: Runtime,
    env: HypDrivEnv,
    exec: ExecutionContextLike,
  ): DispatchContext => ({
    config: runtime.platform.config,
    env,
    log: runtime.platform.log,
    waitUntil: (p) => exec.waitUntil(p),
    invoke: async (request) => {
      const self = env.WORKER_SELF_REFERENCE as { fetch(request: Request): Promise<Response> } | undefined;
      if (self && typeof self.fetch === 'function') return self.fetch(request);
      return fetchHandler(request, env, exec);
    },
  });

  return {
    fetch: fetchHandler,
    async scheduled(event, env, exec) {
      const runtime = await getRuntime(env);
      await dispatchScheduled(event, dispatchContext(runtime, env, exec));
    },
    async queue(batch, env, exec) {
      const runtime = await getRuntime(env);
      await dispatchQueue(batch, dispatchContext(runtime, env, exec));
    },
    async email(message, env, exec) {
      const runtime = await getRuntime(env);
      await dispatchEmail(message, dispatchContext(runtime, env, exec));
    },
    async tail(events, env) {
      const runtime = await getRuntime(env);
      forwardTail(events, { log: runtime.platform.log });
    },
  };
}
