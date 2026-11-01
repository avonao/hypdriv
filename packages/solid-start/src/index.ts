/**
 * `@hypdriv/solid-start` — Hypdriv for SolidStart 2 on the server. The Vite plugin (`@hypdriv/solid-start/vite`)
 * wires the Drivetrain into the deployment: a Nitro runtime plugin on Node and Vercel, the Worker shell
 * (`@hypdriv/solid-start/cloudflare`) on Cloudflare. This entry holds what the application imports:
 *
 * ```tsx
 * // src/entry-server.tsx
 * import { hypdrivStart } from '@hypdriv/solid-start';
 * export default createHandler(() => <StartServer document={…} />, hypdrivStart());
 * ```
 *
 * Request helpers for API routes, server functions and middleware are in `@hypdriv/solid-start/server`.
 */
export { HOST_LABEL } from './constants';
export { carryPlatformFacts, nativeRequest, type PlatformRequest, platformInput } from './entry';
export {
  type FetchHookOptions,
  installFetchHook,
  isPrivateBuildPath,
  type NitroAppLike,
  solidSkip,
} from './nitro-hook';
export { hypdrivStart, type StartRenderOptions } from './start';
