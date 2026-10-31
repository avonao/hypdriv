/**
 * Types of the virtual modules the HypDriv Astro integration serves. Reference them once in the application when
 * its own code imports them (a custom Cloudflare Worker entry does):
 *
 * ```ts
 * /// <reference types="@hypdriv/astro/virtual" />
 * ```
 */
/// <reference types="@hypdriv/vite/virtual" />

declare module 'virtual:hypdriv/astro' {
  /**
   * `true` only in the bundle Astro builds for build-time prerendering (the `prerender` Vite environment): the
   * HypDriv hooks pass every request through there. Fixed at build time, so no request can switch it.
   */
  export const prerendering: boolean;
  /** `astro dev`. */
  export const development: boolean;
  /** The platform the build targets (from the Astro adapter), or `null` in development. */
  export const target: 'cloudflare' | 'vercel' | 'node' | null;
  /** Astro's own `security.csp` is enabled: Astro owns the Content-Security-Policy, HypDriv's is off. */
  export const astroCsp: boolean;
}
