import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { HEADER } from '@hypdriv/core';
import { createHandler } from '@hypdriv/runtime';
import { getRouteRules } from 'nitro/app';
import options from '#hypdriv/options';
import { prefixSkip } from '../nitro2/hook';
import { installNitro3Hook, type Nitro3AppLike } from './hook';

/**
 * Hypdriv's Nitro 3 runtime plugin (registered first by the `@hypdriv/nitro` module): wraps `nitroApp.fetch`, which
 * every preset entry (Node, Vercel, Cloudflare, the Vite dev server) calls for each request. Never active while
 * Nitro prerenders: `import.meta.prerender` is a build-time constant, so the prerender bundle skips the pipeline and
 * production bundles carry no bypass.
 */
export default function hypdrivNitroPlugin(nitroApp: Nitro3AppLike): void {
  if (import.meta.prerender) return;
  const skip = prefixSkip(options.assetPrefixes);
  const handler = createHandler({
    config,
    manifest,
    host: options.host,
    ...(options.target ? { target: options.target } : {}),
    development: import.meta.dev,
    skip: (url) => skip(url),
    onError: (error, _request, ctx) =>
      new Response(
        JSON.stringify({
          error: 'internal_error',
          requestId: ctx?.id ?? null,
          ...(import.meta.dev ? { message: error.message } : {}),
        }),
        {
          status: 500,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            ...(ctx ? { [HEADER.requestId]: ctx.id } : {}),
          },
        },
      ),
  });
  installNitro3Hook(nitroApp, {
    handler,
    nonce: options.nonce,
    socketIp: options.socketIp,
    cachedRender: (request) => {
      const rules = getRouteRules(request.method, new URL(request.url).pathname) as {
        routeRules?: { cache?: unknown };
      };
      return !!rules.routeRules?.cache;
    },
  });
}
