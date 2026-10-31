/**
 * Request header that marks TanStack Start's build-time prerender requests. `withHypDriv()` adds it, with a random
 * per-build token, to every prerender request; the build removes the token from the server output once
 * prerendering finished, so a deployed server never honours it.
 */
export const PRERENDER_HEADER = 'x-hypdriv-prerender';

/** The virtual module that carries the per-build prerender token into the server bundle. */
export const VIRTUAL_START = 'virtual:hypdriv/tanstack-start';

/** Minimum length of a valid prerender token (an emptied token disables the prerender bypass). */
export const MIN_TOKEN_LENGTH = 32;

/** The framework label HypDriv reports in logs, `/_hypdriv/health` and the manifest. */
export const HOST_LABEL = 'tanstack-start';
