import { isStaticRequest } from '@hypdriv/runtime';

/**
 * Nuxt runs on Nitro 2, so the hook that wraps Nitro's h3 app (`createNitroHandler`, `installNitroHook`, the request
 * facts) is the engine in `@hypdriv/nitro`, shared with every Nitro-based host. Only the request-path predicate is
 * Nuxt's own.
 */
export * from '@hypdriv/nitro/runtime/nitro2/hook';

/** The request-path predicate for Nuxt: build assets and media, plus everything under `buildAssetsDir`. */
export function nuxtSkip(buildAssetsPath = '/_nuxt/'): (url: URL) => boolean {
  const prefix = buildAssetsPath.endsWith('/') ? buildAssetsPath : `${buildAssetsPath}/`;
  return (url) => url.pathname.startsWith(prefix) || isStaticRequest(url);
}
