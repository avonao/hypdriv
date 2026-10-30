import { type EdgePurger, registerEdgePurger, UPSTREAM_KEY } from '@hypdriv/cache';
import {
  clientIp,
  createContext,
  type DeployTarget,
  detectDeployTarget,
  getCf,
  getCurrentContext,
  HEADER,
  type HypDrivConfig,
  type HypDrivEnv,
  type HypManifest,
  isResolvedConfig,
  loadConfig,
  nodeEnvironment,
  type ResolvedConfig,
  registerRuntime,
  runPipeline,
  runWithContext,
  type Stage,
  sanitizeInboundRequest,
} from '@hypdriv/core';
import { readManifestFile } from '../shared/manifest-file';
import {
  buildDefaultStages,
  type CreatePlatformInput,
  createPlatform,
  internalRoutes,
  type Platform,
} from '../stages/index';

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
  /**
   * Deployment target (default: the config's `platform`, else detected — `VERCEL=1` → `vercel`). On Vercel the
   * proxy wires `@hypdriv/vercel` automatically: Upstash/Global Config bindings, Vercel CDN cache headers in
   * place of the edge-cache stage, tag purges through Vercel, WAF rate-limit rules. `options.platform`
   * overrides still win.
   */
  target?: DeployTarget;
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
    return {
      purser: JSON.parse(
        await readFile(join(proc.cwd(), '.hypdriv', 'dev', 'purser.json'), 'utf8'),
      ) as unknown,
    };
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
  const resolved: ResolvedConfig = isResolvedConfig(config) ? config : loadConfig(config);
  let ready: Promise<{
    platform: Platform;
    stages: Stage[];
    internal: ReturnType<typeof internalRoutes>;
  }> | null = null;

  const init = async () => {
    const manifest =
      options.manifest === undefined ? await readManifestFile(Number.POSITIVE_INFINITY) : options.manifest;
    let env: HypDrivEnv =
      options.env ?? (globalThis as { process?: { env?: HypDrivEnv } }).process?.env ?? {};
    const development =
      options.development ?? nodeEnvironment(env as Record<string, unknown>) === 'development';
    const target = options.target ?? detectDeployTarget(env as Record<string, unknown>, resolved.platform);
    let overrides: CreatePlatformInput['overrides'] | undefined = options.platform;
    let adapt: ((defaults: Stage[]) => Stage[]) | null = null;
    let purger: EdgePurger | null = null;
    if (target === 'vercel') {
      const vercel = await import('@hypdriv/vercel');
      env = vercel.vercelEnv(resolved, env as Record<string, unknown>) as HypDrivEnv;
      const { edgePurger, ...platformOverrides } = vercel.vercelPlatformOverrides(
        resolved,
        env as Record<string, unknown>,
      );
      overrides = { ...platformOverrides, ...(options.platform ?? {}) };
      purger = edgePurger;
      adapt = vercel.vercelStages(resolved);
    }
    const platform = createPlatform({
      config: resolved,
      manifest,
      env,
      runner: 'proxy',
      development,
      ...(overrides ? { overrides } : {}),
    });
    const defaults = adapt ? adapt(buildDefaultStages(platform)) : buildDefaultStages(platform);
    const list = typeof stageList === 'function' ? stageList(defaults, platform) : (stageList ?? defaults);
    registerRuntime({ config: platform.config, env, target });
    // `revalidateTag()` / `purgeEdge()` purge what actually caches responses: Vercel's CDN, or the edge cache.
    if (purger) registerEdgePurger(purger);
    else if (platform.edgeCache) registerEdgePurger(platform.edgeCache);
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
