/**
 * Types of HypDriv's virtual modules. Reference them once in the application:
 *
 * ```ts
 * /// <reference types="@hypdriv/vite/virtual" />
 * ```
 */
declare module 'virtual:hypdriv/config' {
  import type { HypDrivConfig } from '@hypdriv/core';

  /** The application's `hypdriv.config.ts` (or the inline config passed to the plugin). */
  const config: HypDrivConfig;
  export default config;
}

declare module 'virtual:hypdriv/manifest' {
  import type { HypManifest } from '@hypdriv/core';

  /** The build manifest (routes, CSP hashes, Early Hints); an empty manifest in development. */
  const manifest: HypManifest;
  export default manifest;
}
