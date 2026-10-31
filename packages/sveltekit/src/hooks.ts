import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { kit } from 'virtual:hypdriv/sveltekit';
import type { Handle } from '@sveltejs/kit/hooks';
import { building, dev } from '$app/env';
import { createSvelteKitHandle, HANDLER_SLOT, type HypDrivHandleOptions } from './handle';

export type { HypDrivHandleOptions } from './handle';

/**
 * `@hypdriv/sveltekit/hooks` — Hypdriv's SvelteKit `handle`. Add it first in `src/hooks.server.ts`:
 *
 * ```ts
 * import { sequence } from '@sveltejs/kit/hooks';
 * import { hypdriv } from '@hypdriv/sveltekit/hooks';
 *
 * export const handle = sequence(hypdriv(), myHandle);
 * ```
 *
 * It runs the Drivetrain (security headers, CSP, rate limiting, bot shield, geo, flags, i18n, redirects,
 * maintenance, edge cache, Early Hints, logging, `/_hypdriv/*`) around every response SvelteKit renders, makes
 * `hyp()`, `nonce()` and `flag()` work in `load`, actions, endpoints and components, and passes through while
 * SvelteKit prerenders. The config and the build manifest come from the Hypdriv adapter wrapper
 * (`hypdriv(adapter())` from `@hypdriv/sveltekit` in `vite.config.ts`).
 */
export function hypdriv(options: HypDrivHandleOptions = {}): Handle {
  const { handle, handler } = createSvelteKitHandle({
    ...options,
    config,
    manifest,
    csp: kit.csp,
    building: () => building,
    dev: () => dev,
  });
  // Hypdriv's Node server (`@hypdriv/sveltekit/node`) runs this handler around adapter-node's whole handler.
  (globalThis as Record<symbol, unknown>)[HANDLER_SLOT] = handler;
  return handle as unknown as Handle;
}
