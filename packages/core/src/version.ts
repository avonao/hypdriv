declare const __HYPDRIV_VERSION__: string | undefined;

/** Package version, injected at build time; `0.0.0-source` when running from source. */
export const HYPDRIV_VERSION: string =
  typeof __HYPDRIV_VERSION__ === 'string' ? __HYPDRIV_VERSION__ : '0.0.0-source';
