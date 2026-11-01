import {
  type AppWorkerModule,
  createWorker,
  type ExecutionContextLike,
  type HypDrivWorker,
} from '@hypdriv/cloudflare';
import { type HypDrivEnv, isResolvedConfig, loadConfig, queueConsumerFor } from '@hypdriv/core';
import { handlerFor, type WakuServerEntry, type WrapOptions, wrapFetch } from './entry';

/** The path Waku's Cloudflare adapter answers the build's static-generation request on (adapter option). */
export const DEFAULT_BUILD_PATH = '__waku_internal_build_static_files';

/** The handlers the Cloudflare adapter exports as the Worker (`fetch` plus the application's own `handlers`). */
type WorkerHandler = (...args: never[]) => unknown;
interface WakuWorker {
  fetch(request: Request, env: unknown, ctx: ExecutionContextLike): Response | Promise<Response>;
  [handler: string]: unknown;
}

export interface CloudflareWrapOptions extends WrapOptions {
  /**
   * The static-assets binding answered first for GET/HEAD requests, so prerendered pages, RSC payloads and public
   * files are served as built when the Worker runs first (`assets.run_worker_first`, which gives them the request
   * stages). `false` sends everything to Waku. Default `ASSETS`.
   */
  assets?: string | false;
  /** The adapter's `internalPathToBuildStaticFiles` option, when the application changed it. */
  internalPathToBuildStaticFiles?: string;
}

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * Waku calls its Cloudflare adapter in the build to generate the static files: a request to this path on a
 * loopback host, without the `cf-visitor` header every production request carries. It goes to Waku directly, so
 * the generated files carry no request's nonce, id or flags; Waku applies the same checks again.
 */
export function isBuildRequest(request: Request, path: string = DEFAULT_BUILD_PATH): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.pathname !== `/${path.replace(/^\/+/, '')}`) return false;
  if (request.headers.get('cf-visitor')) return false;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
}

async function workersContext(): Promise<{ env: unknown; ctx: ExecutionContextLike } | null> {
  try {
    // A specifier only known at run time, so no bundler (Rolldown's const inlining, a Node target's resolver)
    // turns it into a static import of a module that exists only in workerd.
    const name = (globalThis as { __hypdrivWorkersModule?: string }).__hypdrivWorkersModule ?? 'workers';
    const specifier = `cloudflare:${name}`;
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      env?: unknown;
      waitUntil?: (promise: Promise<unknown>) => void;
      passThroughOnException?: () => void;
    };
    if (!mod.env || typeof mod.waitUntil !== 'function') return null;
    return {
      env: mod.env,
      ctx: {
        waitUntil: mod.waitUntil,
        ...(mod.passThroughOnException ? { passThroughOnException: mod.passThroughOnException } : {}),
      },
    };
  } catch {
    return null;
  }
}

/**
 * A Worker event Hypdriv and the application both handle: Hypdriv's dispatcher first, then the application's own
 * handler; a failure of either is raised after both ran.
 */
function bothHandlers<A extends unknown[]>(
  hypdriv: (...args: A) => Promise<void>,
  own: ((...args: A) => unknown) | undefined,
  pick?: (...args: A) => 'hypdriv' | 'own' | 'both',
): (...args: A) => Promise<void> {
  if (!own) return hypdriv;
  return async (...args: A) => {
    const mode = pick ? pick(...args) : 'both';
    const errors: unknown[] = [];
    if (mode !== 'own')
      await hypdriv(...args).catch((error: unknown) => {
        errors.push(error);
      });
    if (mode !== 'hypdriv')
      await Promise.resolve(own(...args)).catch((error: unknown) => {
        errors.push(error);
      });
    if (errors.length) throw errors[0];
  };
}

/**
 * Waku's Cloudflare adapter behind Hypdriv's Worker shell. The Worker's default export is `createWorker()` around
 * Waku's own: the full Drivetrain with `HTMLRewriter` for every request the Worker receives, `/_hypdriv/*`, Durable
 * Object stores when bound, and `scheduled`, `queue` and `email` handlers for Hypdriv's jobs next to the
 * application's `handlers` (Hypdriv's dispatchers take the events configured in `jobs`; the application's handler
 * takes the rest). GET/HEAD requests are answered from the assets binding first.
 */
export function wrapCloudflareEntry(entry: WakuServerEntry, options: CloudflareWrapOptions): WakuServerEntry {
  const { assets = 'ASSETS', internalPathToBuildStaticFiles, ...wrap } = options;
  const waku = (entry.defaultExport ?? {}) as WakuWorker;
  const resolved = isResolvedConfig(wrap.config) ? wrap.config : loadConfig(wrap.config);
  const { stages, onError, development, devState } = wrap;

  const app: AppWorkerModule['default'] = {
    async fetch(request: Request, env: unknown, ctx: ExecutionContextLike) {
      const binding =
        assets === false
          ? undefined
          : ((env as Record<string, unknown> | undefined)?.[assets] as AssetsBinding | undefined);
      if (
        binding &&
        typeof binding.fetch === 'function' &&
        (request.method === 'GET' || request.method === 'HEAD')
      ) {
        const asset = await binding.fetch(request);
        if (asset.status !== 404) return asset;
        void asset.body?.cancel().catch(() => undefined);
      }
      return waku.fetch(request, env, ctx);
    },
  };
  const worker: HypDrivWorker = createWorker({
    config: resolved,
    manifest: wrap.manifest as never,
    app: async () => app,
    ...(stages ? { stages } : {}),
    ...(onError ? { onError } : {}),
    ...(development !== undefined ? { development } : {}),
    ...(devState ? { devState } : {}),
  });

  const handlers: Record<string, unknown> = { ...waku };
  const own = (name: string) =>
    typeof waku[name] === 'function' ? (waku[name] as WorkerHandler) : undefined;
  handlers.fetch = (request: Request, env: HypDrivEnv, ctx: ExecutionContextLike) =>
    isBuildRequest(request, internalPathToBuildStaticFiles)
      ? waku.fetch(request, env, ctx)
      : worker.fetch(request, env, ctx);
  handlers.scheduled = bothHandlers(worker.scheduled, own('scheduled') as never);
  handlers.queue = bothHandlers(worker.queue, own('queue') as never, (batch: { queue: string }) =>
    queueConsumerFor(resolved, batch.queue) ? 'hypdriv' : 'own',
  );
  handlers.email = bothHandlers(worker.email, own('email') as never, () =>
    resolved.jobs.email ? 'hypdriv' : 'own',
  );
  handlers.tail = bothHandlers(worker.tail, own('tail') as never);

  // `fetch` of the entry itself is what Waku's Vite middleware and `INTERNAL_runFetch` call (development, and
  // servers that run the entry outside the Workers runtime): inside workerd it is the same Worker, elsewhere the
  // Drivetrain wraps Waku's fetch directly.
  const fallback = wrapFetch(entry.fetch, handlerFor({ ...wrap, config: resolved }));
  const dev: WakuServerEntry['fetch'] = async (request, ...args) => {
    if (isBuildRequest(request, internalPathToBuildStaticFiles)) return entry.fetch(request, ...args);
    const context = await workersContext();
    if (!context) return fallback(request, ...args);
    return worker.fetch(request, context.env as HypDrivEnv, context.ctx);
  };
  return { ...entry, fetch: dev, defaultExport: handlers };
}
