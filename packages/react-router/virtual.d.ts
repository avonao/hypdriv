/**
 * Types of the virtual module the HypDriv React Router plugin adds (next to `virtual:hypdriv/config` and
 * `virtual:hypdriv/manifest` from `@hypdriv/vite/virtual`). Reference them once in the application:
 *
 * ```ts
 * /// <reference types="@hypdriv/vite/virtual" />
 * /// <reference types="@hypdriv/react-router/virtual" />
 * ```
 */
declare module 'virtual:hypdriv/react-router' {
  /**
   * The random token of the running build's prerender requests; empty in development and in the built output
   * (the build erases it once prerendering finished).
   */
  export const prerenderToken: string;
}
