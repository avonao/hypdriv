/**
 * `@hypdriv/solid-start/nitro` — the Nitro runtime plugin the Hypdriv Nitro module registers (the Vite plugin
 * `hypdriv()` of `@hypdriv/solid-start/vite` does it; nothing to import by hand). Nitro bundles it into the server
 * (Node, Vercel, a Nitro-built Cloudflare Worker) and runs it before SolidStart's H3 app handles anything: it wraps
 * `nitroApp.fetch` with the Hypdriv Drivetrain.
 *
 * It never runs while Nitro prerenders at build time: the module skips Nitro's prerender build, so prerendered
 * documents carry no per-request nonce, request id or flag.
 */
import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import options from 'virtual:hypdriv/solid-start';
import { HEADER } from '@hypdriv/core';
import { createHandler } from '@hypdriv/runtime';
import { HOST_LABEL } from './constants';
import { installFetchHook, type NitroAppLike, solidSkip } from './nitro-hook';

export default function hypdrivNitroPlugin(nitroApp: NitroAppLike): void {
  const handler = createHandler({
    config,
    manifest,
    host: HOST_LABEL,
    target: options.target,
    development: options.development,
    skip: solidSkip(options.assetPrefixes),
    onError: (error, _request, ctx) =>
      new Response(
        JSON.stringify({
          error: 'internal_error',
          requestId: ctx?.id ?? null,
          ...(options.development ? { message: error.message } : {}),
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
  installFetchHook(nitroApp, { handler });
}
