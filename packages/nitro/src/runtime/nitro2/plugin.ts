import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { HEADER } from '@hypdriv/core';
import { createHandler } from '@hypdriv/runtime';
import { createError, type H3Event, isError, readRawBody, setResponseStatus } from 'h3';
import { getRouteRules } from 'nitropack/runtime';
import type { NitroApp } from 'nitropack/types';
import options from '#hypdriv/options';
import { type H3ErrorLike, installNitroHook, type NitroAppLike, prefixSkip } from './hook';
import type { H3EventLike } from './request';

/**
 * Hypdriv's Nitro 2 plugin (registered by the `@hypdriv/nitro` module): wraps Nitro's h3 app handler so every
 * request runs through the Hypdriv pipeline. Never active while Nitro prerenders: `import.meta.prerender` is a
 * build-time constant, so the prerender bundle skips the pipeline and production bundles carry no bypass.
 */
export default function hypdrivNitroPlugin(nitroApp: NitroApp): void {
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
  installNitroHook(nitroApp as unknown as NitroAppLike, {
    handler,
    skip,
    nonce: options.nonce,
    socketIp: options.socketIp,
    readRawBody: async (event) => {
      const body = await readRawBody(event as unknown as H3Event, false);
      return body ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : undefined;
    },
    // The same normalisation h3's Node listener applies before calling the app's `onError`.
    normalizeError: (thrown, event: H3EventLike) => {
      const error = createError(thrown as Error) as H3ErrorLike;
      if (!isError(thrown)) error.unhandled = true;
      setResponseStatus(event as unknown as H3Event, error.statusCode, error.statusMessage);
      return error;
    },
    cachedRender: (event) => {
      const rules = getRouteRules(event as unknown as H3Event) as { cache?: unknown };
      return !!rules.cache;
    },
  });
}
