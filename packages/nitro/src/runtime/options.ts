/** Build-time options the module hands to the server runtime through the `#hypdriv/options` virtual module. */
export interface NitroRuntimeOptions {
  /** The deployment target the Nitro preset builds for (unset in development: detected at run time). */
  target?: 'cloudflare' | 'vercel' | 'node';
  /** The framework label reported in logs and `/_hypdriv/health` (`nitro`, `analog`). */
  host: string;
  /** Public path prefixes of build assets (`/assets/`, `/_nuxt/`), answered without the pipeline. */
  assetPrefixes: string[];
  /** Hand the request's CSP nonce to the application (`event.context.hypdriv.nonce`). */
  nonce: boolean;
  /** Use the socket address as the client IP (Node servers without a trusted proxy in front). */
  socketIp: boolean;
}

/** The virtual module id of the runtime options. */
export const VIRTUAL_OPTIONS = '#hypdriv/options';
/** The virtual module id re-exported by the Cloudflare Worker entry (the application's own Worker exports). */
export const VIRTUAL_CLOUDFLARE_EXPORTS = '#hypdriv/cloudflare-exports';
