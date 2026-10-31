import { getCurrentContext, type HypDrivConfig, type HypManifest, type ResolvedConfig } from '@hypdriv/core';
import {
  type CreateProxyHandlerOptions,
  createProxyHandler,
  type ProxyEventLike,
  type ProxyRequestLike,
  type StageList,
} from '@hypdriv/runtime';
import { NextResponse } from 'vinext/shims/server';
import { isBuildPrerender } from './runtime';

/**
 * `@hypdriv/vinext/proxy` — HypDriv as vinext routing middleware (`proxy.ts`), for apps the plugin's request
 * hook cannot wrap: Pages Router apps served by `vinext start` or Nitro. The Drivetrain runs before vinext
 * (`runner: 'proxy'`): security headers, CSP (vinext applies the nonce to its scripts from the forwarded
 * policy), rate limiting, the bot shield, geo, flags, redirects, maintenance, `/_hypdriv/*`. It does not see
 * the rendered body, so edge-only stages (HTML rewriting, nonce injection into cached HTML) are skipped and
 * application code reads HypDriv's facts from the forwarded `x-hypdriv-*` request headers.
 *
 * Inside the plugin's request hook or HypDriv's Worker shell (App Router apps) the proxy passes through.
 *
 * ```ts
 * // proxy.ts
 * import hypdrivConfig from 'virtual:hypdriv/config';
 * import manifest from 'virtual:hypdriv/manifest';
 * import { createProxy } from '@hypdriv/vinext/proxy';
 * export const proxy = createProxy({ config: hypdrivConfig, manifest });
 * export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
 * ```
 */

export interface CreateVinextProxyOptions extends Omit<CreateProxyHandlerOptions, 'next' | 'manifest'> {
  config: HypDrivConfig | ResolvedConfig;
  /** The manifest (`virtual:hypdriv/manifest`); there is no file system to read it from on Workers. */
  manifest: HypManifest | null;
  /** Customise the stage list. */
  stages?: StageList;
}

/** Continues to vinext with the request headers the stages forwarded. */
export function continueWith(request: Request): Promise<Response> {
  return Promise.resolve(NextResponse.next({ request: { headers: new Headers(request.headers) } }));
}

/** Builds the `proxy.ts` handler. */
export function createProxy(
  options: CreateVinextProxyOptions,
): (request: ProxyRequestLike, event: ProxyEventLike) => Promise<Response> {
  const { config, stages, ...rest } = options;
  const handler = createProxyHandler(config, stages, { ...rest, next: continueWith });
  return async (request, event) => {
    // The plugin's request hook (`host`) or the Worker shell (`worker`) already ran the stages.
    const runner = getCurrentContext()?.runner;
    if (runner === 'host' || runner === 'worker') return NextResponse.next();
    // vinext runs proxy.ts during its build-time prerender; HypDriv's posture applies at run time.
    if (isBuildPrerender()) return NextResponse.next();
    return handler(request, event);
  };
}
