/// <reference path="../virtual.d.ts" />
import config from 'virtual:hypdriv/config';
import manifest from 'virtual:hypdriv/manifest';
import { type HypDrivApp, type RwsdkApp, type WrapOptions, wrapApp } from './wrap';

export {
  type HypDrivApp,
  type HypDrivHandlers,
  hypdrivMiddleware,
  type NonceRequestInfo,
  type RwsdkApp,
  type WrapOptions,
} from './wrap';

/** The options of `withHypDriv()`: the wrapper's, with the config and the manifest the Vite plugin provides. */
export type HypDrivWorkerOptions = Omit<WrapOptions, 'config' | 'manifest'> &
  Partial<Pick<WrapOptions, 'config' | 'manifest'>>;

/**
 * Puts the Hypdriv Drivetrain in front of a RedwoodSDK app. The Worker's default export is the result:
 *
 * ```tsx
 * // src/worker.tsx
 * import { render, route } from 'rwsdk/router';
 * import { defineApp } from 'rwsdk/worker';
 * import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';
 *
 * export default withHypDriv(
 *   defineApp([hypdrivMiddleware(), render(Document, [route('/', Home), route('/api/ping', ping)])]),
 * );
 * ```
 *
 * Security headers, the nonce CSP, rate limits, the bot shield, geo, flags, redirects, Early Hints, logging,
 * `Server-Timing` and `/_hypdriv/*` run around every request; `scheduled`, `queue` and `email` handlers take
 * Hypdriv's jobs next to your own. The route manifest is read from the app's routes. The result keeps the app's
 * `__rwRoutes`, so `defineLinks<typeof app>()` still types your links.
 */
export function withHypDriv<App extends RwsdkApp>(
  app: App,
  options: HypDrivWorkerOptions = {},
): HypDrivApp<App> {
  return wrapApp(app, { config, manifest, ...options });
}
