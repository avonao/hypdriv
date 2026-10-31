import { registerEdgePurger, UPSTREAM_KEY } from '@hypdriv/cache';
import {
  clientIp,
  createContext,
  type DeployTarget,
  detectDeployTarget,
  type GeoProperties,
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
import { platformFor, type StageList } from './handler';
import { readManifestFile } from './shared/manifest-file';
import { geoFrom } from './stages/geo';
import {
  buildDefaultStages,
  type CreatePlatformInput,
  httpsUpgrade,
  internalRoutes,
  type Platform,
} from './stages/index';

/** Minimal structural types of a routing-middleware request and event. */
export interface ProxyRequestLike extends Request {
  nextUrl?: URL;
}
export interface ProxyEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CreateProxyHandlerOptions {
  /** Manifest to use (default: `.hypdriv/manifest.json` in the working directory, read once). */
  manifest?: HypManifest | null;
  env?: HypDrivEnv;
  development?: boolean;
  platform?: CreatePlatformInput['overrides'];
  /** Extra state for the DevTools endpoints (default: Purser diagnostics from `.hypdriv/dev/purser.json`). */
  devState?: () => Promise<Record<string, unknown>>;
  /**
   * Produces the pass-through response that lets the request continue to the application with the forwarded
   * request headers (Next.js: `NextResponse.next({ request })`; Vercel Routing Middleware: `x-middleware-next`).
   */
  next: (request: Request) => Promise<Response>;
  /**
   * Deployment target (default: the config's `platform`, else detected — `VERCEL=1` → `vercel`). On Vercel the
   * runner wires `@hypdriv/vercel` automatically: Upstash/Global Config bindings, Vercel CDN cache headers in
   * place of the edge-cache stage, tag purges through Vercel, WAF rate-limit rules. `options.platform`
   * overrides still win.
   */
  target?: DeployTarget;
}

/** Purser's watcher writes its latest result here during development (statically scoped path). */
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

/**
 * The routing-middleware runner shared by Next.js `proxy.ts` and Vercel Routing Middleware: runs the Drivetrain
 * before the application without seeing its rendered body (edge-only stages are skipped) and forwards HypDriv's
 * headers through `options.next`.
 */
export function createProxyHandler(
  config: HypDrivConfig | ResolvedConfig,
  stageList: StageList | undefined,
  options: CreateProxyHandlerOptions,
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
    const assembled = await platformFor({
      config: resolved,
      manifest,
      env,
      runner: 'proxy',
      target,
      development,
      overrides: options.platform,
    });
    const { platform, adapt, purger } = assembled;
    env = assembled.env;
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

  return async function proxy(incoming: ProxyRequestLike, event: ProxyEventLike): Promise<Response> {
    const passThrough = options.next;
    // Inside the HypDriv Worker (OpenNext runs proxy.ts in the same isolate) the stages already ran around
    // this request; the Worker's context is visible here through AsyncLocalStorage and cannot be spoofed.
    if (getCurrentContext()?.runner === 'worker') return passThrough(incoming);
    ready ??= init();
    const { platform, stages: list, internal } = await ready;
    const request = sanitizeInboundRequest(incoming, {
      nonceHeader: platform.config.security.csp?.nonceHeader ?? HEADER.nonce,
      middlewareHeaders: false,
    });
    // `forceHttps` also covers the internal routes answered below, before the redirects stage runs.
    const upgrade = httpsUpgrade(platform.config, request, { development: platform.development });
    if (upgrade) return upgrade;
    const ip = clientIp(request.headers, platform.config.security.trustedProxies);
    // `/_hypdriv/*` (health, vitals, CSP reports, live polling fallback, dev endpoints) on every host.
    // The visitor's country for vitals and reports: Cloudflare's `cf`, else the edge headers Vercel and other
    // CDNs set (x-vercel-ip-country, cf-ipcountry).
    const country = geoFrom(getCf(request) as GeoProperties | undefined, request.headers).country;
    const handled = await internal(request, {
      ip,
      ...(country ? { country } : {}),
      waitUntil: (p) => event.waitUntil(p),
    });
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
