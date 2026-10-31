/**
 * Types of the virtual modules `@hypdriv/sveltekit/hooks` imports. The adapter wrapper (`hypdriv(adapter())`)
 * provides them; applications never import them directly.
 */
/// <reference types="@hypdriv/vite/virtual" />

declare module 'virtual:hypdriv/sveltekit' {
  /** SvelteKit settings the Hypdriv hook needs at run time. */
  export const kit: {
    /** SvelteKit's `csp` option (`directives` as written in `sveltekit({ csp })`), or null when unset. */
    csp: {
      mode?: 'auto' | 'hash' | 'nonce';
      directives?: Record<string, string[] | boolean | undefined>;
    } | null;
  };
}
