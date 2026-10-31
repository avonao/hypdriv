/** Build-time options the module hands to the server runtime through the `#hypdriv/options` virtual module. */
export interface NuxtRuntimeOptions {
  /** The deployment target the Nitro preset builds for (unset in development: detected at run time). */
  target?: 'cloudflare' | 'vercel' | 'node';
  /** Public path of Nuxt's build assets (`app.baseURL` + `app.buildAssetsDir`), served without the pipeline. */
  buildAssetsPath: string;
  /** Stamp the request's CSP nonce on the tags Nuxt renders. */
  nonce: boolean;
  /** Use the socket address as the client IP (Node servers without a trusted proxy in front). */
  socketIp: boolean;
}

/** The virtual module id of the runtime options. */
export const VIRTUAL_OPTIONS = '#hypdriv/options';
/** The virtual module id re-exported by the Cloudflare Worker entry (the application's own Worker exports). */
export const VIRTUAL_CLOUDFLARE_EXPORTS = '#hypdriv/cloudflare-exports';
