import { UPSTREAM_KEY } from '@hypdriv/cache';
import {
  clientIp,
  createContext,
  getCf,
  getCurrentContext,
  HEADER,
  type HypDrivConfig,
  type HypDrivEnv,
  type HypManifest,
  loadConfig,
  nodeEnvironment,
  type ResolvedConfig,
  runPipeline,
  runWithContext,
  type Stage,
  sanitizeInboundRequest,
} from '@hypdriv/core';
import { registerEdgePurger } from '@hypdriv/cache';
import { readManifestFile } from '../shared/manifest-file';
import { buildDefaultStages, type CreatePlatformInput, createPlatform, internalRoutes, type Platform } from '../stages/index';

export { buildDefaultStages, createPlatform, type Platform, stages } from '../stages/index';

/** Minimal structural types so this module does not import `next/server` at runtime. */
export interface NextRequestLike extends Request {
  nextUrl?: URL;
}
export interface NextFetchEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CreateProxyOptions {
  /** Manifest to use (default: `.hypdriv/manifest.json` in the working directory, read once). */
  manifest?: HypManifest | null;
  env?: HypDrivEnv;
  development?: boolean;
  platform?: CreatePlatformInput['overrides'];
  /** Extra state for the DevTools endpoints (default: Purser diagnostics from `.hypdriv/dev/purser.json`). */
  devState?: () => Promise<Record<string, unknown>>;
  /** Produces the pass-through response (default: `NextResponse.next({ request: { headers } })`). */
  next?: (request: Request) => Promise<Response>;
}

type StageList = Stage[] | ((defaults: Stage[], platform: Platform) => Stage[]);

/**
 * The recommended matcher: everything except Next internals and common static files, plus HypDriv's
 * internal routes. Next.js parses `proxy.ts`'s `config` statically, so copy this literal into the file
 * (`export const config = { matcher: [...] }`); re-exporting it is rejected by the compiler.
 * `hypdriv init` writes it for you and `hypdriv doctor` checks it.
 */
export const matcher = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)',
    '/_hypdriv/:path*',
  ],
};

/** Purser's watcher writes its latest result here during `next dev` (statically scoped path). */
async function readDevState(): Promise<Record<string, unknown>> {
  try {
    const proc = (globalThis as { process?: { cwd?: () => string } }).process;
    if (typeof proc?.cwd !== 'function') return {};
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    return { purser: JSON.parse(await readFile(join(proc.cwd(), '.hypdriv', 'dev', 'purser.json'), 'utf8')) as unknown };
  } catch {
    return {};
  }
}

async function defaultNext(request: Request): Promise<Response> {
  const mod = (await import('next/server')) as {
    NextResponse: { next(init?: { request?: { headers?: Headers } }): Response };
  };
  return mod.NextResponse.next({ request: { headers: new Headers(request.headers) } });
}

/**
 * Builds the `proxy.ts` handler. Runs the Drivetrain stages on Node (edge-only stages are skipped)
 * and forwards HypDriv headers to the application through `NextResponse.next({ request })`.
 */
export function createProxy(
  config: HypDrivConfig | ResolvedConfig,
  stageList?: StageList,
  options: CreateProxyOptions = {},
) {
  const resolved: ResolvedConfig =
    'site' in config &&
    'stages' in config &&
    typeof (config as ResolvedConfig).site?.name === 'string' &&
    Array.isArray((config as ResolvedConfig).stages?.disable)
      ? (config as ResolvedConfig)
      : loadConfig(config as HypDrivConfig);
  let ready: Promise<{ platform: Platform; stages: Stage[]; internal: ReturnType<typeof internalRoutes> }> | null = null;

  const init = async () => {
    const manifest =
      options.manifest === undefined ? await readManifestFile(Number.POSITIVE_INFINITY) : options.manifest;
    const env = options.env ?? (globalThis as { process?: { env?: HypDrivEnv } }).process?.env ?? {};
    const development =
      options.development ?? nodeEnvironment(env as Record<string, unknown>) === 'development';
    const platform = createPlatform({
      config: resolved,
      manifest,
      env,
      runner: 'proxy',
      development,
      ...(options.platform ? { overrides: options.platform } : {}),
    });
    const defaults = buildDefaultStages(platform);
    const list = typeof stageList === 'function' ? stageList(defaults, platform) : (stageList ?? defaults);
    if (platform.edgeCache) registerEdgePurger(platform.edgeCache);
    const internal = internalRoutes(platform, {
      devEndpoints: platform.development,
      devState: options.devState ?? readDevState,
    });
    return { platform, stages: list, internal };
  };

  return async function proxy(incoming: NextRequestLike, event: NextFetchEventLike): Promise<Response> {
    const passThrough = options.next ?? defaultNext;
    // Inside the HypDriv Worker (OpenNext runs proxy.ts in the same isolate) the stages already ran around
    // this request; the Worker's context is visible here through AsyncLocalStorage and cannot be spoofed.
    if (getCurrentContext()?.runner === 'worker') return passThrough(incoming);
    ready ??= init();
    const { platform, stages: list, internal } = await ready;
    const request = sanitizeInboundRequest(incoming, {
      nonceHeader: platform.config.security.csp?.nonceHeader ?? HEADER.nonce,
      middlewareHeaders: false,
    });
    const ip = clientIp(request.headers, platform.config.security.trustedProxies);
    // `/_hypdriv/*` (health, vitals, CSP reports, live polling fallback, dev endpoints) on every host.
    const handled = await internal(request, { ip, waitUntil: (p) => event.waitUntil(p) });
    if (handled) return handled;
    const ctx = createContext({
      request,
      config: platform.config,
      manifest: platform.manifest,
      env: platform.env,
      cf: getCf(request),
      runner: 'proxy',
      development: platform.development,
      waitUntil: (p) => event.waitUntil(p),
      ip,
      log: platform.log,
    });
    ctx.route = platform.matcher.match(ctx.url.pathname);
    ctx.requestHeaders.set(HEADER.runner, 'proxy');
    if (ctx.route) ctx.requestHeaders.set(HEADER.route, ctx.route.route.id);
    ctx.requestHeaders.set('x-hypdriv-pathname', ctx.url.pathname);
    // The edge cache revalidates in the background and recovers from upstream errors through this key.
    ctx.state.set(UPSTREAM_KEY, passThrough);
    try {
      const { response } = await runWithContext(ctx, () =>
        runPipeline({
          stages: list,
          ctx,
          skipEdgeOnly: true,
          next: (forwarded) => ctx.state.get(UPSTREAM_KEY)!(forwarded),
          onStageError: (error, stage) => {
            platform.log.error('stage failed', { stage: stage.name, error: error.message });
            return 'continue';
          },
        }),
      );
      return response;
    } catch (err) {
      platform.log.error('request failed', {
        requestId: ctx.id,
        path: ctx.url.pathname,
        error: (err as Error).message,
      });
      const stale = platform.edgeCache?.recover(ctx);
      if (stale) return stale;
      throw err;
    }
  };
}
