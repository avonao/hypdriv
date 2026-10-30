import {
  HEADER,
  type HypDrivConfig,
  type HypDrivEnv,
  type HypManifest,
  type ResolvedConfig,
  type Stage,
  clientIp,
  createContext,
  getCf,
  loadConfig,
  nodeEnvironment,
  runPipeline,
  runWithContext,
} from '@hypdriv/core';
import { registerEdgePurger } from '../cache/index';
import { type CreatePlatformInput, type Platform, buildDefaultStages, createPlatform, stages } from '../stages/index';

export { stages, buildDefaultStages, createPlatform, type Platform } from '../stages/index';

/** Minimal structural types so this module does not import `next/server` at runtime. */
export interface NextRequestLike extends Request {
  nextUrl?: URL;
}
export interface NextFetchEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CreateProxyOptions {
  /** Manifest to use (default: `.hypdriv/manifest.json` from the project dir, read lazily). */
  manifest?: HypManifest | null;
  projectDir?: string;
  env?: HypDrivEnv;
  development?: boolean;
  platform?: CreatePlatformInput['overrides'];
  /** Produces the pass-through response (default: `NextResponse.next({ request: { headers } })`). */
  next?: (request: Request) => Promise<Response>;
}

type StageList = Stage[] | ((defaults: Stage[], platform: Platform) => Stage[]);

/** The recommended `config` export for `proxy.ts`: everything except Next internals and common static files. */
export const matcher = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)', '/_hypdriv/:path*'],
};

async function readManifest(projectDir: string | undefined): Promise<HypManifest | null> {
  try {
    const mod = (await import('@hypdriv/core/node')) as { readManifestSync(dir: string): HypManifest | null; findProjectRoot(start?: string): string };
    return mod.readManifestSync(projectDir ?? process.env.HYPDRIV_PROJECT_DIR ?? mod.findProjectRoot());
  } catch {
    return null;
  }
}

async function defaultNext(request: Request): Promise<Response> {
  const mod = (await import('next/server')) as { NextResponse: { next(init?: { request?: { headers?: Headers } }): Response } };
  return mod.NextResponse.next({ request: { headers: new Headers(request.headers) } });
}

/**
 * Builds the `proxy.ts` handler. Runs the Drivetrain stages on Node (edge-only stages are skipped)
 * and forwards HypDriv headers to the application through `NextResponse.next({ request })`.
 */
export function createProxy(config: HypDrivConfig | ResolvedConfig, stageList?: StageList, options: CreateProxyOptions = {}) {
  const resolved: ResolvedConfig = 'site' in config && 'stages' in config && typeof (config as ResolvedConfig).site?.name === 'string' && Array.isArray((config as ResolvedConfig).stages?.disable) ? (config as ResolvedConfig) : loadConfig(config as HypDrivConfig);
  let ready: Promise<{ platform: Platform; stages: Stage[] }> | null = null;

  const init = async () => {
    const manifest = options.manifest === undefined ? await readManifest(options.projectDir) : options.manifest;
    const env = options.env ?? ((globalThis as { process?: { env?: HypDrivEnv } }).process?.env ?? {});
    const development = options.development ?? nodeEnvironment(env as Record<string, unknown>) === 'development';
    const platform = createPlatform({ config: resolved, manifest, env, runner: 'proxy', development, ...(options.platform ? { overrides: options.platform } : {}) });
    const defaults = buildDefaultStages(platform);
    const list = typeof stageList === 'function' ? stageList(defaults, platform) : (stageList ?? defaults);
    if (platform.edgeCache) registerEdgePurger(platform.edgeCache);
    return { platform, stages: list };
  };

  return async function proxy(request: NextRequestLike, event: NextFetchEventLike): Promise<Response> {
    ready ??= init();
    const { platform, stages: list } = await ready;
    const ctx = createContext({
      request,
      config: platform.config,
      manifest: platform.manifest,
      env: platform.env,
      cf: getCf(request),
      runner: 'proxy',
      development: platform.development,
      waitUntil: (p) => event.waitUntil(p),
      ip: clientIp(request.headers, platform.config.security.trustedProxies),
      log: platform.log,
    });
    ctx.route = platform.matcher.match(ctx.url.pathname);
    ctx.requestHeaders.set(HEADER.runner, 'proxy');
    if (ctx.route) ctx.requestHeaders.set(HEADER.route, ctx.route.route.id);
    ctx.requestHeaders.set('x-hypdriv-pathname', ctx.url.pathname);
    const next = options.next ?? defaultNext;
    const { response } = await runWithContext(ctx, () =>
      runPipeline({
        stages: list,
        ctx,
        skipEdgeOnly: true,
        next,
        onStageError: (error, stage) => {
          platform.log.error('stage failed', { stage: stage.name, error: error.message });
          return 'continue';
        },
      }),
    );
    return response;
  };
}
