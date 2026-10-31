import type {
  DeployTarget,
  HypDrivConfig,
  HypDrivEnv,
  HypManifest,
  ResolvedConfig,
  Stage,
} from '@hypdriv/core';
import { type CreatePlatformInput, createProxyHandler, type Platform } from '@hypdriv/runtime';

export { buildDefaultStages, createPlatform, type Platform, stages } from '@hypdriv/runtime';

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
 * The recommended matcher: everything except Next internals and common static files, plus Hypdriv's
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

async function defaultNext(request: Request): Promise<Response> {
  const mod = (await import('next/server')) as {
    NextResponse: { next(init?: { request?: { headers?: Headers } }): Response };
  };
  return mod.NextResponse.next({ request: { headers: new Headers(request.headers) } });
}

/**
 * Builds the `proxy.ts` handler. Runs the Drivetrain stages on Node (edge-only stages are skipped)
 * and forwards Hypdriv headers to the application through `NextResponse.next({ request })`.
 */
export function createProxy(
  config: HypDrivConfig | ResolvedConfig,
  stageList?: StageList,
  options: CreateProxyOptions = {},
): (request: NextRequestLike, event: NextFetchEventLike) => Promise<Response> {
  return createProxyHandler(config, stageList, { ...options, next: options.next ?? defaultNext });
}
