import { defineNuxtPlugin } from 'nuxt/app';
import { FACTS_KEY, type HypEventContext } from './facts';

/** `<link>` relations that fetch subresources under `script-src` / `style-src` and take a nonce. */
const NONCED_LINK = /(?:^|\s)(?:modulepreload|preload|stylesheet)(?:\s|$)/i;

/**
 * Stamps the request's CSP nonce (HypDriv's, from `event.context.hypdriv`) on every `<script>`, `<style>` and
 * script/style `<link>` Nuxt renders through unhead — the import map, the `__NUXT__` config, the payload, the
 * streaming bootstrap and suspense chunks included, in buffered and streaming rendering alike. In development it
 * also renders the `csp-nonce` meta tag Vite's client reads for the `<style>` elements it injects.
 *
 * The pipeline's own injection (idempotent) covers anything rendered outside unhead.
 */
export default defineNuxtPlugin({
  name: 'hypdriv:nonce',
  enforce: 'pre',
  setup(nuxtApp) {
    const ssr = nuxtApp.ssrContext;
    const facts = ssr?.event?.context?.[FACTS_KEY] as HypEventContext | undefined;
    const nonce = facts?.nonce;
    if (!ssr || !nonce) return;
    ssr.head.hooks?.hook('tags:afterResolve', ({ tags }) => {
      for (const tag of tags) {
        if (
          tag.tag === 'script' ||
          tag.tag === 'style' ||
          (tag.tag === 'link' && NONCED_LINK.test(String(tag.props.rel ?? '')))
        )
          tag.props.nonce = nonce;
      }
    });
    // Vite's dev client reads the `nonce` of `meta[property=csp-nonce]` (unhead renders a meta with content only).
    if (import.meta.dev)
      ssr.head.push({ meta: [{ property: 'csp-nonce', content: 'nonce', nonce } as never] });
  },
});
