/**
 * `@hypdriv/analog` — Hypdriv for Analog, the Angular meta-framework on Vite and Nitro. The Drivetrain (security
 * headers, CSP with nonces and hashes, rate limiting, bot shield, geo, flags, i18n, redirects, maintenance, Early
 * Hints, logging, tracing, Server-Timing, `/_hypdriv/*`) runs around every response of the Nitro server Analog builds
 * (server-rendered pages, prerendered pages, API routes), on Cloudflare Workers, Vercel and Node.
 *
 * ```ts
 * // vite.config.ts
 * import analog from '@analogjs/platform';
 * import { hypdriv, withHypDriv } from '@hypdriv/analog';
 *
 * export default defineConfig(({ mode }) => ({
 *   plugins: [analog(withHypDriv({ ssr: true, prerender: { routes: ['/', '/about'] } })), hypdriv()],
 * }));
 * ```
 *
 * Server code reads the request context from `@hypdriv/analog/server`; the Angular server config adds
 * `provideHypDriv()` from `@hypdriv/analog/angular`.
 */
export {
  type AnalogOptionsLike,
  type HypdrivAnalogOptions,
  hypdrivAnalog,
  type WithHypDriv,
  withHypDriv,
} from './module';
export { type HypdrivAnalogPluginOptions, hypdriv } from './plugin';
export {
  type AnalogPagesOptions,
  analogPageAssets,
  analogRoutePath,
  discoverAnalogPages,
} from './routes';
export { type AnalogViteState, resetViteState, viteState } from './state';
