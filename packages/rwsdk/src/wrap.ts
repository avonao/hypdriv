import {
  type AppWorkerModule,
  createWorker,
  type ExecutionContextLike,
  type HypDrivWorker,
} from '@hypdriv/cloudflare';
import {
  getCurrentContext,
  HEADER,
  type HypContext,
  type HypDrivConfig,
  type HypDrivEnv,
  type HypManifest,
  isResolvedConfig,
  loadConfig,
  queueConsumerFor,
  type ResolvedConfig,
  type Stage,
} from '@hypdriv/core';
import type { Platform } from '@hypdriv/runtime';
import { appManifest } from './routes';

/**
 * The header `hypdrivMiddleware()` leaves on the response to tell the wrapper it ran (`nonce` when it handed
 * RedwoodSDK a CSP nonce, `none` when the request had none). The wrapper removes it before the response leaves.
 */
export const HANDOFF_HEADER = 'x-hypdriv-rwsdk';

/** What the wrapper needs from a `defineApp` result: its `fetch`, and its route table for the manifest. */
export interface RwsdkApp {
  readonly __rwRoutes?: unknown;
  fetch(request: Request, env: never, ctx: never): Response | Promise<Response>;
}

type WorkerHandler = (...args: never[]) => unknown;

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WrapOptions {
  /** The Hypdriv config (`virtual:hypdriv/config`, a `hypdriv.config.ts` object). */
  config: HypDrivConfig | ResolvedConfig;
  /**
   * The build's manifest (`virtual:hypdriv/manifest`): client assets, build id, CSP data. The routes of the running
   * app replace its route list unless `routes` is `build`.
   */
  manifest: HypManifest;
  /**
   * Where the route manifest comes from: `app` (default) reads the routes `defineApp` registered, so the manifest
   * is exact whatever the build could read from the source; `build` uses the build's manifest as it is.
   */
  routes?: 'app' | 'build';
  /**
   * The static-assets binding answered first for GET/HEAD requests, so public files are served as built when the
   * Worker runs first (`assets.run_worker_first`, which gives them the request stages). `false` sends everything
   * to RedwoodSDK. Default `ASSETS`.
   */
  assets?: string | false;
  stages?: Stage[] | ((defaults: Stage[], platform: Platform) => Stage[]);
  onError?: (error: Error, request: Request, ctx: HypContext | null) => Response | Promise<Response>;
  development?: boolean;
  devState?: () => Promise<Record<string, unknown>>;
}

/** The Worker handlers the wrapper replaces: `fetch` plus the events Hypdriv's jobs use. */
export type HypDrivHandlers = Pick<HypDrivWorker, 'fetch' | 'scheduled' | 'queue' | 'email' | 'tail'>;

/** The wrapped app: everything the app has (`__rwRoutes`, its other handlers) with the Drivetrain's handlers. */
export type HypDrivApp<App> = Omit<App, keyof HypDrivHandlers> & HypDrivHandlers;

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

let warned = false;

function warnMissingMiddleware(message: string): void {
  if (warned) return;
  warned = true;
  const log = getCurrentContext()?.log;
  if (log) log.error(message);
  else console.error(message);
}

/**
 * RedwoodSDK renders its own inline scripts (the RSC payload, the hydration bootstrap) with `rw.nonce`, a nonce it
 * generates per request. The Drivetrain's CSP allows the nonce it issued, so `hypdrivMiddleware()` copies that one
 * into `rw.nonce` as the first route of `defineApp`. Without it the page's scripts carry a nonce the policy does
 * not allow and the browser blocks them: the wrapper reports it (once per isolate) when an HTML response of a
 * request that had a nonce did not pass through the middleware.
 */
function settle(response: Response, nonceIssued: boolean, request: Request): Response {
  const handoff = response.headers.get(HANDOFF_HEADER);
  if (handoff === null) {
    if (nonceIssued && (response.headers.get('content-type') ?? '').includes('text/html'))
      warnMissingMiddleware(
        `hypdriv: ${new URL(request.url).pathname} was rendered without Hypdriv's CSP nonce, so the browser blocks RedwoodSDK's inline scripts. Add hypdrivMiddleware() from '@hypdriv/rwsdk/worker' as the first entry of defineApp([...]).`,
      );
    return response;
  }
  try {
    response.headers.delete(HANDOFF_HEADER);
    return response;
  } catch {
    // An immutable response (a binding's): copy it to drop the header.
    const copy = new Response(response.body, response);
    copy.headers.delete(HANDOFF_HEADER);
    return copy;
  }
}

/**
 * A RedwoodSDK app (`defineApp([...])`) behind Hypdriv's Worker shell. The result is what the Worker exports: its
 * `fetch` runs the full Drivetrain (with `HTMLRewriter`) around everything the Worker receives, then RedwoodSDK;
 * `/_hypdriv/*` is answered by the shell; Durable Object stores are used when bound; `scheduled`, `queue` and
 * `email` take Hypdriv's jobs next to the app's own handlers (Hypdriv's dispatchers take the events configured in
 * `jobs`; the app's handler takes the rest). GET/HEAD requests are answered from the assets binding first. The
 * route manifest is read from the app's own routes.
 */
export function wrapApp<App extends RwsdkApp>(app: App, options: WrapOptions): HypDrivApp<App> {
  const { assets = 'ASSETS', routes = 'app', manifest } = options;
  const resolved = isResolvedConfig(options.config) ? options.config : loadConfig(options.config);
  const nonceHeader = resolved.security.csp?.nonceHeader ?? HEADER.nonce;

  const inner: AppWorkerModule['default'] = {
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
      const response = await (
        app.fetch as (r: Request, e: unknown, c: unknown) => Response | Promise<Response>
      )(request, env, ctx);
      return settle(response, request.headers.has(nonceHeader), request);
    },
  };

  const worker = createWorker({
    config: resolved,
    app: async () => inner,
    manifest: async () => {
      if (routes === 'build') return manifest;
      try {
        return appManifest(app, manifest);
      } catch (error) {
        console.warn(
          `hypdriv: the route table of the app could not be read (${(error as Error).message}); using the build's manifest`,
        );
        return manifest;
      }
    },
    ...(options.stages ? { stages: options.stages } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.development !== undefined ? { development: options.development } : {}),
    ...(options.devState ? { devState: options.devState } : {}),
  });

  const own = (name: string) => {
    const handler = (app as unknown as Record<string, unknown>)[name];
    return typeof handler === 'function' ? (handler as WorkerHandler) : undefined;
  };
  const handlers: HypDrivHandlers = {
    fetch: (request: Request, env: HypDrivEnv, ctx: ExecutionContextLike) => worker.fetch(request, env, ctx),
    scheduled: bothHandlers(worker.scheduled, own('scheduled') as never),
    queue: bothHandlers(worker.queue, own('queue') as never, (batch: { queue: string }) =>
      queueConsumerFor(resolved, batch.queue) ? 'hypdriv' : 'own',
    ),
    email: bothHandlers(worker.email, own('email') as never, () => (resolved.jobs.email ? 'hypdriv' : 'own')),
    tail: bothHandlers(worker.tail, own('tail') as never),
  };
  return { ...app, ...handlers } as HypDrivApp<App>;
}

/** The part of RedwoodSDK's request info the nonce hand-off reads and writes. */
export interface NonceRequestInfo {
  request: Request;
  rw: { nonce: string };
  response: { headers: Headers };
}

/**
 * The route middleware that makes RedwoodSDK render with the CSP nonce the Drivetrain issued. Put it first in
 * `defineApp([...])`:
 *
 * ```tsx
 * export default withHypDriv(defineApp([hypdrivMiddleware(), render(Document, [route('/', Home)])]));
 * ```
 *
 * RedwoodSDK then puts the nonce on its RSC payload and hydration scripts, on the `<script>` tags of your
 * `Document`, and gives it to `requestInfo.rw.nonce` for your own tags.
 */
export function hypdrivMiddleware(): (info: NonceRequestInfo) => void {
  return ({ request, rw, response }) => {
    const ctx = getCurrentContext();
    const header = ctx?.config.security.csp?.nonceHeader ?? HEADER.nonce;
    const nonce = ctx?.requestHeaders.get(header) ?? request.headers.get(header);
    if (nonce) rw.nonce = nonce;
    response.headers.set(HANDOFF_HEADER, nonce ? 'nonce' : 'none');
  };
}
