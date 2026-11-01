import {
  type AppWorkerModule,
  createWorker,
  type ExecutionContextLike,
  type HypDrivWorker,
} from '@hypdriv/cloudflare';
import { isResolvedConfig, loadConfig, queueConsumerFor } from '@hypdriv/core';
import { clientConnFor, type HypDrivRuntimeOptions, type WrapOptions } from './entry';
import {
  createQwikFetch,
  errorResponse,
  isStaticPath,
  notFoundResponse,
  type QwikFetchOptions,
} from './fetch';

/** A Worker event handler Hypdriv and the application both handle (`scheduled`, `queue`, `email`, `tail`). */
type WorkerHandler = (...args: never[]) => unknown;

/** The Worker handlers of the application, next to the ones Hypdriv provides for its jobs. */
export interface HypDrivWorkerHandlers {
  scheduled?: WorkerHandler;
  queue?: WorkerHandler;
  email?: WorkerHandler;
  tail?: WorkerHandler;
}

/** Hypdriv's options in the Cloudflare entry (`createQwikRouter({ render, hypdriv: { … } })`). */
export interface HypDrivCloudflareOptions extends HypDrivRuntimeOptions {
  /**
   * The static-assets binding answered for Qwik's static paths (`/build/*`, `/assets/*`, prerendered pages, public
   * files), as in Qwik's own Cloudflare adapter. `false` serves nothing from assets. Default `ASSETS`.
   */
  assets?: string | false;
  /**
   * The application's own Worker event handlers, which run next to Hypdriv's `scheduled`, `queue`, `email` and
   * `tail` dispatchers (Hypdriv's take the events configured in `jobs`; the application's take the rest).
   */
  handlers?: HypDrivWorkerHandlers;
}

export interface QwikRouterCloudflareOptions extends QwikFetchOptions {
  /**
   * Qwik's shared cache: cacheable `GET` responses of the application (`Cache-Control` without `private`,
   * `no-store` or `no-cache`, no cookies) are kept in the Cache API (`caches.open('custom:qwikrouter')`), exactly as
   * Qwik's own Cloudflare adapter does. Default true. Hypdriv's edge cache policies (`cache` in `hypdriv.config.ts`)
   * are the purgeable alternative: set this to `false` when they cache the same routes.
   */
  cache?: boolean;
  hypdriv?: HypDrivCloudflareOptions;
}

/** The Worker module a Cloudflare entry exports: `fetch` plus Hypdriv's `scheduled`, `queue`, `email` and `tail`. */
export type HypDrivQwikWorker = HypDrivWorker & { [handler: string]: unknown };

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

const uncacheableDirectives = new Set(['private', 'no-store', 'no-cache']);

/** Qwik's rule for the Cache API: `Cache-Control` present, no `Set-Cookie`, no private/no-store/no-cache. */
export function isSharedCacheable(response: Response): boolean {
  const cacheControl = response.headers.get('cache-control');
  if (!cacheControl || response.headers.has('set-cookie')) return false;
  return !cacheControl.split(',').some((value) => {
    const directive = value.trim().split('=', 1)[0]?.toLowerCase() ?? '';
    return uncacheableDirectives.has(directive);
  });
}

/**
 * A Worker event Hypdriv and the application both handle: Hypdriv's dispatcher first, then the application's own
 * handler; a failure of either is raised after both ran.
 */
export function bothHandlers<A extends unknown[]>(
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
 * Qwik Router's Cloudflare request handler behind Hypdriv's Worker shell (`createQwikRouter` of
 * `@hypdriv/qwik/middleware/cloudflare` with the plugin's config and manifest passed in).
 */
export function wrapCloudflare(
  qwik: QwikFetchOptions,
  useQwikCache: boolean,
  options: WrapOptions & Pick<HypDrivCloudflareOptions, 'assets' | 'handlers'>,
): HypDrivQwikWorker {
  const { assets = 'ASSETS', handlers: own = {}, ...wrap } = options;
  const resolved = isResolvedConfig(wrap.config) ? wrap.config : loadConfig(wrap.config);
  const { stages, onError, development, devState } = wrap;
  const qwikFetch = createQwikFetch(qwik);

  const app: AppWorkerModule['default'] = {
    async fetch(request: Request, env: unknown, ctx: ExecutionContextLike) {
      try {
        const bindings = (env ?? {}) as Record<string, unknown>;
        const url = new URL(request.url);
        if (isStaticPath(request.method, url)) {
          const binding = assets === false ? undefined : (bindings[assets] as AssetsBinding | undefined);
          if (binding && typeof binding.fetch === 'function') return await binding.fetch(request);
          return notFoundResponse(request);
        }
        const cacheable =
          useQwikCache &&
          url.hostname !== '127.0.0.1' &&
          url.hostname !== 'localhost' &&
          url.port === '' &&
          request.method === 'GET' &&
          !request.headers.has('cookie') &&
          !request.headers.has('authorization');
        const cache =
          cacheable && typeof caches !== 'undefined' ? await caches.open('custom:qwikrouter') : null;
        const cacheKey = cache ? new Request(url.href, request) : null;
        if (cache && cacheKey) {
          const cached = await cache.match(cacheKey);
          if (cached) return cached;
        }
        const response = await qwikFetch(request, {
          env: (key) => bindings[key] as string | undefined,
          platform: { request, env, ctx },
          clientConn: (req) => clientConnFor(req, { ip: 'cf-connecting-ip', country: 'cf-ipcountry' }),
        });
        if (!response) return notFoundResponse(request);
        if (cache && cacheKey && response.ok && isSharedCacheable(response))
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (error) {
        return errorResponse(error, 'cloudflare');
      }
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

  const module: HypDrivQwikWorker = {
    fetch: worker.fetch,
    scheduled: bothHandlers(worker.scheduled, own.scheduled as never),
    queue: bothHandlers(worker.queue, own.queue as never, (batch: { queue: string }) =>
      queueConsumerFor(resolved, batch.queue) ? 'hypdriv' : 'own',
    ),
    email: bothHandlers(worker.email, own.email as never, () => (resolved.jobs.email ? 'hypdriv' : 'own')),
    tail: bothHandlers(worker.tail, own.tail as never),
  };
  return module;
}
