/**
 * Types of the virtual modules Hypdriv serves to a SolidStart app's server code (`virtual:hypdriv/config`,
 * `virtual:hypdriv/manifest`). Reference them once in the application when its own code imports them (the Cloudflare
 * Worker entry `src/worker.ts` does):
 *
 * ```ts
 * /// <reference types="@hypdriv/solid-start/virtual" />
 * ```
 */
/// <reference types="@hypdriv/vite/virtual" />

/** What the Hypdriv Nitro module hands to the Nitro runtime plugin (`@hypdriv/solid-start/nitro`). */
declare module 'virtual:hypdriv/solid-start' {
  const options: {
    /** The deployment target the build is for. */
    target: 'cloudflare' | 'vercel' | 'node';
    /** Nitro's development server (`vite dev`). */
    development: boolean;
    /** Public prefixes of content-hashed build assets (`/_build/assets/`); requests under them skip the pipeline. */
    assetPrefixes: string[];
  };
  export default options;
}
